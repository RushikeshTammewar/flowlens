/**
 * Durable compile workflow — Vercel Workflow Devkit (WDK).
 *
 * The workflow function is sandboxed: no DB / fetch / Node modules in its body.
 * All real work happens in step functions (`"use step"` directive at top), which
 * have full Node.js access. Each step is automatically retried on transient
 * failures and its return value persisted for replay.
 *
 * Architecture (per LLD §5):
 *   loadCompileContext  → DB lookups (flow + site + recording)
 *   loadActions         → fetch action stream NDJSON from Vercel Blob
 *   compilePipeline     → narrate (×4 parallel) + synthesize + siblings
 *   buProfileSync       → best-effort BU Cloud profile creation
 *   persistCompileResult→ commit Flow document + status='ready'
 *   emitCompileComplete → SSE `compile_complete` event
 *
 * Trigger: `await start(compileRecordingWorkflow, [input])` from
 *   apps/web/src/app/api/recordings/[id]/finish/route.ts
 *
 * Crash safety:
 *   - Every step is durable. If the function-instance dies mid-narrate, the
 *     workflow resumes from the last persisted step.
 *   - Retries: WDK's default per-step retry policy applies. Throw FatalError
 *     for permanent failures, RetryableError for transient.
 */
import { eq } from 'drizzle-orm';
import { FatalError } from 'workflow';
import type { CompileOutput } from '@flowlens/flow-doc';
import { compileRecording } from '@flowlens/flow-doc';
import { syncCookiesToBuProfile } from '@flowlens/cookies-vault';
import { createBuClient } from '@flowlens/bu-cloud-client';
import type { RecordedAction } from '@flowlens/schema';
import { db } from '@/lib/db';
import { flows, sites, recordings } from '@flowlens/schema/db';
import { blobKeys } from '@/lib/blob';
import { emitSseEvent } from '@/lib/sse-bus';
import { setCompileStatus } from '@/lib/compile-runner';

export interface CompileRecordingInput {
	flowId: string;
	recordingId: string;
	orgId: string;
}

interface LoadedContext {
	siteOrigin: string;
	siteModelText: string | null;
	existingBuProfileId: string | null;
	flowName: string;
	actionStreamBlobKey: string | null;
}

// ─── Steps ─────────────────────────────────────────────────────────────────
// Every step has the "use step" directive at the top. WDK compiles each into
// a separately-retried, persisted unit. Step return values are serialized so
// they MUST be plain JSON-shaped data (no class instances, no functions).

async function loadCompileContextStep(
	flowId: string,
	recordingId: string,
): Promise<LoadedContext> {
	'use step';
	const flow = await db.query.flows.findFirst({ where: eq(flows.id, flowId) });
	if (!flow) throw new FatalError(`flow ${flowId} disappeared mid-compile`);
	const site = await db.query.sites.findFirst({ where: eq(sites.id, flow.siteId) });
	if (!site) throw new FatalError(`site ${flow.siteId} disappeared mid-compile`);
	const recording = await db.query.recordings.findFirst({
		where: eq(recordings.id, recordingId),
	});
	if (!recording) throw new FatalError(`recording ${recordingId} disappeared mid-compile`);
	return {
		siteOrigin: site.origin,
		siteModelText: typeof site.siteModel === 'string' ? site.siteModel : null,
		existingBuProfileId: flow.buProfileId,
		flowName: flow.name,
		actionStreamBlobKey: recording.actionStreamBlobKey,
	};
}

async function loadActionStreamStep(
	actionStreamBlobKey: string | null,
): Promise<RecordedAction[]> {
	'use step';
	if (!actionStreamBlobKey) {
		throw new FatalError('action stream blob missing — recording never finished');
	}
	const base = process.env.BLOB_PUBLIC_BASE_URL;
	if (!base) {
		throw new FatalError('BLOB_PUBLIC_BASE_URL not configured');
	}
	const url = `${base}/${actionStreamBlobKey}`;
	const res = await fetch(url);
	if (!res.ok) {
		throw new Error(`action stream fetch returned ${res.status}`);
	}
	const text = await res.text();
	return text
		.split('\n')
		.filter(Boolean)
		.map((line) => JSON.parse(line) as RecordedAction);
}

async function compilePipelineStep(input: {
	flowId: string;
	recordingId: string;
	siteOrigin: string;
	siteModelText: string | null;
	actions: RecordedAction[];
}): Promise<CompileOutput> {
	'use step';
	return compileRecording({
		flowId: input.flowId,
		siteOrigin: input.siteOrigin,
		siteModelText: input.siteModelText,
		actions: input.actions,
		resolveScreenshotUrl: async ({ actionIndex }) => {
			const blobKey = blobKeys.screenshot(input.recordingId, actionIndex);
			const base = process.env.BLOB_PUBLIC_BASE_URL;
			return base ? `${base}/${blobKey}` : null;
		},
		progress: (e) => {
			// In-memory map is per-function-instance; the SSE event is the durable
			// signal the extension consumes. Status map is best-effort.
			setCompileStatus({
				flowId: input.flowId,
				stage: e.stage,
				pct: e.pct,
				...(e.detail ? { detail: e.detail } : {}),
				updatedAt: Date.now(),
			});
			void emitSseEvent(`flow:${input.flowId}`, {
				type: 'compile_progress',
				flowId: input.flowId,
				pct: e.pct,
				stage: e.stage,
			});
		},
	});
}

async function buProfileSyncStep(input: {
	flowId: string;
	siteOrigin: string;
	existingProfileId: string | null;
}): Promise<string | null> {
	'use step';
	if (!process.env.BROWSER_USE_API_KEY) return input.existingProfileId;
	try {
		const bu = createBuClient();
		const sync = await syncCookiesToBuProfile({
			bu,
			flowId: input.flowId,
			siteOrigin: input.siteOrigin,
			existingProfileId: input.existingProfileId,
		});
		return sync.profileId;
	} catch (err) {
		console.warn('[compile-workflow] bu_profile_sync skipped:', (err as Error).message);
		return input.existingProfileId;
	}
}

async function persistCompileResultStep(input: {
	flowId: string;
	flowName: string;
	compileResult: CompileOutput;
	buProfileId: string | null;
}): Promise<void> {
	'use step';
	await db
		.update(flows)
		.set({
			steps: input.compileResult.steps,
			name: input.compileResult.synthesis.name || input.flowName,
			description: input.compileResult.synthesis.description,
			preconditions: input.compileResult.synthesis.preconditions,
			postconditions: input.compileResult.synthesis.postconditions,
			fragilityHints: input.compileResult.synthesis.fragilityHints,
			status: 'ready',
			...(input.buProfileId ? { buProfileId: input.buProfileId } : {}),
			updatedAt: new Date(),
		})
		.where(eq(flows.id, input.flowId));
}

async function emitCompileCompleteStep(flowId: string): Promise<void> {
	'use step';
	setCompileStatus({ flowId, stage: 'done', pct: 100, updatedAt: Date.now() });
	await emitSseEvent(`flow:${flowId}`, { type: 'compile_complete', flowId });
}

// ─── Workflow ──────────────────────────────────────────────────────────────
// "use workflow" makes this function durable. The body is sandboxed: only
// step calls + workflow primitives (sleep, createHook, getWorkflowMetadata)
// are allowed. No DB, no fetch, no Node modules directly here.

export async function compileRecordingWorkflow(
	input: CompileRecordingInput,
): Promise<{ ok: true; flowId: string }> {
	'use workflow';
	const ctx = await loadCompileContextStep(input.flowId, input.recordingId);
	const actions = await loadActionStreamStep(ctx.actionStreamBlobKey);
	const compileResult = await compilePipelineStep({
		flowId: input.flowId,
		recordingId: input.recordingId,
		siteOrigin: ctx.siteOrigin,
		siteModelText: ctx.siteModelText,
		actions,
	});
	const buProfileId = await buProfileSyncStep({
		flowId: input.flowId,
		siteOrigin: ctx.siteOrigin,
		existingProfileId: ctx.existingBuProfileId,
	});
	await persistCompileResultStep({
		flowId: input.flowId,
		flowName: ctx.flowName,
		compileResult,
		buProfileId,
	});
	await emitCompileCompleteStep(input.flowId);
	return { ok: true, flowId: input.flowId };
}

// `runCompileInline` lives in `apps/web/src/lib/compile-inline.ts` (separate
// file so the WDK SWC plugin doesn't treat it as workflow-context and ban
// Node modules like `pg` from its dependency tree). Used as the fire-and-
// forget compile dispatcher from /api/recordings/:id/finish until the
// `.well-known/workflow/v1/*` routing issue on Vercel is isolated.
