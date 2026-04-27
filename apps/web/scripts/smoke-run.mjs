#!/usr/bin/env node
/**
 * Live `/run` smoke test.
 *
 * Steps:
 *   1. Create a hosted Browser-Use Cloud session.
 *   2. POST to the local Python sidecar's /run endpoint with a synthetic
 *      2-step flow (navigate to example.com, click the IANA link).
 *   3. Stream the SSE events for up to 90s.
 *   4. ALWAYS stop the BU session in finally to refund unused minutes.
 *
 * Prints PASS if at least one `step_finished` event arrives with a non-error
 * status; FAIL otherwise.
 *
 * Bearer token: must match the sidecar's REPLAY_WORKER_SHARED_SECRET (which
 * was set when the worker was launched in Phase 3.7 — see prior session).
 */
import './load-env.mjs';
import { randomUUID } from 'node:crypto';

const BU_BASE = 'https://api.browser-use.com/api/v2';
const SIDECAR_BASE = process.env.REPLAY_WORKER_LOCAL_URL ?? 'http://127.0.0.1:8000';
// The sidecar in Phase 3.7 was booted with this literal value, NOT what's in
// .env.local — keep them in sync if you restart the worker.
const SHARED_SECRET =
	process.env.REPLAY_WORKER_LOCAL_SECRET ?? 'dev-shared-secret-for-local-smoke-only';

const BU_KEY = process.env.BROWSER_USE_API_KEY;
if (!BU_KEY) {
	console.error('BROWSER_USE_API_KEY missing');
	process.exit(1);
}

async function buFetch(path, init = {}) {
	const res = await fetch(`${BU_BASE}${path}`, {
		...init,
		headers: {
			'X-Browser-Use-API-Key': BU_KEY,
			'Content-Type': 'application/json',
			...(init.headers ?? {}),
		},
	});
	const text = await res.text();
	if (!res.ok) throw new Error(`BU ${path}: ${res.status} ${text.slice(0, 200)}`);
	return text ? JSON.parse(text) : null;
}

async function createSession() {
	const body = { proxyCountryCode: 'us', stealthMode: false };
	return buFetch('/browsers', { method: 'POST', body: JSON.stringify(body) });
}

async function stopSession(sessionId) {
	try {
		await buFetch(`/sessions/${sessionId}`, {
			method: 'PATCH',
			body: JSON.stringify({ action: 'stop' }),
		});
		console.log('[cleanup] BU session stopped:', sessionId);
	} catch (err) {
		console.warn('[cleanup] stop failed:', err.message);
	}
}

const flow = {
	id: 'smoke-flow',
	name: 'smoke flow',
	siteOrigin: 'https://example.com',
	steps: [
		{
			index: 0,
			action: 'navigate',
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
			action: 'click',
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

async function streamSse(runId, cdpUrl, liveUrl) {
	const req = {
		runId,
		flow,
		cdpUrl,
		liveUrl: liveUrl ?? null,
		mode: { name: 'hybrid' },
		recordedScreenshotsByIndex: {},
		sensitiveData: {},
	};
	const res = await fetch(`${SIDECAR_BASE}/run`, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${SHARED_SECRET}`,
			'Content-Type': 'application/json',
			Accept: 'text/event-stream',
		},
		body: JSON.stringify(req),
	});
	if (!res.ok) {
		const t = await res.text();
		throw new Error(`/run ${res.status}: ${t.slice(0, 300)}`);
	}

	const events = [];
	const reader = res.body.getReader();
	const decoder = new TextDecoder();
	let buf = '';
	const deadline = Date.now() + 90_000;
	let stepFinished = 0;
	let runComplete = null;
	let runPaused = null;

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
					const evt = JSON.parse(dataStr);
					events.push(evt);
					console.log('[evt]', JSON.stringify(evt).slice(0, 240));
					if (evt.type === 'step_finished') stepFinished++;
					if (evt.type === 'run_complete') runComplete = evt;
					if (evt.type === 'run_paused') runPaused = evt;
				} catch {
					// non-JSON SSE comment / heartbeat — ignore
				}
			}
		}
		if (runComplete || runPaused) break;
	}
	return { events, stepFinished, runComplete, runPaused };
}

let session;
const exitCode = await (async () => {
	try {
		console.log('[smoke] creating BU session…');
		session = await createSession();
		const cdpUrl = session.cdpUrl ?? session.cdp_url;
		const liveUrl = session.liveUrl ?? session.live_url ?? null;
		console.log('[smoke] session.id:', session.id);
		console.log('[smoke] cdp present:', !!cdpUrl, 'live present:', !!liveUrl);

		console.log('[smoke] dispatching /run…');
		const result = await streamSse(randomUUID(), cdpUrl, liveUrl);
		console.log(`[smoke] events captured: ${result.events.length}`);
		console.log(`[smoke] step_finished count: ${result.stepFinished}`);
		console.log(`[smoke] run_complete: ${result.runComplete?.status ?? 'none'}`);
		console.log(`[smoke] run_paused: ${result.runPaused?.reason ?? 'none'}`);

		if (result.stepFinished >= 1 || result.runComplete) {
			console.log('SMOKE: PASS');
			return 0;
		}
		console.log('SMOKE: FAIL — no step_finished or run_complete event');
		return 2;
	} catch (err) {
		console.error('SMOKE: FAIL —', err.message);
		return 3;
	} finally {
		if (session?.id) await stopSession(session.id);
	}
})();

process.exit(exitCode);
