/**
 * GET /api/batches/:id — full batch status: batch row + child runs + variants.
 *
 * The extension polls this every 2-3s while the batch is running to render
 * the per-variant progress columns. SSE option could replace polling later.
 *
 * Enrichment notes:
 * - Each `stepResults[].replayScreenshotUrl` is computed from `replay_screenshot_key`
 *   + `BLOB_PUBLIC_BASE_URL` so the side panel can render thumbnails without a
 *   second round-trip. Mirrors the same pattern `/api/flows/:id` uses for
 *   recorded screenshots.
 * - The parent `flow` (id, name, description, preconditions, step intents)
 *   is also returned so the side panel can show the AI's understanding of
 *   what the user is testing without a second `/api/flows/:id` fetch.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { eq, inArray } from 'drizzle-orm';
import { db } from '@/lib/db';
import { requireAuthContext, UnauthorizedError } from '@/lib/auth';
import { runBatches, runs, testVariants, stepResults, flows } from '@flowlens/schema/db';
import type { FlowStep } from '@flowlens/schema';

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
	try {
		const auth = await requireAuthContext();
		const { id: batchId } = await ctx.params;

		const batch = await db.query.runBatches.findFirst({ where: eq(runBatches.id, batchId) });
		if (!batch || batch.orgId !== auth.org.id) {
			return NextResponse.json({ error: 'batch not found' }, { status: 404 });
		}

		const variants = batch.variantIds.length
			? await db.query.testVariants.findMany({
					where: inArray(testVariants.id, batch.variantIds),
				})
			: [];

		const childRuns = await db.query.runs.findMany({
			where: eq(runs.batchId, batchId),
		});

		// Per-run step results — flatten so the UI can show progress dots.
		const runIds = childRuns.map((r) => r.id);
		const allSteps = runIds.length
			? await db.query.stepResults.findMany({
					where: inArray(stepResults.runId, runIds),
				})
			: [];

		// Group step results by runId.
		const stepsByRun = new Map<string, Array<typeof stepResults.$inferSelect>>();
		for (const s of allSteps) {
			const arr = stepsByRun.get(s.runId) ?? [];
			arr.push(s);
			stepsByRun.set(s.runId, arr);
		}

		// Stamp every step row with a fully-qualified replay screenshot URL when
		// the sidecar has uploaded one. Returning `null` when missing keeps the
		// UI's "no screenshot" placeholder simple.
		const blobBase = process.env.BLOB_PUBLIC_BASE_URL ?? '';
		const enrichStep = (s: typeof stepResults.$inferSelect) => ({
			...s,
			replayScreenshotUrl:
				blobBase && s.replayScreenshotKey ? `${blobBase}/${s.replayScreenshotKey}` : null,
		});

		const variantsView = variants.map((v) => {
			const run = childRuns.find((r) => r.variantId === v.id);
			const rawSteps = run ? stepsByRun.get(run.id) ?? [] : [];
			return {
				variant: v,
				run: run
					? {
							id: run.id,
							status: run.status,
							liveUrl: run.liveUrl,
							summary: run.summary,
							healthScore: run.healthScore,
							startedAt: run.startedAt,
							finishedAt: run.finishedAt,
						}
					: null,
				stepResults: rawSteps.map(enrichStep),
			};
		});

		// Trim the parent flow down to fields the side panel actually needs:
		// `name`/`description`/`preconditions` for the "what we think you're
		// testing" card and per-step `intent`/`expectedOutcome` for the
		// numbered list. We deliberately drop selectors and screenshot keys
		// here to keep the payload small.
		const flow = batch.flowId
			? await db.query.flows.findFirst({ where: eq(flows.id, batch.flowId) })
			: null;
		const flowView = flow
			? {
					id: flow.id,
					name: flow.name,
					description: flow.description,
					preconditions: flow.preconditions,
					steps: (flow.steps as FlowStep[]).map((s) => ({
						index: s.index,
						action: s.action,
						intent: s.intent,
						expectedOutcome: s.expectedOutcome,
						isCritical: s.isCritical,
					})),
				}
			: null;

		return NextResponse.json({
			batch,
			flow: flowView,
			variants: variantsView,
			counts: {
				total: childRuns.length,
				passed: childRuns.filter((r) => r.status === 'passed').length,
				failed: childRuns.filter((r) => r.status === 'failed').length,
				errored: childRuns.filter((r) => r.status === 'errored').length,
				running: childRuns.filter((r) => r.status === 'running').length,
				queued: childRuns.filter((r) => r.status === 'queued').length,
			},
		});
	} catch (err) {
		if (err instanceof UnauthorizedError) {
			return NextResponse.json({ error: err.message }, { status: 401 });
		}
		console.error('[GET /api/batches/:id]', err);
		return NextResponse.json({ error: (err as Error).message }, { status: 500 });
	}
}
