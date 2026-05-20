/**
 * GET /api/flows/:id/compile-status
 * Lightweight long-poll endpoint for the extension's Compiling screen.
 * Returns the latest in-memory status entry from compile-runner.
 *
 * Phase 3 replaces this with the SSE stream (`/api/runs/:id/stream`) once
 * we move compile into Vercel Workflow.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { eq } from 'drizzle-orm';
import { db } from '@/lib/db';
import { requireAuthContext, UnauthorizedError } from '@/lib/auth';
import { flows } from '@flowlens/schema/db';
import { getCompileStatus } from '@/lib/compile-runner';

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
	try {
		const auth = await requireAuthContext();
		const { id } = await ctx.params;
		const flow = await db.query.flows.findFirst({ where: eq(flows.id, id) });
		if (!flow || flow.orgId !== auth.org.id) {
			return NextResponse.json({ error: 'not found' }, { status: 404 });
		}
		const status = getCompileStatus(id);
		// Phase 4 / UX §1 — pass `recentNarrations` straight through if
		// present. Older callers (Phase 3 panels) just ignore the extra
		// field. New `Compiling.tsx` renders it as a live decoded-steps
		// feed so the user sees the AI working in the open during the
		// narrate stage instead of staring at a step counter.
		return NextResponse.json({
			flowId: id,
			flowStatus: flow.status,
			compile: status ?? { stage: flow.status === 'ready' ? 'done' : 'queued', pct: flow.status === 'ready' ? 100 : 0 },
		});
	} catch (err) {
		if (err instanceof UnauthorizedError) return NextResponse.json({ error: err.message }, { status: 401 });
		console.error('[GET /api/flows/:id/compile-status]', err);
		return NextResponse.json({ error: (err as Error).message }, { status: 500 });
	}
}
