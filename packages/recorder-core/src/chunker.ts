/**
 * NDJSON gzip chunker. Buffers rrweb events as JSON lines, flushes once size
 * threshold or interval is hit, gzips with `CompressionStream`, hands the
 * resulting bytes to `onChunk` with a monotonically increasing ordinal.
 *
 * Used by recorder-core/record.ts. Browser-safe (no Node Buffer).
 */
export interface ChunkEmitted {
	ordinal: number;
	gzipped: Uint8Array;
	bytes: number;
}

export interface NdjsonChunker {
	push: (obj: unknown) => void;
	/** Flush even if buffer is below threshold (e.g. final stop). */
	flushFinal: () => Promise<void>;
}

export interface ChunkerOptions {
	chunkBytes: number;
	flushEveryMs: number;
	onChunk: (chunk: ChunkEmitted) => void;
}

export function createNdjsonChunker(opts: ChunkerOptions): NdjsonChunker {
	let buffer: string[] = [];
	let bufferBytes = 0;
	let ordinal = 0;
	let flushing = false;
	const encoder = new TextEncoder();

	const flush = async (): Promise<void> => {
		if (flushing) return;
		if (buffer.length === 0) return;
		flushing = true;
		try {
			const lines = buffer.join('');
			buffer = [];
			bufferBytes = 0;
			const bytes = encoder.encode(lines);
			const gzipped = await gzipBytes(bytes);
			opts.onChunk({ ordinal: ordinal++, gzipped, bytes: bytes.byteLength });
		} finally {
			flushing = false;
		}
	};

	const interval = setInterval(() => {
		void flush();
	}, opts.flushEveryMs);

	return {
		push: (obj) => {
			const line = JSON.stringify(obj) + '\n';
			buffer.push(line);
			bufferBytes += line.length;
			if (bufferBytes >= opts.chunkBytes) {
				void flush();
			}
		},
		flushFinal: async () => {
			clearInterval(interval);
			await flush();
		},
	};
}

async function gzipBytes(input: Uint8Array): Promise<Uint8Array> {
	// Cast to BufferSource keeps us happy with both ArrayBuffer- and
	// SharedArrayBuffer-backed Uint8Array typings.
	const blob = new Blob([input as BlobPart]);
	const stream = blob.stream().pipeThrough(new CompressionStream('gzip'));
	const compressed = await new Response(stream).arrayBuffer();
	return new Uint8Array(compressed);
}
