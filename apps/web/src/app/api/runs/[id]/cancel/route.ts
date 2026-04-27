/**
 * POST /api/runs/:id/cancel — cancel + stop BU session.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { eq } from 'drizzle-orm';
import { db } from '@/lib/db';
import { requireAuthContext, UnauthorizedError } from '@/lib/auth';
import { runs } from '@flowlens/schema/db';
import { createBuClient } from '@flowlens/bu-cloud-client';
import { emitSseEvent } from '@/lib/sse-bus';

export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
	try {
		const auth = await requireAuthContext();
		const { id } = await ctx.params;
		const run = await db.query.runs.findFirst({ where: eq(runs.id, id) });
		if (!run || run.orgId !== auth.org.id) {
			return NextResponse.json({ error: 'not found' }, { status: 404 });
		}
		if (run.buSessionId && process.env.BROWSER_USE_API_KEY) {
			try {
				const bu = createBuClient();
				await bu.stopBrowserSession(run.buSessionId);
			} catch {
				// non-fatal — BU Cloud auto-stops eventually
			}
		}
		await db
			.update(runs)
			.set({ status: 'canceled', finishedAt: new Date(), summary: 'canceled by user' })
			.where(eq(runs.id, id));
		await emitSseEvent(`run:${id}`, {
			type: 'run_complete',
			runId: id,
			status: 'canceled',
			healthScore: null,
		});
		return NextResponse.json({ ok: true });
	} catch (err) {
		if (err instanceof UnauthorizedError) {
			return NextResponse.json({ error: err.message }, { status: 401 });
		}
		return NextResponse.json({ error: (err as Error).message }, { status: 500 });
	}
}
