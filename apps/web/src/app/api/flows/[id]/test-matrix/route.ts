/**
 * /api/flows/:id/test-matrix
 *
 *   POST → generate N variants via o3 (with o4-mini fallback). Persists to
 *          test_variants and returns the list. ~$0.05–0.08 OpenAI per call.
 *   GET  → list existing variants for the flow.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { generateTestMatrix } from '@flowlens/flow-doc';
import type { FlowStep, PageControlSummary } from '@flowlens/schema';
import { db } from '@/lib/db';
import { requireAuthContext, UnauthorizedError } from '@/lib/auth';
import { flows, recordings, testVariants } from '@flowlens/schema/db';

const PostBody = z.object({
	count: z.union([z.literal(5), z.literal(10), z.literal(20)]).default(10),
	regenerate: z.boolean().default(false),
});

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
	try {
		const auth = await requireAuthContext();
		const { id: flowId } = await ctx.params;
		const flow = await db.query.flows.findFirst({ where: eq(flows.id, flowId) });
		if (!flow || flow.orgId !== auth.org.id) {
			return NextResponse.json({ error: 'flow not found' }, { status: 404 });
		}
		if (flow.status !== 'ready') {
			return NextResponse.json(
				{ error: `flow not ready (status=${flow.status}); compile first` },
				{ status: 409 },
			);
		}

		const body = PostBody.parse(await req.json().catch(() => ({})));

		if (body.regenerate) {
			await db.delete(testVariants).where(eq(testVariants.flowId, flowId));
		}

		// Pick a representative screenshot for vision-mode matrix-gen.
		// Priority (best first):
		//  1. The FIRST step's screenshot that's an `input | change | click`
		//     on a known form control (controlType !== undefined). This is
		//     the screenshot taken when the user first interacted with the
		//     form — most likely shows the page layout with all controls
		//     visible and unmodified, which is what matrix-gen needs to
		//     reason about untouched controls.
		//  2. Fallback: the FIRST step with any screenshot at all.
		//  3. Fallback: the LAST step with any screenshot (legacy heuristic).
		const flowSteps = flow.steps as FlowStep[];
		const blobBase = process.env.BLOB_PUBLIC_BASE_URL ?? '';
		let screenshotUrl: string | null = null;
		if (blobBase) {
			const stepsWithKeys = flowSteps.filter((s) => s.recordedScreenshotKey);
			const isFormControlInteraction = (s: FlowStep): boolean =>
				s.controlType !== undefined &&
				(s.action === 'input' || s.action === 'select' || s.action === 'click');
			const firstFormStep = stepsWithKeys.find(isFormControlInteraction);
			const firstAny = stepsWithKeys[0];
			const lastAny = stepsWithKeys[stepsWithKeys.length - 1];
			const chosen = firstFormStep ?? firstAny ?? lastAny;
			if (chosen?.recordedScreenshotKey) {
				screenshotUrl = `${blobBase}/${chosen.recordedScreenshotKey}`;
			}
		}

		// Resolve page-wide form-control inventory captured at recording end.
		// Lives as a sentinel envelope-line in the recording's NDJSON action
		// stream blob (no DB schema change needed). We pick the most recent
		// finished recording for this flow — typical case: 1:1 flow:recording,
		// re-records simply replace the blob keyed off the new recordingId.
		// Returns [] when the column is absent (legacy flows pre-Part-2).
		let pageControls: PageControlSummary[] = [];
		if (blobBase) {
			try {
				const rec = await db.query.recordings.findFirst({
					where: eq(recordings.flowId, flow.id),
					orderBy: [desc(recordings.startedAt)],
				});
				if (rec?.actionStreamBlobKey) {
					const url = `${blobBase}/${rec.actionStreamBlobKey}`;
					const r = await fetch(url, {
						// Action streams can be cached aggressively — they're
						// content-addressed by recordingId. Browser/CDN cache
						// is fine; matrix-gen tolerates a slightly stale view.
						cache: 'no-store',
					});
					if (r.ok) {
						const text = await r.text();
						pageControls = parsePageControlsFromActionStream(text);
					} else {
						console.warn(
							`[test-matrix] action stream fetch ${r.status} for recording=${rec.id}`,
						);
					}
				}
			} catch (err) {
				console.warn('[test-matrix] failed to load pageControls from blob:', err);
			}
		}

		if (process.env.FLOWLENS_LOG_MATRIX_PROMPT === '1') {
			console.info(
				`[test-matrix] flow=${flow.id} screenshotUrl=${screenshotUrl ?? 'null'} ` +
					`pageControls=${pageControls.length}`,
			);
		}

		const result = await generateTestMatrix({
			flow: {
				id: flow.id,
				name: flow.name,
				description: flow.description,
				preconditions: flow.preconditions,
				steps: flowSteps.map((s) => ({
					index: s.index,
					action: s.action,
					intent: s.intent,
					expectedOutcome: s.expectedOutcome,
					isCritical: s.isCritical,
					recordedValue: s.recordedValue ?? null,
					isSensitive: s.isSensitive,
					...(s.controlType !== undefined ? { controlType: s.controlType } : {}),
					...(s.availableOptions !== undefined ? { availableOptions: s.availableOptions } : {}),
					...(s.constraints !== undefined ? { constraints: s.constraints } : {}),
					...(s.controlName !== undefined ? { controlName: s.controlName } : {}),
				})),
				...(pageControls.length > 0 ? { pageControls } : {}),
			},
			count: body.count,
			screenshotUrl,
			screenshotDetail: 'high',
		});

		const inserted = await db
			.insert(testVariants)
			.values(
				result.variants.map((v) => ({
					flowId,
					family: v.family,
					name: v.name,
					description: v.description,
					rationale: v.rationale,
					expectedOutcome: v.expectedOutcome,
					fieldOverrides: v.fieldOverrides,
					fragility: v.fragility,
					generatedBy: result.model,
				})),
			)
			.returning();

		return NextResponse.json({
			flowId,
			model: result.model,
			usage: result.usage,
			variants: inserted,
		});
	} catch (err) {
		if (err instanceof UnauthorizedError) {
			return NextResponse.json({ error: err.message }, { status: 401 });
		}
		if (err instanceof z.ZodError) {
			return NextResponse.json({ error: 'invalid', issues: err.issues }, { status: 400 });
		}
		console.error('[POST /api/flows/:id/test-matrix]', err);
		return NextResponse.json({ error: (err as Error).message }, { status: 500 });
	}
}

/**
 * Extract the `pageControls` envelope-line from a recording's NDJSON action
 * stream blob.
 *
 * The recorder stamps a single sentinel line at the head of the blob:
 *   {"__envelope":"pageControls","items":[...]}
 *
 * Legacy blobs (recorded before Part-2 of the flowlens-25 patch series) don't
 * have this line — we silently return [] in that case. We never throw on a
 * malformed line; matrix-gen still runs without page-wide control awareness.
 */
function parsePageControlsFromActionStream(text: string): PageControlSummary[] {
	const lines = text.split('\n').filter(Boolean);
	for (const line of lines) {
		// Cheap discriminator skip — the envelope is the first JSON object
		// whose `__envelope` key is `pageControls`. Action records never
		// emit `__envelope` so a startswith check is enough.
		if (!line.includes('"__envelope"')) continue;
		try {
			const parsed = JSON.parse(line) as { __envelope?: string; items?: unknown };
			if (parsed.__envelope === 'pageControls' && Array.isArray(parsed.items)) {
				return parsed.items as PageControlSummary[];
			}
		} catch {
			// Tolerate corrupted envelope; treat as no-op.
		}
	}
	return [];
}

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
	try {
		const auth = await requireAuthContext();
		const { id: flowId } = await ctx.params;
		const flow = await db.query.flows.findFirst({ where: eq(flows.id, flowId) });
		if (!flow || flow.orgId !== auth.org.id) {
			return NextResponse.json({ error: 'flow not found' }, { status: 404 });
		}
		const variants = await db.query.testVariants.findMany({
			where: eq(testVariants.flowId, flowId),
		});
		return NextResponse.json({ flowId, variants });
	} catch (err) {
		if (err instanceof UnauthorizedError) {
			return NextResponse.json({ error: err.message }, { status: 401 });
		}
		console.error('[GET /api/flows/:id/test-matrix]', err);
		return NextResponse.json({ error: (err as Error).message }, { status: 500 });
	}
}
