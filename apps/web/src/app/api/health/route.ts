import { NextResponse } from 'next/server';
import { hasOpenAiKey } from '@/lib/openai';
import { MODELS } from '@flowlens/llm-config';
import { Pool } from 'pg';
import OpenAI from 'openai';
import { Redis } from '@upstash/redis';
import { sealForOrg, openForOrg, deriveOrgKeyPair } from '@flowlens/cookies-vault';
import { randomUUID } from 'node:crypto';

/**
 * Health endpoint.
 *
 * Default: env presence + selected model names (cheap, public, no side effects).
 * With `?probe=1` (dev only): live probes of DB, OpenAI, BU Cloud, Upstash.
 */
export async function GET(req: Request) {
	const url = new URL(req.url);
	const wantProbe =
		url.searchParams.get('probe') === '1' && process.env.NODE_ENV !== 'production';
	const wantRunSmoke =
		url.searchParams.get('probe') === 'run-smoke' && process.env.NODE_ENV !== 'production';
	const wantStopAll =
		url.searchParams.get('probe') === 'stop-bu-sessions' && process.env.NODE_ENV !== 'production';

	if (wantRunSmoke) {
		return runSmoke();
	}
	if (wantStopAll) {
		return stopAllBuSessions();
	}

	const dbUrl = process.env.DATABASE_URL ?? '';
	const dbUrlUnpooled = process.env.DATABASE_URL_UNPOOLED ?? '';
	const checks: Record<string, unknown> = {
		ok: true,
		ts: new Date().toISOString(),
		env: {
			hasDatabaseUrl: !!dbUrl,
			hasDatabaseUrlSslmode: dbUrl.includes('sslmode='),
			hasDatabaseUrlUnpooled: !!dbUrlUnpooled,
			hasDatabaseUrlUnpooledSslmode: dbUrlUnpooled.includes('sslmode='),
			hasBuApiKey: !!process.env.BROWSER_USE_API_KEY,
			hasClerkSecret: !!process.env.CLERK_SECRET_KEY,
			hasClerkWebhookSecret: !!process.env.CLERK_WEBHOOK_SIGNING_SECRET,
			hasBlobToken: !!process.env.BLOB_READ_WRITE_TOKEN,
			hasBlobPublicBase: !!process.env.BLOB_PUBLIC_BASE_URL,
			hasVaultSecret: !!process.env.FLOWLENS_VAULT_SECRET,
			hasOpenaiKey: hasOpenAiKey(),
			hasDemoMode: process.env.FLOWLENS_DEMO_MODE === 'true',
			hasDemoBearer: !!process.env.FLOWLENS_DEMO_BEARER,
		},
		models: MODELS,
	};

	if (!wantProbe) {
		return NextResponse.json(checks);
	}

	const probe: Record<string, unknown> = {};

	// DB
	try {
		const pool = new Pool({
			connectionString: process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL,
			max: 1,
			connectionTimeoutMillis: 5_000,
		});
		const r = await pool.query(
			`SELECT (SELECT count(*) FROM pg_tables WHERE schemaname='public') AS tables,
			        (SELECT count(*) FROM information_schema.columns WHERE table_name='runs') AS run_cols`,
		);
		probe.db = { ok: true, tables: Number(r.rows[0].tables), runColumns: Number(r.rows[0].run_cols) };
		await pool.end();
	} catch (err) {
		probe.db = { ok: false, error: (err as Error).message };
	}

	// OpenAI
	try {
		const c = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
		const r = await c.chat.completions.create({
			model: 'gpt-4.1-mini',
			max_completion_tokens: 5,
			messages: [{ role: 'user', content: 'Reply with the single word OK.' }],
		});
		probe.openai = {
			ok: true,
			reply: r.choices[0]?.message.content ?? '',
			usage: r.usage,
		};
	} catch (err) {
		probe.openai = { ok: false, error: (err as Error).message };
	}

	// BU Cloud
	try {
		const res = await fetch('https://api.browser-use.com/api/v2/billing/account', {
			headers: { 'X-Browser-Use-API-Key': process.env.BROWSER_USE_API_KEY ?? '' },
		});
		const data = (await res.json()) as { totalCreditsBalanceUsd?: number; rateLimit?: number };
		probe.bu = {
			ok: res.ok,
			status: res.status,
			creditsUsd: data.totalCreditsBalanceUsd,
			rateLimit: data.rateLimit,
		};
	} catch (err) {
		probe.bu = { ok: false, error: (err as Error).message };
	}

	// Upstash
	try {
		const r = new Redis({
			url: process.env.UPSTASH_REDIS_REST_URL ?? '',
			token: process.env.UPSTASH_REDIS_REST_TOKEN ?? '',
		});
		await r.set('flowlens:probe:p1', 'hello', { ex: 60 });
		const v = await r.get('flowlens:probe:p1');
		probe.redis = { ok: true, readBack: v };
	} catch (err) {
		probe.redis = { ok: false, error: (err as Error).message };
	}

	// Cookie vault round-trip (P2.1)
	try {
		const orgId = randomUUID();
		const vaultSecret = process.env.FLOWLENS_VAULT_SECRET ?? '';
		const plaintext = JSON.stringify({ cookies: [{ name: 'sess', value: 'sentinel' }], storage: {} });
		const sealed = await sealForOrg({ orgId, vaultSecret, plaintext });
		const opened = await openForOrg({ orgId, vaultSecret, sealed });
		let tamperOk = false;
		try {
			await openForOrg({ orgId: randomUUID(), vaultSecret, sealed });
			tamperOk = true;
		} catch {
			tamperOk = false;
		}
		const kp1 = await deriveOrgKeyPair({ orgId, vaultSecret });
		const kp2 = await deriveOrgKeyPair({ orgId, vaultSecret });
		const deterministic =
			Buffer.compare(Buffer.from(kp1.publicKey), Buffer.from(kp2.publicKey)) === 0;
		probe.vault = {
			ok: opened === plaintext && !tamperOk && deterministic,
			roundTrip: opened === plaintext,
			tamperRejected: !tamperOk,
			deterministicKeypair: deterministic,
		};
	} catch (err) {
		probe.vault = { ok: false, error: (err as Error).message };
	}

	checks.probe = probe;
	return NextResponse.json(checks);
}

/**
 * Drain all open Browser-Use Cloud sessions on this account.
 *
 * Used to recover from a stuck-session state during dev smoke (free-tier cap
 * is 3 concurrent sessions and our finally-blocks can leak if the Next route
 * crashes mid-stream). DEV-ONLY.
 */
async function stopAllBuSessions(): Promise<NextResponse> {
	const BU_BASE = 'https://api.browser-use.com/api/v2';
	const apiKey = process.env.BROWSER_USE_API_KEY ?? '';

	const out: Record<string, unknown> = { ts: new Date().toISOString() };
	try {
		// /sessions returns currently-running sessions (no params returns all).
		// /browsers lists sessions created via createBrowserSession — that's what we
		// use. /sessions returns task-related sessions (different concept).
		const res = await fetch(`${BU_BASE}/browsers?pageSize=50`, {
			headers: { 'X-Browser-Use-API-Key': apiKey },
		});
		const data = (await res.json()) as { items?: Array<Record<string, unknown>> };
		const items = data.items ?? [];
		out.found = items.length;
		// Dump first item to discover the right shape.
		out.firstSample = items[0];
		const stopped: string[] = [];
		const failed: Array<{ id: string; err: string }> = [];
		for (const it of items) {
			const id = it.id as string;
			// Try several candidate stop paths in order; record which one (if any) wins.
			const candidates = [
				{ method: 'PATCH', path: `/browsers/${id}`, body: { action: 'stop' } },
				{ method: 'POST', path: `/browsers/${id}/stop`, body: null },
				{ method: 'DELETE', path: `/sessions/${id}`, body: null },
			];
			let succeeded = false;
			let lastErr = 'no candidate matched';
			for (const c of candidates) {
				try {
					const r = await fetch(`${BU_BASE}${c.path}`, {
						method: c.method,
						headers: {
							'X-Browser-Use-API-Key': apiKey,
							...(c.body ? { 'Content-Type': 'application/json' } : {}),
						},
						body: c.body ? JSON.stringify(c.body) : undefined,
					});
					if (r.ok) {
						stopped.push(`${id}@${c.method} ${c.path}`);
						succeeded = true;
						break;
					}
					lastErr = `${c.method} ${c.path}: ${r.status}`;
				} catch (e) {
					lastErr = `${c.method} ${c.path}: ${(e as Error).message}`;
				}
			}
			if (!succeeded) failed.push({ id, err: lastErr });
		}
		out.stopped = stopped;
		out.failed = failed;
		return NextResponse.json(out);
	} catch (err) {
		out.error = (err as Error).message;
		return NextResponse.json(out, { status: 500 });
	}
}

/**
 * Live `/run` smoke against the local Python sidecar.
 *
 * Cost: ~$0.005 per BU Cloud session. Always stops the session in finally so
 * unused minutes are refunded.
 *
 * Bearer token must match what the sidecar was launched with — currently the
 * literal `dev-shared-secret-for-local-smoke-only` from Phase 3.7.
 */
async function runSmoke(): Promise<NextResponse> {
	const BU_BASE = 'https://api.browser-use.com/api/v2';
	const SIDECAR_BASE = process.env.SMOKE_SIDECAR_URL ?? 'http://127.0.0.1:8000';
	const SIDECAR_BEARER = 'dev-shared-secret-for-local-smoke-only';

	// Pre-flight: confirm sidecar reachable from inside the Next runtime.
	try {
		const probeRes = await fetch(`${SIDECAR_BASE}/healthz`);
		if (!probeRes.ok) throw new Error(`healthz returned ${probeRes.status}`);
	} catch (probeErr) {
		return NextResponse.json(
			{
				preflight: 'sidecar unreachable',
				error: (probeErr as Error).message,
				tried: SIDECAR_BASE,
			},
			{ status: 503 },
		);
	}

	const flow = {
		id: 'smoke-flow',
		name: 'smoke flow',
		siteOrigin: 'https://example.com',
		steps: [
			{
				index: 0,
				action: 'navigate' as const,
				intent: 'Open the example.com homepage',
				expectedOutcome: 'Page loads with "Example Domain" heading',
				isCritical: false,
				selectors: {},
				recordedValue: null,
				isSensitive: false,
				recordedScreenshotKey: '',
				url: 'https://example.com',
			},
			{
				index: 1,
				action: 'click' as const,
				intent: 'Click the "More information" link',
				expectedOutcome: 'Navigate to iana.org',
				isCritical: false,
				selectors: {
					role: 'link',
					accessibleName: 'More information...',
					css: 'a',
					xpath: '/html/body/div/p[2]/a',
				},
				recordedValue: null,
				isSensitive: false,
				recordedScreenshotKey: '',
				url: null,
			},
		],
	};

	const out: Record<string, unknown> = { ts: new Date().toISOString() };
	let sessionId: string | null = null;

	try {
		const sessRes = await fetch(`${BU_BASE}/browsers`, {
			method: 'POST',
			headers: {
				'X-Browser-Use-API-Key': process.env.BROWSER_USE_API_KEY ?? '',
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({ proxyCountryCode: 'us', stealthMode: false }),
		});
		const sessText = await sessRes.text();
		if (!sessRes.ok) {
			out.sessionError = { status: sessRes.status, body: sessText.slice(0, 400) };
			return NextResponse.json(out, { status: 500 });
		}
		const session = JSON.parse(sessText) as {
			id: string;
			cdpUrl?: string;
			liveUrl?: string | null;
		};
		sessionId = session.id;
		out.session = { id: session.id, hasCdp: !!session.cdpUrl, hasLive: !!session.liveUrl };

		const runReq = {
			runId: randomUUID(),
			flow,
			cdpUrl: session.cdpUrl,
			liveUrl: session.liveUrl ?? null,
			mode: { name: 'hybrid' as const },
			recordedScreenshotsByIndex: {},
			sensitiveData: {},
		};

		const res = await fetch(`${SIDECAR_BASE}/run`, {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${SIDECAR_BEARER}`,
				'Content-Type': 'application/json',
				Accept: 'text/event-stream',
			},
			body: JSON.stringify(runReq),
		});

		if (!res.ok) {
			const t = await res.text();
			out.runError = { status: res.status, body: t.slice(0, 400) };
			return NextResponse.json(out, { status: 500 });
		}

		const events: Array<Record<string, unknown>> = [];
		const reader = res.body!.getReader();
		const decoder = new TextDecoder();
		let buf = '';
		const deadline = Date.now() + 90_000;
		let stepFinished = 0;
		let runComplete: Record<string, unknown> | null = null;
		let runPaused: Record<string, unknown> | null = null;

		while (Date.now() < deadline) {
			const { value, done } = await reader.read();
			if (done) break;
			buf += decoder.decode(value, { stream: true });
			while (buf.includes('\n\n')) {
				const idx = buf.indexOf('\n\n');
				const chunk = buf.slice(0, idx);
				buf = buf.slice(idx + 2);
				for (const line of chunk.split('\n')) {
					if (!line.startsWith('data: ')) continue;
					const dataStr = line.slice(6);
					if (!dataStr.trim()) continue;
					try {
						const evt = JSON.parse(dataStr) as Record<string, unknown>;
						events.push(evt);
						if (evt.type === 'step_finished') stepFinished++;
						if (evt.type === 'run_complete') runComplete = evt;
						if (evt.type === 'run_paused') runPaused = evt;
					} catch {
						/* non-JSON SSE comment */
					}
				}
			}
			if (runComplete || runPaused) break;
		}

		out.smoke = {
			eventsCaptured: events.length,
			stepFinishedCount: stepFinished,
			runComplete,
			runPaused,
			pass: stepFinished >= 1 || runComplete !== null,
		};
		out.firstFiveEvents = events.slice(0, 5);
		return NextResponse.json(out);
	} catch (err) {
		out.error = (err as Error).message;
		return NextResponse.json(out, { status: 500 });
	} finally {
		if (sessionId) {
			try {
				await fetch(`${BU_BASE}/sessions/${sessionId}`, {
					method: 'PATCH',
					headers: {
						'X-Browser-Use-API-Key': process.env.BROWSER_USE_API_KEY ?? '',
						'Content-Type': 'application/json',
					},
					body: JSON.stringify({ action: 'stop' }),
				});
			} catch {
				/* best-effort */
			}
		}
	}
}
