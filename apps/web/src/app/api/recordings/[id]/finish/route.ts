/**
 * POST /api/recordings/:id/finish
 *
 * Finalizes a recording:
 *   1. Persists the encrypted cookie + storage snapshot.
 *   2. Saves the action stream as a single blob (NDJSON).
 *   3. Marks the flow `compiling`.
 *   4. Triggers the compile pipeline (in-process for now; LLD §5 calls out
 *      Vercel Workflow as the eventual home).
 *
 * Returns immediately after queuing compile so the extension can poll
 * `/api/flows/:id/compile-status` (Phase 2.1) or subscribe via SSE.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import {
	RecordingFinishPayloadSchema,
	type RecordingFinishPayload,
} from '@flowlens/schema';
import { db } from '@/lib/db';
import { requireAuthContext, UnauthorizedError } from '@/lib/auth';
import { recordings, flows, cookieSnapshots } from '@flowlens/schema/db';
import { blobKeys, putBlob } from '@/lib/blob';
import {
	sealForOrg,
	hashAuthDomains,
	earliestCookieExpiry,
} from '@flowlens/cookies-vault';
import { waitUntil } from '@vercel/functions';
import { runCompileInline } from '@/lib/compile-inline';

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
	try {
		const auth = await requireAuthContext();
		const { id: recordingId } = await ctx.params;

		const rec = await db.query.recordings.findFirst({ where: eq(recordings.id, recordingId) });
		if (!rec) return NextResponse.json({ error: 'recording not found' }, { status: 404 });
		const flow = await db.query.flows.findFirst({ where: eq(flows.id, rec.flowId) });
		if (!flow || flow.orgId !== auth.org.id) {
			return NextResponse.json({ error: 'recording not in your org' }, { status: 403 });
		}

		const json = (await req.json()) as unknown;
		const body = RecordingFinishPayloadSchema.parse(json) satisfies RecordingFinishPayload;

		// Encrypt + persist cookie snapshot.
		const vaultSecret = process.env.FLOWLENS_VAULT_SECRET ?? '';
		if (!vaultSecret) {
			return NextResponse.json({ error: 'FLOWLENS_VAULT_SECRET not configured' }, { status: 500 });
		}
		const sealed = await sealForOrg({
			orgId: auth.org.id,
			vaultSecret,
			plaintext: JSON.stringify({ cookies: body.cookies, storage: body.storage }),
		});
		const { domains, hasAuthCookie } = hashAuthDomains(body.cookies);
		const earliestExpiry = earliestCookieExpiry(body.cookies);
		const [snap] = await db
			.insert(cookieSnapshots)
			.values({
				orgId: auth.org.id,
				siteId: flow.siteId,
				capturedByUserId: auth.user.id,
				origin: body.origins[0] ?? 'unknown://',
				ciphertext: sealed.ciphertext,
				nonce: sealed.nonce,
				cookieDomains: domains,
				hasAuthCookie,
				...(earliestExpiry ? { expiresAtHint: earliestExpiry } : {}),
			})
			.returning();
		if (!snap) throw new Error('Failed to persist cookie snapshot');

		// Persist the action stream as a single NDJSON blob.
		const ndjson = body.actions.map((a) => JSON.stringify(a)).join('\n') + '\n';
		const actionStreamKey = blobKeys.actionStream(recordingId);
		await putBlob(actionStreamKey, ndjson, 'application/x-ndjson');

		await db
			.update(recordings)
			.set({ finishedAt: new Date(), actionStreamBlobKey: actionStreamKey })
			.where(eq(recordings.id, recordingId));

		// Mark flow as compiling and link the cookie snapshot.
		await db
			.update(flows)
			.set({ status: 'compiling', cookieSnapshotId: snap.id, updatedAt: new Date() })
			.where(eq(flows.id, flow.id));

		// Compile inline via `waitUntil` — keeps the async work alive after
		// we send the response. Vercel terminates plain fire-and-forget
		// promises once the function returns; `waitUntil` is the official
		// supported way to extend the lifetime up to the function's max
		// duration (60s Hobby / 300s Pro), which is well above our
		// 5-15s typical compile budget.
		//
		// We previously dispatched to a durable Vercel Workflow
		// (`start(compileRecordingWorkflow, ...)`) but the
		// `.well-known/workflow/v1/*` routes return 404 on this deploy —
		// the WDK functions are built but the edge isn't routing to them,
		// so the workflow handler never executes and flows got stuck at
		// `compiling`. Until that routing issue is isolated, run the same
		// pipeline inline.
		waitUntil(
			runCompileInline({
				flowId: flow.id,
				recordingId,
				orgId: auth.org.id,
			}).catch((err) => {
				// runCompileInline already logs + marks the flow row on
				// failure; this catch just prevents an unhandled-rejection
				// from killing the function.
				console.error('[recordings/finish] compile dispatch failed:', err);
			}),
		);

		return NextResponse.json({
			flowId: flow.id,
			recordingId,
			cookieSnapshotId: snap.id,
			status: 'compiling',
		});
	} catch (err) {
		if (err instanceof UnauthorizedError) return NextResponse.json({ error: err.message }, { status: 401 });
		if (err instanceof z.ZodError) return NextResponse.json({ error: 'invalid payload', issues: err.issues }, { status: 400 });
		console.error('[POST /api/recordings/:id/finish]', err);
		return NextResponse.json({ error: (err as Error).message }, { status: 500 });
	}
}
