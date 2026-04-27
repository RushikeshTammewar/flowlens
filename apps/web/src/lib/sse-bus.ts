/**
 * SSE event bus for `/api/runs/:id/stream` and `/api/flows/:id/compile-status`.
 *
 * Persists events to Upstash with TTL 1h so reconnecting clients can replay
 * via `Last-Event-ID`. Also publishes via Redis pubsub for active streams.
 */
import { appendSseEvent, getRedis } from './redis';

export interface SseEvent {
	type: string;
	[key: string]: unknown;
}

const SSE_EVENT_LIMIT_PER_SUBJECT = 1024;

/**
 * Emit an event for a subject (e.g. a runId or flowId). Stores in Redis +
 * publishes to active streams. Caller is responsible for the event shape.
 */
export async function emitSseEvent(subject: string, event: SseEvent): Promise<void> {
	const id = crypto.randomUUID();
	const payload = JSON.stringify({ id, ...event });
	await appendSseEvent(subject, payload);
	const r = getRedis();
	if ('publish' in r) {
		await r.publish(`sse:${subject}`, payload);
	}
}

export async function pruneOldEvents(subject: string): Promise<void> {
	const r = getRedis();
	const len = await (r as unknown as { llen?: (k: string) => Promise<number> }).llen?.(`sse:log:${subject}`);
	if (typeof len === 'number' && len > SSE_EVENT_LIMIT_PER_SUBJECT) {
		// Best-effort prune; not critical for correctness because TTL also bounds.
		await (r as unknown as { ltrim?: (k: string, s: number, e: number) => Promise<unknown> }).ltrim?.(
			`sse:log:${subject}`,
			0,
			SSE_EVENT_LIMIT_PER_SUBJECT - 1,
		);
	}
}
