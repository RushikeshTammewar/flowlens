/**
 * POST /api/flows/:id/runs — start a new run for the given flow.
 *
 * Returns immediately after enqueueing the run; the side panel polls
 * `/api/runs/:id` for progress (step results land in the DB as the
 * sidecar streams `step_finished` events).
 *
 * Why inline (not Vercel Workflow): the WDK `.well-known/workflow/v1/*`
 * routes return 404 on this Vercel project even though the functions are
 * built. Same fallback the matrix runner uses (`runBatchInline`).
 */
import { NextResponse, type NextRequest } from 'next/server';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { waitUntil } from '@vercel/functions';
import { db } from '@/lib/db';
import { requireAuthContext, UnauthorizedError } from '@/lib/auth';
import { flows, runs } from '@flowlens/schema/db';
import {
	BudgetExceededError,
	CircuitOpenError,
	assertBuCloudCircuit,
	reserveRunBudget,
} from '@/lib/budget';
import { runSingleInline } from '@/lib/run-single-inline';

const StartRunRequestSchema = z.object({
	mode: z.enum(['hybrid', 'fast', 'full_llm']).default('hybrid'),
});

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
	try {
		const auth = await requireAuthContext();
		const { id: flowId } = await ctx.params;
		const flow = await db.query.flows.findFirst({ where: eq(flows.id, flowId) });
		if (!flow || flow.orgId !== auth.org.id) {
			return NextResponse.json({ error: 'not found' }, { status: 404 });
		}
		if (flow.status !== 'ready') {
			return NextResponse.json({ error: `flow not ready (status=${flow.status})` }, { status: 409 });
		}

		const body = StartRunRequestSchema.parse(await req.json().catch(() => ({})));
		await assertBuCloudCircuit();
		await reserveRunBudget(auth.org.id);

		const [run] = await db
			.insert(runs)
			.values({
				orgId: auth.org.id,
				flowId,
				triggeredBy: 'user',
				triggeredByUserId: auth.user.id,
				status: 'queued',
			})
			.returning();
		if (!run) throw new Error('failed to insert run');

		// Fire-and-forget via waitUntil. Same crash-safety pattern as compile
		// and matrix-batch. The runner streams `/run` SSE from the sidecar
		// and writes step_results rows as each step finishes.
		waitUntil(
			runSingleInline({
				runId: run.id,
				flowId,
				orgId: auth.org.id,
				mode: body.mode,
			}).catch((err) => {
				console.error('[POST /api/flows/:id/runs] inline dispatch failed:', err);
			}),
		);

		return NextResponse.json({ runId: run.id, status: 'queued' });
	} catch (err) {
		if (err instanceof UnauthorizedError) {
			return NextResponse.json({ error: err.message }, { status: 401 });
		}
		if (err instanceof BudgetExceededError) {
			return NextResponse.json({ error: 'monthly run budget exhausted' }, { status: 402 });
		}
		if (err instanceof CircuitOpenError) {
			return NextResponse.json({ error: 'BU Cloud account low — pause runs' }, { status: 503 });
		}
		if (err instanceof z.ZodError) {
			return NextResponse.json({ error: 'invalid', issues: err.issues }, { status: 400 });
		}
		console.error('[POST /api/flows/:id/runs]', err);
		return NextResponse.json({ error: (err as Error).message }, { status: 500 });
	}
}
