/**
 * PUT /api/recordings/:id/chunks
 *
 * Accepts a multipart/form-data upload: one rrweb chunk (gzipped NDJSON)
 * and any number of screenshots captured since the previous chunk.
 *
 * Form fields:
 *   - ordinal: number (required)
 *   - rrweb: File (gzipped NDJSON)
 *   - screenshot.<actionIndex>: File (image/webp or image/png)  [0..n]
 */
import { NextResponse, type NextRequest } from 'next/server';
import { eq } from 'drizzle-orm';
import { db } from '@/lib/db';
import { requireAuthContext, UnauthorizedError } from '@/lib/auth';
import { recordings, flows } from '@flowlens/schema/db';
import { blobKeys, putBlob } from '@/lib/blob';

export async function PUT(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
	try {
		const auth = await requireAuthContext();
		const { id: recordingId } = await ctx.params;

		// Verify the recording belongs to the caller's org.
		const rec = await db.query.recordings.findFirst({ where: eq(recordings.id, recordingId) });
		if (!rec) return NextResponse.json({ error: 'recording not found' }, { status: 404 });
		const flow = await db.query.flows.findFirst({ where: eq(flows.id, rec.flowId) });
		if (!flow || flow.orgId !== auth.org.id) {
			return NextResponse.json({ error: 'recording not in your org' }, { status: 403 });
		}

		const form = await req.formData();
		const ordinalRaw = form.get('ordinal');
		if (typeof ordinalRaw !== 'string') {
			return NextResponse.json({ error: 'ordinal is required' }, { status: 400 });
		}
		const ordinal = Number.parseInt(ordinalRaw, 10);
		if (!Number.isInteger(ordinal) || ordinal < 0) {
			return NextResponse.json({ error: 'ordinal must be a non-negative integer' }, { status: 400 });
		}

		const rrwebFile = form.get('rrweb');
		let rrwebStored: { blobKey: string; bytes: number; ordinal: number } | null = null;
		if (rrwebFile instanceof Blob) {
			const key = blobKeys.rrwebChunk(recordingId, ordinal);
			const bytes = await rrwebFile.arrayBuffer();
			await putBlob(key, bytes, 'application/octet-stream');
			rrwebStored = { blobKey: key, bytes: bytes.byteLength, ordinal };
		}

		const screenshotsStored: Array<{ actionIndex: number; blobKey: string; bytes: number }> = [];
		for (const [name, value] of form.entries()) {
			if (!(value instanceof Blob)) continue;
			if (!name.startsWith('screenshot.')) continue;
			const actionIndex = Number.parseInt(name.slice('screenshot.'.length), 10);
			if (!Number.isInteger(actionIndex) || actionIndex < 0) continue;
			const key = blobKeys.screenshot(recordingId, actionIndex);
			const bytes = await value.arrayBuffer();
			await putBlob(key, bytes, value.type || 'image/webp');
			screenshotsStored.push({ actionIndex, blobKey: key, bytes: bytes.byteLength });
		}

		// Append the rrweb chunk meta to the recording row.
		if (rrwebStored) {
			const updatedChunks = [...rec.rrwebChunks, rrwebStored];
			await db.update(recordings).set({ rrwebChunks: updatedChunks }).where(eq(recordings.id, recordingId));
		}

		return NextResponse.json({
			ordinal,
			bytesStored: rrwebStored?.bytes ?? 0,
			screenshotsStored: screenshotsStored.length,
		});
	} catch (err) {
		if (err instanceof UnauthorizedError) return NextResponse.json({ error: err.message }, { status: 401 });
		console.error('[PUT /api/recordings/:id/chunks]', err);
		return NextResponse.json({ error: (err as Error).message }, { status: 500 });
	}
}
