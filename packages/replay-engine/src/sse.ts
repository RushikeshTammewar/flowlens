/**
 * Minimal Server-Sent Events parser. Used to consume `/run`'s stream from
 * Node (server-side, inside a Vercel Workflow step). The browser's native
 * EventSource doesn't support custom headers, so we use a fetch + text
 * stream parser instead.
 */
export interface SseChunk {
	event?: string;
	data: string;
	id?: string;
}

export async function* parseSse(stream: ReadableStream<Uint8Array>): AsyncGenerator<SseChunk> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let buffer = '';
	try {
		while (true) {
			const { value, done } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			let separator = buffer.indexOf('\n\n');
			while (separator !== -1) {
				const rawEvent = buffer.slice(0, separator);
				buffer = buffer.slice(separator + 2);
				const parsed = parseEvent(rawEvent);
				if (parsed) yield parsed;
				separator = buffer.indexOf('\n\n');
			}
		}
		// Flush any trailing event.
		if (buffer.length > 0) {
			const parsed = parseEvent(buffer);
			if (parsed) yield parsed;
		}
	} finally {
		reader.releaseLock();
	}
}

function parseEvent(raw: string): SseChunk | null {
	const lines = raw.split('\n');
	let event: string | undefined;
	let id: string | undefined;
	const dataLines: string[] = [];
	for (const line of lines) {
		if (line.startsWith(':')) continue; // comment / heartbeat
		if (line.startsWith('event:')) event = line.slice('event:'.length).trim();
		else if (line.startsWith('id:')) id = line.slice('id:'.length).trim();
		else if (line.startsWith('data:')) dataLines.push(line.slice('data:'.length).trim());
	}
	if (dataLines.length === 0) return null;
	return {
		...(event !== undefined ? { event } : {}),
		...(id !== undefined ? { id } : {}),
		data: dataLines.join('\n'),
	};
}
