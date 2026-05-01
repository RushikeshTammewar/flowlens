/**
 * Service worker. Owns:
 *   - cookies / storage capture (chrome.cookies + scripting.executeScript)
 *   - screenshot capture (chrome.tabs.captureVisibleTab)
 *   - chunk upload to /api/recordings/:id/chunks
 *   - finalize POST to /api/recordings/:id/finish
 *
 * The content script (entrypoints/content.ts) wires rrweb + the action stream
 * and pipes events back here via chrome.runtime.sendMessage.
 */
import { defineBackground } from 'wxt/utils/define-background';
import { api } from '../lib/api-client.js';

interface RecordingSession {
	recordingId: string;
	flowId: string;
	tabId: number;
	siteOrigin: string;
	startedAt: number;
	pendingScreenshots: Array<{ actionIndex: number; pngBase64: string }>;
	semanticActions: unknown[];
	/**
	 * Page-wide form-control inventory captured by the content script at
	 * recorder_stop. Forwarded verbatim to /api/recordings/:id/finish so
	 * matrix-gen can prompt against the FULL set of on-page controls
	 * (touched + untouched), not just the steps the user interacted with.
	 */
	pageControls: unknown[];
	chunksUploaded: number;
	lastFlushAt: number;
}

// Subset of `RecordingSession` that survives MV3 service-worker restarts.
// `pendingScreenshots` is intentionally NOT persisted — it's drained on the
// next chunk flush and we'd rather drop a screenshot or two on SW death than
// blow past chrome.storage.session's per-item byte limit with PNG payloads.
//
// `semanticActions` IS persisted: each action is small JSON (~0.5–2 KB), and
// `stopRecording` ships the full array to `/api/recordings/:id/finish` as
// the canonical action stream that drives compile. Persisting only a count
// (the previous design) caused finish to send `[null, null, …]`, which
// normalization filters out, leaving the compile pipeline with 0 actions.
//
// Why this matters at all: in MV3 the SW can be killed at any moment (idle,
// tab navigation, Chrome internal lifecycle). If the only copy of `active`
// lives in `let active: RecordingSession | null`, the next message after a
// SW restart sees `null` — `get_recording_state` returns `{active: false}`
// and the side panel silently drops to Idle while the in-page overlay keeps
// running. Persisting to `chrome.storage.session` makes recording state
// durable across SW restarts but auto-clears when the browser quits.
interface PersistedSession {
	recordingId: string;
	flowId: string;
	tabId: number;
	siteOrigin: string;
	startedAt: number;
	chunksUploaded: number;
	lastFlushAt: number;
	semanticActions: unknown[];
	pageControls: unknown[];
}

const STORAGE_KEY = 'flowlens_active_session';
let active: RecordingSession | null = null;

function toPersisted(s: RecordingSession): PersistedSession {
	return {
		recordingId: s.recordingId,
		flowId: s.flowId,
		tabId: s.tabId,
		siteOrigin: s.siteOrigin,
		startedAt: s.startedAt,
		chunksUploaded: s.chunksUploaded,
		lastFlushAt: s.lastFlushAt,
		semanticActions: s.semanticActions,
		pageControls: s.pageControls,
	};
}

async function persistActive(): Promise<void> {
	try {
		if (active) {
			await chrome.storage.session.set({ [STORAGE_KEY]: toPersisted(active) });
		} else {
			await chrome.storage.session.remove(STORAGE_KEY);
		}
	} catch (err) {
		console.warn('[Flowlens] persistActive failed', err);
	}
}

async function hydrateActive(): Promise<void> {
	if (active) return;
	try {
		const res = await chrome.storage.session.get(STORAGE_KEY);
		const p = res[STORAGE_KEY] as PersistedSession | undefined;
		if (!p) return;
		active = {
			recordingId: p.recordingId,
			flowId: p.flowId,
			tabId: p.tabId,
			siteOrigin: p.siteOrigin,
			startedAt: p.startedAt,
			pendingScreenshots: [],
			// Restore the real action objects (not a sized null-fill).
			// `stopRecording` forwards this array verbatim to the finish API,
			// so any null placeholders here get filtered by backend
			// normalization and the compile pipeline aborts with
			// "no semantic actions".
			semanticActions: Array.isArray(p.semanticActions) ? p.semanticActions : [],
			pageControls: Array.isArray(p.pageControls) ? p.pageControls : [],
			chunksUploaded: p.chunksUploaded,
			lastFlushAt: p.lastFlushAt,
		};
		console.log('[Flowlens] recording state rehydrated from session storage', {
			recordingId: p.recordingId,
			actionsCount: active.semanticActions.length,
		});
	} catch (err) {
		console.warn('[Flowlens] hydrateActive failed', err);
	}
}

export default defineBackground(() => {
	console.log('[Flowlens] background ready');

	// Eagerly hydrate `active` if a previous SW left a session behind. Fires
	// once per SW boot — either we just woke up because of a tab navigation
	// during recording, or the user re-opened Chrome with the extension still
	// loaded but no active session (in which case session storage is empty
	// and this is a no-op).
	void hydrateActive();

	chrome.sidePanel
		.setPanelBehavior({ openPanelOnActionClick: true })
		.catch((err) => console.error('[Flowlens] sidePanel.setPanelBehavior failed:', err));

	chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
		void handleMessage(message, sender, sendResponse);
		return true; // keep the channel open for async sendResponse
	});

	// When the recording tab navigates (form submit, link click, history pushState
	// that triggers a full reload), the old content-script + rrweb recorder + in-
	// page overlay all die with the page. Re-fire `recorder_start` to the new
	// content-script as soon as it commits a navigation so recording continues
	// seamlessly across page boundaries — this is the difference between
	// "recording stops silently after submit" (the user-visible bug) and a
	// proper multi-page flow capture.
	chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
		if (changeInfo.status !== 'complete') return;
		// SW may have just been woken by this navigation event; rehydrate
		// before deciding whether to re-arm.
		void (async () => {
			await hydrateActive();
			if (!active || tabId !== active.tabId) return;
			// Refresh the saved siteOrigin if the user navigated to a same-domain
			// (or even cross-domain) page; recording continues either way.
			if (tab.url) {
				try {
					active.siteOrigin = new URL(tab.url).origin;
					await persistActive();
				} catch {
					// keep previous origin
				}
			}
			try {
				await chrome.tabs.sendMessage(tabId, {
					type: 'recorder_start',
					recordingId: active.recordingId,
				});
				console.log('[Flowlens] recorder re-armed after navigation', tab.url ?? '');
			} catch (err) {
				console.warn('[Flowlens] recorder re-arm failed', err);
			}
		})();
	});
});

async function handleMessage(
	message: unknown,
	sender: chrome.runtime.MessageSender,
	sendResponse: (response: unknown) => void,
): Promise<void> {
	if (typeof message !== 'object' || !message) return;
	const m = message as Record<string, unknown>;
	const type = m.type;

	// Always rehydrate before reading or mutating `active`. SW may have been
	// killed since the last message — we don't want to silently lose state.
	await hydrateActive();

	switch (type) {
		case 'ping':
			sendResponse({ type: 'pong', at: Date.now() });
			return;

		case 'get_recording_state':
			// Side panel calls this on mount to rehydrate after a re-mount.
			// Returns null when no recording is active, otherwise the live
			// session view the panel needs to drop straight into the recording
			// screen.
			sendResponse(
				active
					? {
							active: true,
							recordingId: active.recordingId,
							flowId: active.flowId,
							tabId: active.tabId,
							siteOrigin: active.siteOrigin,
							actionsCaptured: active.semanticActions.length,
						}
					: { active: false },
			);
			return;

		case 'start_recording':
			sendResponse(await startRecording(m));
			return;

		case 'rrweb_chunk':
			await onRrwebChunk(m);
			sendResponse({ ok: true });
			return;

		case 'semantic_action':
			await onSemanticAction(m);
			sendResponse({ ok: true });
			return;

		case 'page_controls':
			await onPageControls(m);
			sendResponse({ ok: true });
			return;

		case 'request_screenshot':
			await onScreenshotRequest(m, sender);
			sendResponse({ ok: true });
			return;

		case 'stop_recording':
			sendResponse(await stopRecording(m));
			return;

		case 'set_auth_token':
			await chrome.storage.local.set({ flowlens_auth_token: m.token });
			sendResponse({ ok: true });
			return;

		case 'capture_cookies':
			sendResponse(await captureCookies(String(m.url)));
			return;

		case 'capture_cookies_and_storage': {
			const tabId = Number(m.tabId);
			const url = String(m.url);
			let origin = url;
			try {
				origin = new URL(url).origin;
			} catch {
				// fall back to raw URL
			}
			const [cookies, storage] = await Promise.all([
				captureCookies(origin),
				captureStorage(tabId),
			]);
			sendResponse({ cookies, storage, origin });
			return;
		}

		default:
			sendResponse({ ok: false, reason: 'unknown message type' });
	}
}

async function startRecording(m: Record<string, unknown>): Promise<unknown> {
	if (active) return { ok: false, reason: 'already recording' };
	const tabId = m.tabId as number;
	const siteOrigin = m.siteOrigin as string;
	const displayName = (m.displayName as string) ?? 'Untitled flow';
	const viewport = m.viewport as { w: number; h: number; dpr: number };
	const userAgent = (m.userAgent as string) ?? navigator.userAgent;

	try {
		const start = await api.startRecording({ siteOrigin, displayName, viewport, userAgent });
		active = {
			recordingId: start.recordingId,
			flowId: start.flowId,
			tabId,
			siteOrigin,
			startedAt: Date.now(),
			pendingScreenshots: [],
			semanticActions: [],
			pageControls: [],
			chunksUploaded: 0,
			lastFlushAt: Date.now(),
		};
		await persistActive();
		// MV3 quirk: when the user reloads the extension, tabs that were
		// already open lose their content-script context. The manifest's
		// `matches: ['<all_urls>']` only auto-injects on NEW page loads, so
		// `chrome.tabs.sendMessage` would fail silently and the recorder
		// would never arm. We try to send first; if the connection fails
		// (no listener), we programmatically inject the content script
		// and retry. Idempotent — if the script is already present, the
		// catch is a no-op.
		const armRecorder = async () => {
			await chrome.tabs.sendMessage(tabId, {
				type: 'recorder_start',
				recordingId: start.recordingId,
			});
		};
		try {
			await armRecorder();
		} catch (err) {
			console.warn(
				'[Flowlens] recorder_start delivery failed, injecting content script and retrying',
				err,
			);
			try {
				await chrome.scripting.executeScript({
					target: { tabId },
					files: ['content-scripts/content.js'],
				});
				await armRecorder();
				console.log('[Flowlens] recorder armed after on-demand content-script injection');
			} catch (injectErr) {
				console.error(
					'[Flowlens] could not inject content script (likely a chrome:// or restricted page)',
					injectErr,
				);
				return {
					ok: false,
					reason:
						'Cannot record on this page — Chrome blocks extensions from accessing it (chrome://, extension stores, file://, etc.). Open a regular http/https page and try again.',
				};
			}
		}
		return { ok: true, ...start };
	} catch (err) {
		console.error('[Flowlens] startRecording failed', err);
		return { ok: false, reason: (err as Error).message };
	}
}

async function onRrwebChunk(m: Record<string, unknown>): Promise<void> {
	if (!active) return;
	const ordinal = m.ordinal as number;
	const gzippedBase64 = m.gzippedBase64 as string;
	const gzipped = base64ToBytes(gzippedBase64);
	try {
		await api.putChunk({
			recordingId: active.recordingId,
			ordinal,
			gzipped,
			screenshots: active.pendingScreenshots.splice(0, active.pendingScreenshots.length),
		});
		active.chunksUploaded++;
		active.lastFlushAt = Date.now();
		await persistActive();
	} catch (err) {
		console.warn('[Flowlens] chunk upload failed (will retry on next flush):', err);
	}
}

async function onSemanticAction(m: Record<string, unknown>): Promise<void> {
	if (!active) return;
	active.semanticActions.push(m.action);
	await persistActive();
}

async function onPageControls(m: Record<string, unknown>): Promise<void> {
	if (!active) return;
	const items = Array.isArray(m.items) ? (m.items as unknown[]) : [];
	// Always overwrite (not append): the content script captures the FULL
	// inventory at recorder_stop, and on cross-page navigations during a
	// long recording the freshest snapshot is the right one (the form on
	// the final page is what matrix-gen will replay against).
	active.pageControls = items;
	await persistActive();
	console.log(`[Flowlens] page-control inventory received (${items.length} controls)`);
}

async function onScreenshotRequest(
	m: Record<string, unknown>,
	sender: chrome.runtime.MessageSender,
): Promise<void> {
	if (!active) return;
	const actionIndex = m.actionIndex as number;
	try {
		const windowId = sender.tab?.windowId;
		const dataUrl =
			typeof windowId === 'number'
				? await chrome.tabs.captureVisibleTab(windowId, { format: 'png' })
				: await chrome.tabs.captureVisibleTab({ format: 'png' });
		if (!dataUrl) {
			console.warn('[Flowlens] captureVisibleTab returned empty for action', actionIndex);
			return;
		}
		// `active` may have been cleared while captureVisibleTab was awaiting
		// (stop-recording races, SW idle eviction). Re-check before mutating.
		if (!active) return;
		active.pendingScreenshots.push({ actionIndex, pngBase64: dataUrl });
		console.log(
			`[Flowlens] screenshot captured action=${actionIndex} pending=${active.pendingScreenshots.length}`,
		);
	} catch (err) {
		// captureVisibleTab fails with permission errors when host_permissions
		// don't include the current origin and the activeTab grant has lapsed
		// (typically after a navigation). Surface the actual error string so
		// it's obvious why screenshots are missing.
		console.warn(
			`[Flowlens] screenshot capture failed action=${actionIndex}:`,
			(err as Error).message ?? err,
		);
	}
}

async function stopRecording(m: Record<string, unknown>): Promise<unknown> {
	if (!active) return { ok: false, reason: 'not recording' };
	const tabId = active.tabId;
	// recorder_stop is the trigger that makes the content script run
	// `extractPageControls()` and post a `page_controls` message back to us.
	// We `await sendMessage` here so when the SW gets back to building the
	// finish payload, `active.pageControls` is most likely populated. We
	// still tolerate the case where the content script unloaded (cross-tab
	// close) — `pageControls` simply ends up as `[]` and the matrix prompt
	// degrades to the touched-only path.
	try {
		await chrome.tabs.sendMessage(tabId, { type: 'recorder_stop' });
	} catch {
		// content script may have unloaded
	}
	// Give the content-script a brief window to push its `page_controls`
	// message and have us merge it into `active`. Without this, fast SW
	// scheduling can race past the inventory message and we'd ship
	// pageControls=[] every time.
	await waitForPageControls(active, 500);
	void m;

	// Capture final cookie + storage snapshot.
	const cookies = await captureCookies(active.siteOrigin);
	const storage = await captureStorage(tabId);

	const flowIdLocal = active.flowId;
	const recordingIdLocal = active.recordingId;
	const siteOriginLocal = active.siteOrigin;
	const actionsLocal = active.semanticActions;
	const pageControlsLocal = active.pageControls;
	active = null;
	await persistActive();

	try {
		const finishRes = await api.finishRecording({
			recordingId: recordingIdLocal,
			payload: {
				cookies,
				storage,
				origins: [siteOriginLocal],
				actions: actionsLocal,
				viewport: { w: 1280, h: 720, dpr: 1 },
				userAgent: 'flowlens-extension',
				...(pageControlsLocal.length > 0 ? { pageControls: pageControlsLocal } : {}),
			},
		});
		return { ok: true, flowId: flowIdLocal, finish: finishRes };
	} catch (err) {
		return { ok: false, reason: (err as Error).message, flowId: flowIdLocal };
	}
}

async function waitForPageControls(s: RecordingSession, maxMs: number): Promise<void> {
	if (s.pageControls.length > 0) return;
	const start = Date.now();
	while (Date.now() - start < maxMs) {
		await new Promise((r) => setTimeout(r, 50));
		if (s.pageControls.length > 0) return;
	}
}

async function captureCookies(url: string): Promise<unknown[]> {
	try {
		const cookies = await chrome.cookies.getAll({ url });
		return cookies.map((c) => ({
			domain: c.domain,
			name: c.name,
			value: c.value,
			expires: c.expirationDate ?? null,
			sameSite: normalizeSameSite(c.sameSite),
			httpOnly: c.httpOnly,
			secure: c.secure,
			path: c.path,
		}));
	} catch (err) {
		console.warn('[Flowlens] captureCookies failed', err);
		return [];
	}
}

function normalizeSameSite(s: string): 'Strict' | 'Lax' | 'None' | 'unspecified' {
	if (s === 'strict') return 'Strict';
	if (s === 'lax') return 'Lax';
	if (s === 'no_restriction' || s === 'none') return 'None';
	return 'unspecified';
}

async function captureStorage(tabId: number): Promise<{ localStorage: Record<string, string>; sessionStorage: Record<string, string> }> {
	try {
		const results = await chrome.scripting.executeScript({
			target: { tabId },
			func: () => {
				const ls: Record<string, string> = {};
				for (let i = 0; i < localStorage.length; i++) {
					const k = localStorage.key(i);
					if (k !== null) ls[k] = localStorage.getItem(k) ?? '';
				}
				const ss: Record<string, string> = {};
				for (let i = 0; i < sessionStorage.length; i++) {
					const k = sessionStorage.key(i);
					if (k !== null) ss[k] = sessionStorage.getItem(k) ?? '';
				}
				return { localStorage: ls, sessionStorage: ss };
			},
		});
		const out = results[0]?.result;
		return out ?? { localStorage: {}, sessionStorage: {} };
	} catch (err) {
		console.warn('[Flowlens] captureStorage failed', err);
		return { localStorage: {}, sessionStorage: {} };
	}
}

function base64ToBytes(b64: string): Uint8Array {
	const bin = atob(b64);
	const bytes = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
	return bytes;
}
