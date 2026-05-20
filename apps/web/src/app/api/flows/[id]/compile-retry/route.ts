/**
 * POST /api/flows/:id/compile-retry — kick off compile again for a flow that
 * got stuck at `compiling` (e.g. the Vercel Workflow runtime dropped the
 * dispatch, or the function instance died mid-run).
 *
 * Idempotent: looks up the most recent recording for the flow and re-runs
 * `runCompileInline` with the same inputs. The DB write at end-of-pipeline
 * flips status from `compiling` → `ready` regardless of how many times we run.
 */
import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { waitUntil } from '@vercel/functions';
import { db } from '@/lib/db';
import { recordings, flows } from '@flowlens/schema/db';
import { requireAuthContext, UnauthorizedError } from '@/lib/auth';
import { runCompileInline } from '@/lib/compile-inline';

export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
	try {
		const auth = await requireAuthContext();
		const { id: flowId } = await ctx.params;

		const flow = await db.query.flows.findFirst({ where: eq(flows.id, flowId) });
		if (!flow) return NextResponse.json({ error: 'flow not found' }, { status: 404 });
		if (flow.orgId !== auth.org.id) {
			return NextResponse.json({ error: 'flow not in your org' }, { status: 403 });
		}

		// Pick the latest finished recording for this flow.
		const rec = await db.query.recordings.findFirst({
			where: eq(recordings.flowId, flowId),
			orderBy: (r, { desc }) => [desc(r.startedAt)],
		});
		if (!rec) {
			return NextResponse.json({ error: 'no recording found for flow' }, { status: 404 });
		}
		if (!rec.actionStreamBlobKey) {
			return NextResponse.json(
				{ error: 'recording has no action stream — record again' },
				{ status: 422 },
			);
		}

		// Reset to `compiling` so the extension's status poll sees progress.
		await db
			.update(flows)
			.set({ status: 'compiling', updatedAt: new Date() })
			.where(eq(flows.id, flowId));

		// `waitUntil` extends the function's lifetime past response so the
		// inline compile actually runs to completion. Plain fire-and-forget
		// gets terminated by Vercel as soon as we return.
		waitUntil(
			runCompileInline({
				flowId,
				recordingId: rec.id,
				orgId: auth.org.id,
			}).catch((err) => {
				console.error('[compile-retry] dispatch failed:', err);
			}),
		);

		return NextResponse.json(
			{ ok: true, flowId, recordingId: rec.id, status: 'compiling' },
			{ status: 202 },
		);
	} catch (err) {
		if (err instanceof UnauthorizedError) {
			return NextResponse.json({ error: err.message }, { status: 401 });
		}
		console.error('[POST /api/flows/:id/compile-retry]', err);
		return NextResponse.json({ error: (err as Error).message }, { status: 500 });
	}
}
