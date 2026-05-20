/**
 * POST /api/runs/:id/resume — resume a paused run.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { eq } from 'drizzle-orm';
import { db } from '@/lib/db';
import { requireAuthContext, UnauthorizedError } from '@/lib/auth';
import { runs } from '@flowlens/schema/db';
import { emitSseEvent } from '@/lib/sse-bus';

export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
	try {
		const auth = await requireAuthContext();
		const { id } = await ctx.params;
		const run = await db.query.runs.findFirst({ where: eq(runs.id, id) });
		if (!run || run.orgId !== auth.org.id) {
			return NextResponse.json({ error: 'not found' }, { status: 404 });
		}
		if (run.status !== 'paused_user' && run.status !== 'paused_auth') {
			return NextResponse.json({ error: `run not paused (status=${run.status})` }, { status: 409 });
		}
		await db.update(runs).set({ status: 'running' }).where(eq(runs.id, id));
		await emitSseEvent(`run:${id}`, { type: 'run_resumed', runId: id });
		// The actual workflow resume happens via `step.waitFor` upstream which
		// listens for `run-${runId}-auth-refreshed`; for user-pause we'd send a
		// different signal. Phase 4 wires both.
		return NextResponse.json({ ok: true });
	} catch (err) {
		if (err instanceof UnauthorizedError) {
			return NextResponse.json({ error: err.message }, { status: 401 });
		}
		return NextResponse.json({ error: (err as Error).message }, { status: 500 });
	}
}
