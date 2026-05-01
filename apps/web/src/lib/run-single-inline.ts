/**
 * Inline single-run driver — drives ONE replay against the local sidecar
 * (or the deployed replay-worker), one step result at a time.
 *
 * Same fire-and-forget pattern as `runBatchInline` / `runCompileInline`:
 * the route handler kicks this off via `waitUntil` and returns immediately;
 * we keep going past the response and persist as we stream.
 *
 * Why inline (not Vercel Workflow): the WDK `.well-known/workflow/v1/*`
 * routes return 404 on this Vercel project even though the functions are
 * built. Until that's isolated, single runs go through the same path the
 * matrix runner already uses — we trade durable resume-on-crash for a
 * feature that actually executes.
 *
 * Why `/run` (SSE) and NOT `/run-sync`: the side panel shows progress
 * step-by-step. We need to land each `StepFinishedEvent` into the DB the
 * moment it fires so the polling client can see it. /run-sync buffers
 * everything until the run terminates.
 */
import { eq } from 'drizzle-orm';
import { db } from '@/lib/db';
import {
	cookieSnapshots,
	flows,
	runs,
	sites,
	stepResults,
} from '@flowlens/schema/db';
import type { FlowStep } from '@flowlens/schema';
import { openForOrg } from '@flowlens/cookies-vault';
import { createBuClient } from '@flowlens/bu-cloud-client';
import { emitSseEvent } from '@/lib/sse-bus';
import { blobKeys, putBlob } from '@/lib/blob';

const REPLAY_WORKER_URL = process.env.REPLAY_WORKER_URL ?? 'http://127.0.0.1:8000';
const REPLAY_WORKER_BEARER = process.env.REPLAY_WORKER_SHARED_SECRET ?? '';

export interface RunSingleInlineInput {
	runId: string;
	flowId: string;
	orgId: string;
	mode: 'hybrid' | 'fast' | 'full_llm';
}

interface InjectableCookie {
	name: string;
	value: string;
	domain: string;
	path: string;
	expires: number | null;
	httpOnly: boolean;
	secure: boolean;
	sameSite: 'Strict' | 'Lax' | 'None' | 'unspecified';
}

interface SidecarStepResultPayload {
	runId: string;
	stepIndex: number;
	status: 'passed' | 'failed' | 'flaky' | 'blocked_auth' | 'inconclusive' | 'skipped';
	durationMs: number;
	selectorResolvedVia?:
		| 'testid'
		| 'role-name'
		| 'css'
		| 'xpath'
		| 'flowlens-id'
		| 'llm'
		| 'recorded-only'
		| null;
	replayScreenshotBlobKey?: string | null;
	replayScreenshotPngB64?: string | null;
	judge?: {
		verdict: 'pass' | 'fail';
		reason: string;
		confidence: number;
	} | null;
	consoleErrors?: string[];
	networkErrors?: { url: string; status: number }[];
	llmStepsUsed?: number;
	llmCostUsdMicro?: number;
	errorMessage?: string | null;
}

export async function runSingleInline(input: RunSingleInlineInput): Promise<void> {
	const startedAt = Date.now();
	console.info(`[run-single-inline] run=${input.runId} flow=${input.flowId} mode=${input.mode}`);

	let buSessionId: string | null = null;
	try {
		const flow = await db.query.flows.findFirst({ where: eq(flows.id, input.flowId) });
		if (!flow) throw new Error(`flow ${input.flowId} disappeared`);
		const site = await db.query.sites.findFirst({ where: eq(sites.id, flow.siteId) });
		if (!site) throw new Error(`site ${flow.siteId} disappeared`);

		// Decrypt cookies once. Two outputs match `runBatchInline`:
		//   1. injectableCookies → CDP `Storage.setCookies` BEFORE first nav
		//   2. sensitiveData → browser-use Agent prompt redaction map
		const injectableCookies: InjectableCookie[] = [];
		const sensitiveData: Record<string, string> = {};
		if (flow.cookieSnapshotId && process.env.FLOWLENS_VAULT_SECRET) {
			try {
				const snap = await db.query.cookieSnapshots.findFirst({
					where: eq(cookieSnapshots.id, flow.cookieSnapshotId),
				});
				if (snap) {
					const plaintext = await openForOrg({
						orgId: input.orgId,
						vaultSecret: process.env.FLOWLENS_VAULT_SECRET,
						sealed: { ciphertext: snap.ciphertext, nonce: snap.nonce },
					});
					const parsed = JSON.parse(plaintext) as { cookies?: InjectableCookie[] };
					for (const c of parsed.cookies ?? []) {
						injectableCookies.push(c);
						sensitiveData[c.name] = c.value;
					}
				}
			} catch (err) {
				console.warn('[run-single-inline] vault decrypt failed:', (err as Error).message);
			}
		}

		// Create BU Cloud session.
		const buClient = createBuClient();
		const bu = await buClient.createBrowserSession({
			profileId: flow.buProfileId ?? undefined,
			keepAlive: true,
		});
		buSessionId = bu.id;
		if (!bu.cdpUrl) throw new Error('BU Cloud did not return cdpUrl');

		await db
			.update(runs)
			.set({
				buSessionId: bu.id,
				buCdpUrl: bu.cdpUrl,
				liveUrl: bu.liveUrl,
				status: 'running',
				startedAt: new Date(),
			})
			.where(eq(runs.id, input.runId));
		await emitSseEvent(`run:${input.runId}`, {
			type: 'run_started',
			runId: input.runId,
			liveUrl: bu.liveUrl,
		});
		console.info(
			`[FLOWLENS:run-single-inline] session_attached run=${input.runId} bu=${bu.id} cookies=${injectableCookies.length}`,
		);

		// Stream /run SSE so step_results land in the DB progressively.
		const outcome = await streamSidecar({
			runId: input.runId,
			flowId: input.flowId,
			flowName: flow.name,
			siteOrigin: site.origin,
			steps: (flow.steps as FlowStep[]) ?? [],
			cdpUrl: bu.cdpUrl,
			liveUrl: bu.liveUrl,
			mode: input.mode,
			cookies: injectableCookies,
			sensitiveData,
		});

		await db
			.update(runs)
			.set({
				status: outcome.status,
				finishedAt: new Date(),
				healthScore: outcome.healthScore,
				summary: outcome.summary,
				errorClass: outcome.errorClass,
			})
			.where(eq(runs.id, input.runId));
		await emitSseEvent(`run:${input.runId}`, {
			type: 'run_complete',
			runId: input.runId,
			status: outcome.status,
			healthScore: outcome.healthScore,
		});

		console.info(
			`[run-single-inline] run=${input.runId} done in ${Date.now() - startedAt}ms status=${outcome.status}`,
		);
	} catch (err) {
		console.error(`[run-single-inline] run=${input.runId} FAILED:`, err);
		const message = (err as Error).message ?? String(err);
		await db
			.update(runs)
			.set({
				status: 'errored',
				finishedAt: new Date(),
				summary: `errored: ${message.slice(0, 400)}`,
				errorClass: 'env',
			})
			.where(eq(runs.id, input.runId))
			.catch(() => {});
		await emitSseEvent(`run:${input.runId}`, {
			type: 'run_complete',
			runId: input.runId,
			status: 'errored',
			healthScore: 0,
		}).catch(() => {});
	} finally {
		if (buSessionId) {
			try {
				const buClient = createBuClient();
				await buClient.stopBrowserSession(buSessionId);
			} catch (err) {
				console.warn('[run-single-inline] stopBrowserSession failed:', (err as Error).message);
			}
		}
	}
}

interface StreamSidecarInput {
	runId: string;
	flowId: string;
	flowName: string;
	siteOrigin: string;
	steps: FlowStep[];
	cdpUrl: string;
	liveUrl: string | null;
	mode: 'hybrid' | 'fast' | 'full_llm';
	cookies: InjectableCookie[];
	sensitiveData: Record<string, string>;
}

interface StreamOutcome {
	status: 'passed' | 'failed' | 'errored';
	healthScore: number;
	summary: string;
	errorClass: 'app_bug' | 'flaky' | 'env' | 'auth' | null;
}

async function streamSidecar(input: StreamSidecarInput): Promise<StreamOutcome> {
	const res = await fetch(`${REPLAY_WORKER_URL}/run`, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${REPLAY_WORKER_BEARER}`,
			'Content-Type': 'application/json',
			Accept: 'text/event-stream',
		},
		body: JSON.stringify({
			runId: input.runId,
			flow: {
				id: input.flowId,
				name: input.flowName,
				siteOrigin: input.siteOrigin,
				steps: input.steps,
			},
			cdpUrl: input.cdpUrl,
			liveUrl: input.liveUrl,
			mode: { name: input.mode },
			recordedScreenshotsByIndex: {},
			sensitiveData: input.sensitiveData,
			cookies: input.cookies,
			// Land BU Cloud on the URL where the user actually started
			// recording (e.g. /practice-test-table/) NOT just the origin —
			// otherwise step 0's selector fails with `no_match` because
			// the recorded element doesn't exist on the homepage.
			landingUrl:
				(input.steps[0] as { url?: string } | undefined)?.url ?? input.siteOrigin,
		}),
		signal: AbortSignal.timeout(360_000),
	});
	if (!res.ok || !res.body) {
		const body = await res.text().catch(() => '');
		throw new Error(`sidecar /run returned ${res.status}: ${body.slice(0, 200)}`);
	}

	let outcome: StreamOutcome = {
		status: 'errored',
		healthScore: 0,
		summary: 'no terminal event from sidecar',
		errorClass: 'env',
	};

	for await (const chunk of parseSseChunks(res.body)) {
		let payload: { type?: string; result?: SidecarStepResultPayload; [k: string]: unknown };
		try {
			payload = JSON.parse(chunk);
		} catch {
			continue;
		}
		if (!payload.type) continue;
		const event = payload as { type: string; [k: string]: unknown };
		if (payload.type === 'step_started') {
			await emitSseEvent(`run:${input.runId}`, event);
		} else if (payload.type === 'step_finished' && payload.result) {
			payload.result.replayScreenshotBlobKey = await uploadReplayScreenshot(
				input.runId,
				payload.result.stepIndex,
				payload.result.replayScreenshotPngB64,
			);
			// Drop the heavy base64 payload before persisting — it's
			// already on Vercel Blob and the DB shouldn't carry it.
			payload.result.replayScreenshotPngB64 = null;
			await persistStepResult(input.runId, payload.result);
			await emitSseEvent(`run:${input.runId}`, event);
		} else if (payload.type === 'run_paused') {
			outcome = {
				status: 'errored',
				healthScore: 0,
				summary: `paused: ${(payload.hint as string) ?? 'auth wall'}`,
				errorClass: 'auth',
			};
			await emitSseEvent(`run:${input.runId}`, event);
			break;
		} else if (payload.type === 'run_complete') {
			const s = payload.status as string;
			outcome = {
				status: s === 'passed' ? 'passed' : s === 'failed' ? 'failed' : 'errored',
				healthScore: (payload.healthScore as number) ?? 0,
				summary: (payload.summary as string) ?? '',
				errorClass: (payload.errorClass as StreamOutcome['errorClass']) ?? null,
			};
		}
	}

	return outcome;
}

/**
 * Minimal SSE chunk parser — yields the `data:` payload of each event.
 * The replay-engine package has its own parseSse, but we parse inline here
 * so this lib stays self-contained and doesn't depend on the typed client
 * (whose Zod schema is missing the `cookies` field on RunRequest).
 *
 * sse_starlette (FastAPI side) emits CRLF line endings by default, so an
 * event terminator is `\r\n\r\n`. We accept both CRLF and LF — either by
 * normalizing CR away first.
 */
async function* parseSseChunks(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let buffer = '';
	try {
		while (true) {
			const { value, done } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			// Normalize CRLF → LF so the separator search is uniform.
			buffer = buffer.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
			let sep: number;
			while ((sep = buffer.indexOf('\n\n')) !== -1) {
				const event = buffer.slice(0, sep);
				buffer = buffer.slice(sep + 2);
				const dataLines: string[] = [];
				for (const line of event.split('\n')) {
					if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
				}
				if (dataLines.length > 0) yield dataLines.join('\n');
			}
		}
	} finally {
		reader.releaseLock();
	}
}

/**
 * Decode the sidecar's base64 JPEG and upload it to Vercel Blob.
 *
 * Returns the blob key on success or `null` on any failure. Never throws —
 * a screenshot upload failure must NEVER fail the surrounding step. The
 * side panel renders a "no screenshot" placeholder when the key is null.
 *
 * Sidecar emits JPEG (quality=60, ~80KB) under the field still named
 * `replayScreenshotPngB64` for wire-stability. We persist with the matching
 * `image/jpeg` content-type so Vercel Blob serves the right MIME header.
 */
async function uploadReplayScreenshot(
	runId: string,
	stepIndex: number,
	pngB64: string | null | undefined,
): Promise<string | null> {
	if (!pngB64) return null;
	try {
		const bytes = Buffer.from(pngB64, 'base64');
		if (bytes.byteLength === 0) return null;
		const key = blobKeys.replayScreenshot(runId, stepIndex);
		await putBlob(key, bytes, 'image/jpeg');
		return key;
	} catch (err) {
		console.warn(
			`[run-single-inline] uploadReplayScreenshot run=${runId} step=${stepIndex} skipped: ${(err as Error).message}`,
		);
		return null;
	}
}

async function persistStepResult(
	runId: string,
	result: SidecarStepResultPayload,
): Promise<void> {
	await db
		.insert(stepResults)
		.values({
			runId,
			stepIndex: result.stepIndex,
			status: result.status,
			startedAt: new Date(Date.now() - result.durationMs),
			finishedAt: new Date(),
			durationMs: result.durationMs,
			selectorResolvedVia: result.selectorResolvedVia ?? null,
			replayScreenshotKey: result.replayScreenshotBlobKey ?? null,
			judge: result.judge ?? null,
			consoleErrors: result.consoleErrors ?? [],
			networkErrors: result.networkErrors ?? [],
			llmStepsUsed: result.llmStepsUsed ?? 0,
			llmCostUsdMicro: result.llmCostUsdMicro ?? 0,
			errorMessage: result.errorMessage ?? null,
		})
		.catch((err) => {
			console.warn('[run-single-inline] persistStepResult skipped:', (err as Error).message);
		});
}
