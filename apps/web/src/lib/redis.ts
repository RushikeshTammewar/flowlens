/**
 * Upstash Redis client. Used for SSE event log + per-org concurrency locks.
 *
 * Falls back to an in-memory shim when env vars are missing so local dev
 * doesn't require a Redis instance for compile-only testing. The shim is
 * NOT thread-safe across function instances; production needs the real one.
 */
import { Redis } from '@upstash/redis';

declare global {
	// eslint-disable-next-line no-var
	var __flowlensRedis: Redis | InMemoryRedisShim | undefined;
}

interface InMemoryRedisShim {
	get(key: string): Promise<string | null>;
	set(key: string, value: string, opts?: { ex?: number }): Promise<'OK'>;
	lpush(key: string, ...values: string[]): Promise<number>;
	lrange(key: string, start: number, stop: number): Promise<string[]>;
	expire(key: string, seconds: number): Promise<number>;
	publish(channel: string, message: string): Promise<number>;
}

function makeShim(): InMemoryRedisShim {
	const store = new Map<string, { value: string | string[]; expiresAt: number | null }>();
	return {
		async get(key) {
			const e = store.get(key);
			if (!e) return null;
			if (e.expiresAt && Date.now() > e.expiresAt) {
				store.delete(key);
				return null;
			}
			return typeof e.value === 'string' ? e.value : null;
		},
		async set(key, value, opts) {
			store.set(key, { value, expiresAt: opts?.ex ? Date.now() + opts.ex * 1000 : null });
			return 'OK';
		},
		async lpush(key, ...values) {
			const cur = store.get(key);
			const list = cur && Array.isArray(cur.value) ? cur.value : [];
			list.unshift(...values);
			store.set(key, { value: list, expiresAt: null });
			return list.length;
		},
		async lrange(key, start, stop) {
			const cur = store.get(key);
			if (!cur || !Array.isArray(cur.value)) return [];
			return cur.value.slice(start, stop === -1 ? undefined : stop + 1);
		},
		async expire(key, seconds) {
			const cur = store.get(key);
			if (!cur) return 0;
			cur.expiresAt = Date.now() + seconds * 1000;
			return 1;
		},
		async publish() {
			return 0; // no-op shim — only useful for in-process tests
		},
	};
}

export function getRedis(): Redis | InMemoryRedisShim {
	if (globalThis.__flowlensRedis) return globalThis.__flowlensRedis;
	// Vercel's Marketplace KV/Upstash integration provisions KV_REST_API_* names.
	// Local dev / non-Vercel deploys may use the upstream UPSTASH_REDIS_REST_* names.
	// Accept both so production on Vercel doesn't silently fall through to the shim.
	const url = process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL;
	const token = process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;
	const client: Redis | InMemoryRedisShim =
		url && token ? new Redis({ url, token }) : makeShim();
	globalThis.__flowlensRedis = client;
	return client;
}

export const sseEventLogKey = (subject: string) => `sse:log:${subject}`;
export const SSE_LOG_TTL_SECONDS = 3600;

export async function appendSseEvent(subject: string, payload: string): Promise<void> {
	const r = getRedis();
	const key = sseEventLogKey(subject);
	await r.lpush(key, payload);
	await r.expire(key, SSE_LOG_TTL_SECONDS);
}

export async function readSseEventsAfter(
	subject: string,
	lastEventId: string | null,
): Promise<string[]> {
	const r = getRedis();
	const all = await r.lrange(sseEventLogKey(subject), 0, -1);
	if (!lastEventId) return all.reverse();
	const idx = all.findIndex((e) => e.includes(`"id":"${lastEventId}"`));
	if (idx === -1) return all.reverse();
	return all.slice(0, idx).reverse();
}
