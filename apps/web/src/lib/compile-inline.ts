/**
 * Inline compile runner — fire-and-forget alternative to the durable
 * Vercel Workflow.
 *
 * # Why this file exists
 *
 * `apps/web/src/workflows/compile-recording.ts` defines a Vercel Workflow
 * Devkit (WDK) function with `'use workflow'` + `'use step'` directives. WDK
 * builds the `.well-known/workflow/v1/*` routes that drive durable execution.
 * On our current Vercel deploy those routes return 404 (functions are built
 * but the edge isn't routing to them), so `start(compileRecordingWorkflow,
 * ...)` queues a workflow that never executes — flows get stuck at
 * `compiling` forever.
 *
 * Until the routing is fixed we run the same compile pipeline inline as a
 * fire-and-forget Promise from `/api/recordings/:id/finish`. We lose
 * resume-on-crash; we get flows that actually compile.
 *
 * # Why it's a separate file from `compile-recording.ts`
 *
 * The WDK SWC plugin treats any file containing `'use workflow'` as a
 * workflow execution context and bans Node.js modules (the workflow body
 * is sandboxed). Our `db` import depends on `pg` which is Node-only, so
 * if we put `runCompileInline` next to the workflow function the build
 * fails with "You are attempting to use 'pg' which depends on Node.js
 * modules". This file has no workflow directives so the SWC plugin
 * leaves it alone and the inline function can use the full Node stack.
 *
 * # Crash safety
 *
 * Vercel function instances run up to 60 s on Hobby and 300 s on Pro,
 * which is well above our typical 5–15 s compile budget. If an instance
 * dies mid-compile the flow row stays at `compiling`; the user can call
 * `POST /api/flows/:id/compile-retry` to re-trigger.
 */
import { eq } from 'drizzle-orm';
import type { CompileOutput } from '@flowlens/flow-doc';
import { compileRecording } from '@flowlens/flow-doc';
import { syncCookiesToBuProfile } from '@flowlens/cookies-vault';
import { createBuClient } from '@flowlens/bu-cloud-client';
import type { PageControlSummary, RecordedAction } from '@flowlens/schema';
import { db } from '@/lib/db';
import { flows, sites, recordings } from '@flowlens/schema/db';
import { blobKeys } from '@/lib/blob';
import { emitSseEvent } from '@/lib/sse-bus';
import { setCompileStatus } from '@/lib/compile-runner';
import { isPhase4Enabled } from '@/lib/feature-flags';

export interface CompileInlineInput {
	flowId: string;
	recordingId: string;
	orgId: string;
}

export async function runCompileInline(
	input: CompileInlineInput,
): Promise<{ ok: true; flowId: string }> {
	const startedAt = Date.now();
	try {
		const flow = await db.query.flows.findFirst({ where: eq(flows.id, input.flowId) });
		if (!flow) throw new Error(`flow ${input.flowId} disappeared mid-compile`);
		const site = await db.query.sites.findFirst({ where: eq(sites.id, flow.siteId) });
		if (!site) throw new Error(`site ${flow.siteId} disappeared mid-compile`);
		const recording = await db.query.recordings.findFirst({
			where: eq(recordings.id, input.recordingId),
		});
		if (!recording) throw new Error(`recording ${input.recordingId} disappeared mid-compile`);
		if (!recording.actionStreamBlobKey) {
			throw new Error('action stream blob missing — recording never finished');
		}

		const blobBase = process.env.BLOB_PUBLIC_BASE_URL;
		if (!blobBase) throw new Error('BLOB_PUBLIC_BASE_URL not configured');

		// Load action stream NDJSON from Vercel Blob.
		const actionsUrl = `${blobBase}/${recording.actionStreamBlobKey}`;
		const actionsRes = await fetch(actionsUrl);
		if (!actionsRes.ok) throw new Error(`action stream fetch returned ${actionsRes.status}`);
		const actionsText = await actionsRes.text();
		const actions: RecordedAction[] = [];
		let pageControls: PageControlSummary[] = [];
		for (const line of actionsText.split('\n')) {
			if (!line) continue;
			// Envelope lines (e.g. {"__envelope":"pageControls","items":[…]})
			// are sibling metadata, not actions — peel them off before
			// handing the rest to the compile pipeline. Backwards-compatible
			// with legacy blobs that have no envelope at all.
			if (line.includes('"__envelope"')) {
				try {
					const parsed = JSON.parse(line) as { __envelope?: string; items?: unknown };
					if (parsed.__envelope === 'pageControls' && Array.isArray(parsed.items)) {
						pageControls = parsed.items as PageControlSummary[];
						continue;
					}
				} catch {
					// fall through and treat as an action so we don't silently drop data
				}
			}
			actions.push(JSON.parse(line) as RecordedAction);
		}

		// Track which actionIndex blobs actually exist; we'll use this to
		// stamp `recordedScreenshotKey` on each compiled FlowStep below so
		// the side panel can render screenshots in the Reviewing screen.
		const resolvedScreenshotKeys = new Map<number, string>();

		console.info(
			`[compile-inline] flow=${input.flowId} parsed ${actions.length} actions, ` +
				`pageControls=${pageControls.length}`,
		);

		// Phase 4 / Tier 2 — opt-in to FeatureContract synthesis. When
		// the org-level (env-driven for now) flag is on, the synthesize
		// stage emits a structured contract that downstream test-matrix
		// generation reasons against. When off, the V1 synthesize call
		// runs unchanged. Persisted to flows.feature_contract below.
		const phase4 = isPhase4Enabled();
		console.info(
			`[compile-inline] flow=${input.flowId} phase4=${phase4 ? 'on' : 'off'}`,
		);

		// Run the compile pipeline (narrate × N + synthesize + siblings).
		const compileResult: CompileOutput = await compileRecording({
			flowId: input.flowId,
			siteOrigin: site.origin,
			siteModelText: typeof site.siteModel === 'string' ? site.siteModel : null,
			actions,
			pageControls,
			emitFeatureContract: phase4,
			resolveScreenshotUrl: async ({ actionIndex }) => {
				// HEAD-probe the blob before handing the URL to OpenAI — the
				// extension can't always capture a screenshot for every action
				// (e.g. focus events, scroll-only actions) so the narrate
				// model would 400 with "Error while downloading" if we passed
				// a non-existent URL. Returning null tells narrate to use a
				// text-only prompt for that step. Cheap probe (~50ms).
				const blobKey = blobKeys.screenshot(input.recordingId, actionIndex);
				const url = `${blobBase}/${blobKey}`;
				try {
					const probe = await fetch(url, { method: 'HEAD' });
					if (probe.ok) {
						resolvedScreenshotKeys.set(actionIndex, blobKey);
						return url;
					}
					return null;
				} catch {
					return null;
				}
			},
			progress: (e) => {
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

		// Best-effort BU profile sync.
		let buProfileId = flow.buProfileId;
		if (process.env.BROWSER_USE_API_KEY) {
			try {
				const bu = createBuClient();
				const sync = await syncCookiesToBuProfile({
					bu,
					flowId: input.flowId,
					siteOrigin: site.origin,
					existingProfileId: flow.buProfileId,
				});
				buProfileId = sync.profileId;
			} catch (err) {
				console.warn('[compile-inline] bu_profile_sync skipped:', (err as Error).message);
			}
		}

		// Stamp recordedScreenshotKey on every step that has a blob. The
		// compile pipeline reads this off `action.screenshotKey`, but the
		// extension's recorder doesn't populate that field (the chunks
		// route uploads blobs at deterministic paths but doesn't write
		// back into the action stream). Filling it here is the single
		// place where we know both the recordingId and which keys are
		// actually present in blob storage.
		const stepsWithScreenshots = compileResult.steps.map((step) => {
			const key = resolvedScreenshotKeys.get(step.index);
			return key ? { ...step, recordedScreenshotKey: key } : step;
		});

		// Commit Flow document + flip status to ready.
		// `featureContract` is only populated under Phase 4 (feature flag
		// in compile.ts via emitFeatureContract). When null, we EXPLICITLY
		// pass through to keep legacy flows compatible — a missing key in
		// the SET would no-op rather than clear stale contracts.
		await db
			.update(flows)
			.set({
				steps: stepsWithScreenshots,
				name: compileResult.synthesis.name || flow.name,
				description: compileResult.synthesis.description,
				preconditions: compileResult.synthesis.preconditions,
				postconditions: compileResult.synthesis.postconditions,
				fragilityHints: compileResult.synthesis.fragilityHints,
				status: 'ready',
				...(buProfileId ? { buProfileId } : {}),
				...(compileResult.featureContract
					? { featureContract: compileResult.featureContract }
					: {}),
				updatedAt: new Date(),
			})
			.where(eq(flows.id, input.flowId));

		if (compileResult.featureContract) {
			console.info(
				`[phase4:contract] persisted to flows.feature_contract flow=${input.flowId} ` +
					`featureName=${JSON.stringify(compileResult.featureContract.featureName)} ` +
					`behaviors=${compileResult.featureContract.expectedBehaviors.length}`,
			);
		}

		setCompileStatus({ flowId: input.flowId, stage: 'done', pct: 100, updatedAt: Date.now() });
		await emitSseEvent(`flow:${input.flowId}`, { type: 'compile_complete', flowId: input.flowId });
		console.info(
			`[compile-inline] flow=${input.flowId} ok in ${Date.now() - startedAt}ms`,
		);
		return { ok: true, flowId: input.flowId };
	} catch (err) {
		console.error(`[compile-inline] flow=${input.flowId} FAILED:`, err);
		const message = err instanceof Error ? err.message : String(err);
		try {
			await db
				.update(flows)
				.set({
					status: 'draft',
					description: `Compile failed: ${message.slice(0, 400)}`,
					updatedAt: new Date(),
				})
				.where(eq(flows.id, input.flowId));
			setCompileStatus({
				flowId: input.flowId,
				stage: 'failed',
				pct: 0,
				error: message,
				updatedAt: Date.now(),
			});
			await emitSseEvent(`flow:${input.flowId}`, {
				type: 'compile_failed',
				flowId: input.flowId,
				error: message,
			});
		} catch (mkErr) {
			console.error('[compile-inline] failed to mark failure:', mkErr);
		}
		throw err;
	}
}
