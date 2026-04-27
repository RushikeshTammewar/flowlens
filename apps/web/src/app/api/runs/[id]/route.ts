/**
 * GET /api/runs/:id — full run report including step_results.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { eq, asc } from 'drizzle-orm';
import { db } from '@/lib/db';
import { requireAuthContext, UnauthorizedError } from '@/lib/auth';
import { runs, stepResults } from '@flowlens/schema/db';

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
	try {
		const auth = await requireAuthContext();
		const { id } = await ctx.params;
		const run = await db.query.runs.findFirst({ where: eq(runs.id, id) });
		if (!run || run.orgId !== auth.org.id) {
			return NextResponse.json({ error: 'not found' }, { status: 404 });
		}
		const steps = await db
			.select()
			.from(stepResults)
			.where(eq(stepResults.runId, id))
			.orderBy(asc(stepResults.stepIndex));
		return NextResponse.json({ run, stepResults: steps });
	} catch (err) {
		if (err instanceof UnauthorizedError) {
			return NextResponse.json({ error: err.message }, { status: 401 });
		}
		console.error('[GET /api/runs/:id]', err);
		return NextResponse.json({ error: (err as Error).message }, { status: 500 });
	}
}
