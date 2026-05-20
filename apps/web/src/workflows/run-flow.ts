/**
 * Durable run workflow — Vercel Workflow Devkit (WDK).
 *
 * Lifecycle:
 *   loadRunContext          → resolve flow + site + decrypt cookies
 *   createBuSession         → BU Cloud session w/ profile attached
 *   streamReplay            → drive Python replay-worker, persist step results
 *   ┌─ if paused_auth:
 *   │   markPausedAuth      → DB status update + SSE
 *   │   await authHook      → suspend until /api/cookies/refresh resumes us
 *   │   (or 24h timeout)    → race the hook with sleep('24h')
 *   │   onAuthRefreshed     → mark run queued, emit run_resumed (Phase 4 will
 *   │                         restart from the failing step; Phase 3.5a re-queues)
 *   └─ else:
 *       stopBuSession       → release the BU Cloud session (refunds unused mins)
 *       persistRunSummary   → final status + SSE run_complete
 *
 * Hook token: `run:${runId}:auth-refreshed`. The /api/cookies/refresh route
 * calls `resumeHook(token, { refreshed: true })` after fresh cookies have
 * been encrypted, persisted, and pushed to the BU Cloud profile.
 */
import { eq } from 'drizzle-orm';
import { createHook, sleep, FatalError } from 'workflow';
import {
	createReplayWorkerClient,
	type ReplayWorkerEvent,
	type WorkerStepResult,
} from '@flowlens/replay-engine';
import { createBuClient } from '@flowlens/bu-cloud-client';
import { openForOrg } from '@flowlens/cookies-vault';
import type { FlowStep } from '@flowlens/schema';
import { db } from '@/lib/db';
import { flows, runs, stepResults, cookieSnapshots, sites } from '@flowlens/schema/db';
import { emitSseEvent } from '@/lib/sse-bus';

export interface RunFlowInput {
	runId: string;
	flowId: string;
	orgId: string;
	mode: 'hybrid' | 'fast' | 'full_llm';
}

interface LoadedRunContext {
	flowName: string;
	siteOrigin: string;
	steps: FlowStep[];
	sensitiveData: Record<string, string>;
	buProfileId: string | null;
}

interface BuSessionInfo {
	sessionId: string;
	cdpUrl: string;
	liveUrl: string | null;
}

interface ReplayOutcome {
	runStatus: 'passed' | 'failed' | 'errored' | 'paused';
	healthScore: number;
	summary: string;
	pauseEvent: { hint: string; blockedAtStepIndex: number } | null;
}

// ─── Steps ─────────────────────────────────────────────────────────────────

async function loadRunContextStep(input: {
	flowId: string;
	orgId: string;
}): Promise<LoadedRunContext> {
	'use step';
	const flow = await db.query.flows.findFirst({ where: eq(flows.id, input.flowId) });
	if (!flow) throw new FatalError(`flow ${input.flowId} disappeared`);
	const site = await db.query.sites.findFirst({ where: eq(sites.id, flow.siteId) });
	if (!site) throw new FatalError(`site ${flow.siteId} disappeared`);

	const sensitiveData: Record<string, string> = {};
	if (flow.cookieSnapshotId && process.env.FLOWLENS_VAULT_SECRET) {
		const snap = await db.query.cookieSnapshots.findFirst({
			where: eq(cookieSnapshots.id, flow.cookieSnapshotId),
		});
		if (snap) {
			try {
				const plaintext = await openForOrg({
					orgId: input.orgId,
					vaultSecret: process.env.FLOWLENS_VAULT_SECRET,
					sealed: { ciphertext: snap.ciphertext, nonce: snap.nonce },
				});
				const parsed = JSON.parse(plaintext) as {
					cookies?: { name: string; value: string }[];
				};
				for (const c of parsed.cookies ?? []) sensitiveData[c.name] = c.value;
			} catch (err) {
				console.warn('[run-workflow] vault decrypt failed', err);
			}
		}
	}

	return {
		flowName: flow.name,
		siteOrigin: site.origin,
		steps: (flow.steps as FlowStep[]) ?? [],
		sensitiveData,
		buProfileId: flow.buProfileId,
	};
}

async function createBuSessionStep(input: {
	runId: string;
	buProfileId: string | null;
}): Promise<BuSessionInfo> {
	'use step';
	const bu = createBuClient();
	const created = await bu.createBrowserSession({
		profileId: input.buProfileId,
		keepAlive: true,
	});
	if (!created.cdpUrl) {
		throw new Error('BU Cloud did not return cdpUrl');
	}
	await db
		.update(runs)
		.set({
			buSessionId: created.id,
			buCdpUrl: created.cdpUrl,
			liveUrl: created.liveUrl,
			status: 'running',
			startedAt: new Date(),
		})
		.where(eq(runs.id, input.runId));
	await emitSseEvent(`run:${input.runId}`, {
		type: 'run_started',
		runId: input.runId,
		liveUrl: created.liveUrl,
	});
	return { sessionId: created.id, cdpUrl: created.cdpUrl, liveUrl: created.liveUrl };
}

async function streamReplayStep(input: {
	runId: string;
	flowId: string;
	flowName: string;
	siteOrigin: string;
	steps: FlowStep[];
	cdpUrl: string;
	mode: 'hybrid' | 'fast' | 'full_llm';
	sensitiveData: Record<string, string>;
}): Promise<ReplayOutcome> {
	'use step';
	const worker = createReplayWorkerClient();
	const recordedScreenshotsByIndex: Record<string, string> = {};
	const base = process.env.BLOB_PUBLIC_BASE_URL;
	if (base) {
		for (const s of input.steps) {
			if (s.recordedScreenshotKey) {
				recordedScreenshotsByIndex[String(s.index)] = `${base}/${s.recordedScreenshotKey}`;
			}
		}
	}

	let healthScore = 100;
	let summary = '';
	let runStatus: ReplayOutcome['runStatus'] = 'passed';
	let pauseEvent: ReplayOutcome['pauseEvent'] = null;

	const stream = worker.streamRun({
		runId: input.runId,
		flow: {
			id: input.flowId,
			name: input.flowName,
			siteOrigin: input.siteOrigin,
			steps: input.steps,
		},
		cdpUrl: input.cdpUrl,
		mode: { name: input.mode },
		recordedScreenshotsByIndex,
		sensitiveData: input.sensitiveData,
	});

	for await (const event of stream as AsyncGenerator<ReplayWorkerEvent>) {
		if (event.type === 'step_started') {
			await emitSseEvent(`run:${input.runId}`, event);
		} else if (event.type === 'step_finished') {
			await persistStepResult(input.runId, event.result);
			await emitSseEvent(`run:${input.runId}`, event);
		} else if (event.type === 'run_paused') {
			pauseEvent = { hint: event.hint, blockedAtStepIndex: event.blockedAtStepIndex };
			runStatus = 'paused';
			await emitSseEvent(`run:${input.runId}`, event);
			break;
		} else if (event.type === 'run_complete') {
			runStatus = event.status;
			healthScore = event.healthScore;
			summary = event.summary;
		}
	}

	return { runStatus, healthScore, summary, pauseEvent };
}

async function markPausedAuthStep(input: {
	runId: string;
	hint: string;
}): Promise<void> {
	'use step';
	await db
		.update(runs)
		.set({ status: 'paused_auth', summary: `paused: ${input.hint}` })
		.where(eq(runs.id, input.runId));
	await emitSseEvent(`run:${input.runId}`, {
		type: 'run_paused',
		runId: input.runId,
		reason: 'auth',
		hint: input.hint,
	});
}

async function markAuthTimeoutStep(runId: string): Promise<void> {
	'use step';
	await db
		.update(runs)
		.set({
			status: 'errored',
			finishedAt: new Date(),
			summary: 'Auth refresh timed out (24h).',
			errorClass: 'auth',
		})
		.where(eq(runs.id, runId));
	await emitSseEvent(`run:${runId}`, {
		type: 'run_complete',
		runId,
		status: 'errored',
		healthScore: 0,
	});
}

async function markRequeueAfterAuthStep(runId: string): Promise<void> {
	'use step';
	await db
		.update(runs)
		.set({ status: 'queued', summary: 'Auth refreshed — re-queue to resume.' })
		.where(eq(runs.id, runId));
	await emitSseEvent(`run:${runId}`, { type: 'run_resumed', runId });
}

async function stopBuSessionStep(sessionId: string): Promise<void> {
	'use step';
	const bu = createBuClient();
	try {
		await bu.stopBrowserSession(sessionId);
	} catch (err) {
		// Non-fatal: BU Cloud auto-stops via session timeout if we miss this.
		console.warn('[run-workflow] stopBrowserSession failed:', (err as Error).message);
	}
}

async function persistRunSummaryStep(input: {
	runId: string;
	finalStatus: 'passed' | 'failed' | 'errored';
	healthScore: number;
	summary: string;
}): Promise<void> {
	'use step';
	await db
		.update(runs)
		.set({
			status: input.finalStatus,
			finishedAt: new Date(),
			healthScore: input.healthScore,
			summary: input.summary,
		})
		.where(eq(runs.id, input.runId));
	await emitSseEvent(`run:${input.runId}`, {
		type: 'run_complete',
		runId: input.runId,
		status: input.finalStatus,
		healthScore: input.healthScore,
	});
}

// Helper that runs inside `streamReplayStep` (already a step). Pure, so safe.
async function persistStepResult(runId: string, result: WorkerStepResult): Promise<void> {
	await db.insert(stepResults).values({
		runId,
		stepIndex: result.stepIndex,
		status: result.status,
		startedAt: new Date(Date.now() - result.durationMs),
		finishedAt: new Date(),
		durationMs: result.durationMs,
		selectorResolvedVia: result.selectorResolvedVia ?? null,
		replayScreenshotKey: result.replayScreenshotBlobKey ?? null,
		judge: result.judge ?? null,
		consoleErrors: result.consoleErrors,
		networkErrors: result.networkErrors as { url: string; status: number }[],
		llmStepsUsed: result.llmStepsUsed,
		llmCostUsdMicro: result.llmCostUsdMicro,
		errorMessage: result.errorMessage ?? null,
	});
}

// ─── Workflow ──────────────────────────────────────────────────────────────

export async function runFlowWorkflow(
	input: RunFlowInput,
): Promise<{ ok: true; status: 'passed' | 'failed' | 'errored' | 'requeued' }> {
	'use workflow';

	const ctx = await loadRunContextStep({ flowId: input.flowId, orgId: input.orgId });
	const session = await createBuSessionStep({
		runId: input.runId,
		buProfileId: ctx.buProfileId,
	});

	const outcome = await streamReplayStep({
		runId: input.runId,
		flowId: input.flowId,
		flowName: ctx.flowName,
		siteOrigin: ctx.siteOrigin,
		steps: ctx.steps,
		cdpUrl: session.cdpUrl,
		mode: input.mode,
		sensitiveData: ctx.sensitiveData,
	});

	if (outcome.runStatus === 'paused' && outcome.pauseEvent) {
		await markPausedAuthStep({ runId: input.runId, hint: outcome.pauseEvent.hint });

		// Suspend the workflow until POST /api/cookies/refresh fires
		// resumeHook(token, { refreshed: true }) — or 24h timeout, whichever
		// comes first. The hook token is deterministic so the API route can
		// reconstruct it from the run id.
		const authHook = createHook<{ refreshed: true }>({
			token: `run:${input.runId}:auth-refreshed`,
		});

		const refreshOrTimeout = await Promise.race([
			authHook.then((value: { refreshed: true }) => ({ kind: 'refreshed' as const, value })),
			sleep('24h').then(() => ({ kind: 'timeout' as const })),
		]);

		if (refreshOrTimeout.kind === 'timeout') {
			await markAuthTimeoutStep(input.runId);
			await stopBuSessionStep(session.sessionId);
			return { ok: true, status: 'errored' };
		}

		// Refresh signal received. Phase 3.5a behavior: stop the stale BU session
		// and mark the run for re-queue. Phase 4 will start a child workflow that
		// resumes from `outcome.pauseEvent.blockedAtStepIndex`.
		await stopBuSessionStep(session.sessionId);
		await markRequeueAfterAuthStep(input.runId);
		return { ok: true, status: 'requeued' };
	}

	// Narrow `paused` away — we returned earlier in that branch.
	const finalStatus: 'passed' | 'failed' | 'errored' =
		outcome.runStatus === 'paused' ? 'errored' : outcome.runStatus;

	await stopBuSessionStep(session.sessionId);
	await persistRunSummaryStep({
		runId: input.runId,
		finalStatus,
		healthScore: outcome.healthScore,
		summary: outcome.summary,
	});

	return { ok: true, status: finalStatus };
}
