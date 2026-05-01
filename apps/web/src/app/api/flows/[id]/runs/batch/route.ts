/**
 * POST /api/flows/:id/runs/batch — kick off a Test Matrix batch run.
 *
 * Body: `{ variantIds?: string[] }` — if omitted, all enabled variants for
 * the flow are used.
 *
 * Returns `{ batchId }` immediately; the actual fan-out runs via
 * `runBatchInline` wrapped in `waitUntil` to keep the function alive past
 * the response.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { waitUntil } from '@vercel/functions';
import { db } from '@/lib/db';
import { requireAuthContext, UnauthorizedError } from '@/lib/auth';
import { flows, runBatches, testVariants } from '@flowlens/schema/db';
import { runBatchInline } from '@/lib/run-batch-inline';

const PostBody = z.object({
	variantIds: z.array(z.string().uuid()).optional(),
	parallelism: z.number().int().min(1).max(10).default(5),
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
			return NextResponse.json({ error: `flow not ready (status=${flow.status})` }, { status: 409 });
		}

		const body = PostBody.parse(await req.json().catch(() => ({})));

		// Resolve variants: explicit list, or all enabled for the flow.
		const allVariants = await db.query.testVariants.findMany({
			where: eq(testVariants.flowId, flowId),
		});
		const enabled = allVariants.filter((v) => v.enabled);
		const variantIds = body.variantIds && body.variantIds.length > 0
			? body.variantIds
			: enabled.map((v) => v.id);
		if (variantIds.length === 0) {
			return NextResponse.json(
				{ error: 'no variants to run — generate the matrix first' },
				{ status: 422 },
			);
		}

		const [batch] = await db
			.insert(runBatches)
			.values({
				orgId: auth.org.id,
				flowId,
				triggeredBy: 'user',
				triggeredByUserId: auth.user.id,
				variantIds,
				parallelism: body.parallelism,
				status: 'queued',
			})
			.returning();
		if (!batch) throw new Error('failed to create batch row');

		// Fire-and-forget via waitUntil. Same crash-safety pattern as compile.
		waitUntil(
			runBatchInline({
				batchId: batch.id,
				flowId,
				orgId: auth.org.id,
				variantIds,
			}).catch((err) => {
				console.error('[batch-create] dispatch failed:', err);
			}),
		);

		return NextResponse.json({
			batchId: batch.id,
			variantCount: variantIds.length,
			parallelism: body.parallelism,
			status: 'queued',
		});
	} catch (err) {
		if (err instanceof UnauthorizedError) {
			return NextResponse.json({ error: err.message }, { status: 401 });
		}
		if (err instanceof z.ZodError) {
			return NextResponse.json({ error: 'invalid', issues: err.issues }, { status: 400 });
		}
		console.error('[POST /api/flows/:id/runs/batch]', err);
		return NextResponse.json({ error: (err as Error).message }, { status: 500 });
	}
}
