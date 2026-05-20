/**
 * Typed HTTP client for the Python replay worker.
 *
 * Bearer-auth via `REPLAY_WORKER_SHARED_SECRET`. SSE streaming of /run events.
 * Validates every event against the Zod schemas in ./types.
 */
import {
	ReplayWorkerEventSchema,
	ResolveResultSchema,
	type ReplayWorkerEvent,
	type ResolveRequest,
	type ResolveResult,
	type RunRequest,
} from './types';
import { parseSse } from './sse';

export class ReplayWorkerError extends Error {
	constructor(
		public readonly status: number,
		public readonly body: unknown,
		message?: string,
	) {
		super(message ?? `replay-worker error ${status}`);
		this.name = 'ReplayWorkerError';
	}
}

export interface ReplayWorkerClientOptions {
	baseUrl: string;
	sharedSecret: string;
	fetchImpl?: typeof fetch;
	timeoutMs?: number;
}

export class ReplayWorkerClient {
	private readonly baseUrl: string;
	private readonly sharedSecret: string;
	private readonly fetchImpl: typeof fetch;
	private readonly timeoutMs: number;

	constructor(opts: ReplayWorkerClientOptions) {
		this.baseUrl = opts.baseUrl.replace(/\/$/, '');
		this.sharedSecret = opts.sharedSecret;
		this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
		this.timeoutMs = opts.timeoutMs ?? 30_000;
	}

	private headers(extra?: HeadersInit): Headers {
		const h = new Headers(extra);
		h.set('Authorization', `Bearer ${this.sharedSecret}`);
		h.set('Content-Type', 'application/json');
		return h;
	}

	async health(): Promise<{ ok: boolean; version: string; browserUseAvailable: boolean; openaiAvailable: boolean }> {
		const res = await this.fetchImpl(`${this.baseUrl}/healthz`);
		if (!res.ok) throw new ReplayWorkerError(res.status, await res.text());
		return (await res.json()) as { ok: boolean; version: string; browserUseAvailable: boolean; openaiAvailable: boolean };
	}

	async resolve(req: ResolveRequest): Promise<ResolveResult> {
		const res = await this.fetchImpl(`${this.baseUrl}/resolve`, {
			method: 'POST',
			headers: this.headers(),
			body: JSON.stringify(req),
		});
		if (!res.ok) throw new ReplayWorkerError(res.status, await res.text());
		const json = await res.json();
		return ResolveResultSchema.parse(json);
	}

	/**
	 * Stream `/run` events. Yields only well-formed events; malformed events
	 * are logged and skipped (worker bug, but we don't want to halt the run).
	 *
	 * The caller is responsible for breaking out of the loop on `run_complete`
	 * or `run_paused`. We don't auto-close.
	 */
	async *streamRun(req: RunRequest): AsyncGenerator<ReplayWorkerEvent> {
		const res = await this.fetchImpl(`${this.baseUrl}/run`, {
			method: 'POST',
			headers: this.headers({ Accept: 'text/event-stream' }),
			body: JSON.stringify(req),
		});
		if (!res.ok || !res.body) {
			throw new ReplayWorkerError(res.status, await res.text());
		}

		for await (const chunk of parseSse(res.body)) {
			let payload: unknown;
			try {
				payload = JSON.parse(chunk.data);
			} catch (err) {
				console.warn('[replay-engine] skipping non-JSON SSE chunk', err);
				continue;
			}
			const parsed = ReplayWorkerEventSchema.safeParse(payload);
			if (!parsed.success) {
				console.warn('[replay-engine] schema mismatch on worker event', parsed.error.flatten());
				continue;
			}
			yield parsed.data;
		}
	}
}

export function createReplayWorkerClient(): ReplayWorkerClient {
	const baseUrl = process.env.REPLAY_WORKER_URL;
	const sharedSecret = process.env.REPLAY_WORKER_SHARED_SECRET;
	if (!baseUrl) throw new Error('REPLAY_WORKER_URL env var is required');
	if (!sharedSecret) throw new Error('REPLAY_WORKER_SHARED_SECRET env var is required');
	return new ReplayWorkerClient({ baseUrl, sharedSecret });
}
