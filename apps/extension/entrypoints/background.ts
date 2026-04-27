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
	chunksUploaded: number;
	lastFlushAt: number;
}

let active: RecordingSession | null = null;

export default defineBackground(() => {
	console.log('[Flowlens] background ready');

	chrome.sidePanel
		.setPanelBehavior({ openPanelOnActionClick: true })
		.catch((err) => console.error('[Flowlens] sidePanel.setPanelBehavior failed:', err));

	chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
		void handleMessage(message, sender, sendResponse);
		return true; // keep the channel open for async sendResponse
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

	switch (type) {
		case 'ping':
			sendResponse({ type: 'pong', at: Date.now() });
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
			chunksUploaded: 0,
			lastFlushAt: Date.now(),
		};
		await chrome.tabs.sendMessage(tabId, { type: 'recorder_start', recordingId: start.recordingId });
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
	} catch (err) {
		console.warn('[Flowlens] chunk upload failed (will retry on next flush):', err);
	}
}

async function onSemanticAction(m: Record<string, unknown>): Promise<void> {
	if (!active) return;
	active.semanticActions.push(m.action);
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
		active.pendingScreenshots.push({ actionIndex, pngBase64: dataUrl });
	} catch (err) {
		console.warn('[Flowlens] screenshot capture failed', err);
	}
}

async function stopRecording(m: Record<string, unknown>): Promise<unknown> {
	if (!active) return { ok: false, reason: 'not recording' };
	const tabId = active.tabId;
	try {
		await chrome.tabs.sendMessage(tabId, { type: 'recorder_stop' });
	} catch {
		// content script may have unloaded
	}
	void m;

	// Capture final cookie + storage snapshot.
	const cookies = await captureCookies(active.siteOrigin);
	const storage = await captureStorage(tabId);

	const flowIdLocal = active.flowId;
	const recordingIdLocal = active.recordingId;
	const siteOriginLocal = active.siteOrigin;
	const actionsLocal = active.semanticActions;
	active = null;

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
			},
		});
		return { ok: true, flowId: flowIdLocal, finish: finishRes };
	} catch (err) {
		return { ok: false, reason: (err as Error).message, flowId: flowIdLocal };
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
