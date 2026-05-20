/**
 * GET    /api/flows/:id   — fetch a single flow (org-scoped) + enrichment
 * DELETE /api/flows/:id   — soft-delete (status = 'archived')
 * PATCH  /api/flows/:id   — limited edits: name, description, steps[].intent/expected/isCritical
 *
 * Enrichment performed by GET (none of these touch the persisted row):
 *   1. Each step gets `recordedScreenshotUrl` derived from the canonical
 *      blob path so the side panel doesn't need to know the blob base URL.
 *      Falls back to the canonical key when `step.recordedScreenshotKey`
 *      is empty (legacy flows compiled before the post-processor landed).
 *   2. The flow's most recent recording's `cookie_snapshots` row is
 *      summarized (count + auth flag + origin). Lets the side panel show
 *      "cookies captured · N (encrypted) · auth detected" without a
 *      second round-trip and without leaking ciphertext.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { eq, desc } from 'drizzle-orm';
import { FlowStepSchema } from '@flowlens/schema';
import type { FlowStep } from '@flowlens/schema';
import { db } from '@/lib/db';
import { requireAuthContext, UnauthorizedError } from '@/lib/auth';
import { flows, recordings, cookieSnapshots } from '@flowlens/schema/db';
import { blobKeys } from '@/lib/blob';

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
	try {
		const auth = await requireAuthContext();
		const { id } = await ctx.params;
		const flow = await db.query.flows.findFirst({ where: eq(flows.id, id) });
		if (!flow || flow.orgId !== auth.org.id) {
			return NextResponse.json({ error: 'not found' }, { status: 404 });
		}

		const blobBase = process.env.BLOB_PUBLIC_BASE_URL ?? '';
		const recording = await db.query.recordings.findFirst({
			where: eq(recordings.flowId, flow.id),
			orderBy: [desc(recordings.startedAt)],
		});

		const enrichedSteps = (flow.steps as FlowStep[]).map((s) => {
			if (!blobBase) return s;
			const stamped = s.recordedScreenshotKey;
			if (stamped) {
				return { ...s, recordedScreenshotUrl: `${blobBase}/${stamped}` };
			}
			if (recording?.id) {
				const fallback = blobKeys.screenshot(recording.id, s.index);
				return {
					...s,
					recordedScreenshotKey: fallback,
					recordedScreenshotUrl: `${blobBase}/${fallback}`,
				};
			}
			return s;
		});

		let cookieSnapshot: {
			cookieCount: number;
			authDetected: boolean;
			origin: string | null;
		} | null = null;
		if (flow.cookieSnapshotId) {
			const snap = await db.query.cookieSnapshots.findFirst({
				where: eq(cookieSnapshots.id, flow.cookieSnapshotId),
			});
			if (snap) {
				cookieSnapshot = {
					cookieCount: Array.isArray(snap.cookieDomains) ? snap.cookieDomains.length : 0,
					authDetected: Boolean(snap.hasAuthCookie),
					origin: snap.origin ?? null,
				};
			}
		}

		return NextResponse.json({
			flow: { ...flow, steps: enrichedSteps, cookieSnapshot },
		});
	} catch (err) {
		if (err instanceof UnauthorizedError) return NextResponse.json({ error: err.message }, { status: 401 });
		console.error('[GET /api/flows/:id]', err);
		return NextResponse.json({ error: (err as Error).message }, { status: 500 });
	}
}

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
	try {
		const auth = await requireAuthContext();
		const { id } = await ctx.params;
		const existing = await db.query.flows.findFirst({ where: eq(flows.id, id) });
		if (!existing || existing.orgId !== auth.org.id) {
			return NextResponse.json({ error: 'not found' }, { status: 404 });
		}
		await db.update(flows).set({ status: 'archived', updatedAt: new Date() }).where(eq(flows.id, id));
		return NextResponse.json({ ok: true });
	} catch (err) {
		if (err instanceof UnauthorizedError) return NextResponse.json({ error: err.message }, { status: 401 });
		console.error('[DELETE /api/flows/:id]', err);
		return NextResponse.json({ error: (err as Error).message }, { status: 500 });
	}
}

const PatchSchema = z.object({
	name: z.string().min(1).max(200).optional(),
	description: z.string().max(400).nullable().optional(),
	steps: z.array(FlowStepSchema).optional(),
});

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
	try {
		const auth = await requireAuthContext();
		const { id } = await ctx.params;
		const existing = await db.query.flows.findFirst({ where: eq(flows.id, id) });
		if (!existing || existing.orgId !== auth.org.id) {
			return NextResponse.json({ error: 'not found' }, { status: 404 });
		}
		const body = PatchSchema.parse(await req.json());
		await db
			.update(flows)
			.set({
				...(body.name !== undefined ? { name: body.name } : {}),
				...(body.description !== undefined ? { description: body.description } : {}),
				...(body.steps !== undefined ? { steps: body.steps } : {}),
				updatedAt: new Date(),
			})
			.where(eq(flows.id, id));
		return NextResponse.json({ ok: true });
	} catch (err) {
		if (err instanceof UnauthorizedError) return NextResponse.json({ error: err.message }, { status: 401 });
		if (err instanceof z.ZodError) return NextResponse.json({ error: 'invalid', issues: err.issues }, { status: 400 });
		console.error('[PATCH /api/flows/:id]', err);
		return NextResponse.json({ error: (err as Error).message }, { status: 500 });
	}
}
