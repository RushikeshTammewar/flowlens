/**
 * Vercel Blob helpers. Wraps `@vercel/blob` so we centralize key naming + content
 * type defaults. Phase 2: rrweb chunks (gzipped NDJSON), screenshots (webp/png),
 * action stream (NDJSON).
 */
import { put, type PutCommandOptions } from '@vercel/blob';

const BUCKET_PREFIX = 'recordings';

export const blobKeys = {
	rrwebChunk: (recordingId: string, ordinal: number) =>
		`${BUCKET_PREFIX}/${recordingId}/rrweb/${String(ordinal).padStart(6, '0')}.ndjson.gz`,
	screenshot: (recordingId: string, actionIndex: number) =>
		`${BUCKET_PREFIX}/${recordingId}/screenshots/${String(actionIndex).padStart(4, '0')}.webp`,
	actionStream: (recordingId: string) => `${BUCKET_PREFIX}/${recordingId}/actions.ndjson`,
};

export async function putBlob(
	key: string,
	body: Blob | ArrayBuffer | Uint8Array | string,
	contentType: string,
	options?: PutCommandOptions,
): Promise<{ url: string; size: number }> {
	const wrapped: Blob | ArrayBuffer | string =
		body instanceof Uint8Array ? new Blob([body as BlobPart], { type: contentType }) : body;
	const result = await put(key, wrapped, {
		access: 'public',
		contentType,
		addRandomSuffix: false,
		...options,
	});
	return { url: result.url, size: bytesOf(body) };
}

function bytesOf(body: Blob | ArrayBuffer | Uint8Array | string): number {
	if (typeof body === 'string') return new TextEncoder().encode(body).byteLength;
	if (body instanceof ArrayBuffer) return body.byteLength;
	if (body instanceof Uint8Array) return body.byteLength;
	return body.size;
}
