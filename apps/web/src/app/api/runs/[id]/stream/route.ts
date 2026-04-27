/**
 * GET /api/runs/:id/stream — SSE live progress.
 *
 * Replays from Redis-backed event log on `Last-Event-ID`. Heartbeats every 15s.
 * Auth: query param `token` (extensions can't set Auth headers on EventSource)
 * OR standard Bearer. Org-scoped via the run row.
 */
import { type NextRequest } from 'next/server';
import { eq } from 'drizzle-orm';
import { db } from '@/lib/db';
import { requireAuthContext, UnauthorizedError } from '@/lib/auth';
import { runs } from '@flowlens/schema/db';
import { readSseEventsAfter } from '@/lib/redis';

const HEARTBEAT_MS = 15_000;

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
	let auth: Awaited<ReturnType<typeof requireAuthContext>>;
	try {
		auth = await requireAuthContext();
	} catch (err) {
		if (err instanceof UnauthorizedError) {
			return new Response(err.message, { status: 401 });
		}
		throw err;
	}
	const { id: runId } = await ctx.params;
	const run = await db.query.runs.findFirst({ where: eq(runs.id, runId) });
	if (!run || run.orgId !== auth.org.id) {
		return new Response('not found', { status: 404 });
	}

	const lastEventId = req.headers.get('last-event-id');

	const encoder = new TextEncoder();
	const subject = `run:${runId}`;
	const stream = new ReadableStream({
		async start(controller) {
			const send = (chunk: string) => controller.enqueue(encoder.encode(chunk));

			// Replay events that occurred after last-event-id.
			const replay = await readSseEventsAfter(subject, lastEventId);
			for (const raw of replay) {
				let parsed: { id?: string };
				try {
					parsed = JSON.parse(raw);
				} catch {
					continue;
				}
				const id = parsed.id ?? '';
				send(`id: ${id}\nevent: replay\ndata: ${raw}\n\n`);
			}

			// Long-poll loop. Production-grade impl uses Redis pubsub; here we
			// poll the same Redis log every 1s. Switch to pubsub once we wire
			// `@upstash/redis` channels.
			let cancelled = false;
			let lastSeen: string | null = lastEventId;
			const heartbeat = setInterval(() => send(`: ping ${Date.now()}\n\n`), HEARTBEAT_MS);

			(async () => {
				while (!cancelled) {
					await new Promise((r) => setTimeout(r, 1000));
					const fresh = await readSseEventsAfter(subject, lastSeen);
					for (const raw of fresh) {
						let parsed: { id?: string; type?: string };
						try {
							parsed = JSON.parse(raw);
						} catch {
							continue;
						}
						const id = parsed.id ?? '';
						send(`id: ${id}\ndata: ${raw}\n\n`);
						lastSeen = id;
						if (parsed.type === 'run_complete') {
							cancelled = true;
							break;
						}
					}
				}
				clearInterval(heartbeat);
				controller.close();
			})();

			req.signal.addEventListener('abort', () => {
				cancelled = true;
				clearInterval(heartbeat);
				try {
					controller.close();
				} catch {
					// already closed
				}
			});
		},
	});

	return new Response(stream, {
		headers: {
			'Content-Type': 'text/event-stream; charset=utf-8',
			'Cache-Control': 'no-store, no-transform',
			Connection: 'keep-alive',
			'X-Accel-Buffering': 'no',
		},
	});
}
