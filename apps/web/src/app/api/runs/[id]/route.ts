/**
 * GET /api/runs/:id — full run report including step_results.
 *
 * Also returns a thin slice of the parent flow's steps (`flowSteps`) so the
 * side panel can render per-step intent text on the live progress screen
 * without a second round-trip. The side panel polls this endpoint at ~1Hz
 * while a run is in flight.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { eq, asc } from 'drizzle-orm';
import { db } from '@/lib/db';
import { requireAuthContext, UnauthorizedError } from '@/lib/auth';
import { flows, runs, stepResults } from '@flowlens/schema/db';
import type { FlowStep } from '@flowlens/schema';

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
	try {
		const auth = await requireAuthContext();
		const { id } = await ctx.params;
		const run = await db.query.runs.findFirst({ where: eq(runs.id, id) });
		if (!run || run.orgId !== auth.org.id) {
			return NextResponse.json({ error: 'not found' }, { status: 404 });
		}
		const [steps, flow] = await Promise.all([
			db
				.select()
				.from(stepResults)
				.where(eq(stepResults.runId, id))
				.orderBy(asc(stepResults.stepIndex)),
			db.query.flows.findFirst({ where: eq(flows.id, run.flowId) }),
		]);
		const flowSteps = ((flow?.steps as FlowStep[] | undefined) ?? []).map((s) => ({
			index: s.index,
			action: s.action,
			intent: s.intent,
			isCritical: s.isCritical,
		}));
		return NextResponse.json({ run, stepResults: steps, flowSteps });
	} catch (err) {
		if (err instanceof UnauthorizedError) {
			return NextResponse.json({ error: err.message }, { status: 401 });
		}
		console.error('[GET /api/runs/:id]', err);
		return NextResponse.json({ error: (err as Error).message }, { status: 500 });
	}
}
