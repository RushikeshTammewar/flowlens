/**
 * Content script. Owns two jobs:
 *  1. Listen for `recorder_start` / `recorder_stop` from the background.
 *  2. Instantiate @flowlens/recorder-core and pipe its events back.
 *
 * The in-page floating overlay (see `./overlay.ts`) is intentionally not
 * mounted: the side panel is the single source of truth for recording
 * controls. `overlay.ts` is left on disk in case we want to restore the
 * in-page widget later.
 */
import { defineContentScript } from 'wxt/utils/define-content-script';
import {
	extractPageControls,
	startRecorder,
	type RecorderHandle,
} from '@flowlens/recorder-core';

export default defineContentScript({
	matches: ['<all_urls>'],
	runAt: 'document_idle',

	main() {
		console.log('[Flowlens] content script ready on', location.href);

		let recorder: RecorderHandle | null = null;
		// Track which controls the user touched during the recording so the
		// page-wide inventory captured at stop can flag untouched controls.
		// Cheap to maintain — one Set.add per semantic action with a target.
		const touchedKeys = new Set<string>();

		chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
			if (typeof message !== 'object' || message === null) return false;
			const m = message as Record<string, unknown>;

			if (m.type === 'recorder_start') {
				if (recorder?.isRunning()) {
					sendResponse({ ok: false, reason: 'already running' });
					return true;
				}
				touchedKeys.clear();
				recorder = startRecorder({
					onChunk: ({ ordinal, gzipped }) => {
						void chrome.runtime.sendMessage({
							type: 'rrweb_chunk',
							ordinal,
							gzippedBase64: bytesToBase64(gzipped),
						});
					},
					onSemanticAction: (action) => {
						// Mirror the keys that `extractPageControls` matches on
						// (`name`, `id`, label) so the inventory's
						// `interactedDuringRecording` flag is accurate even
						// when the user only touched a subset of controls.
						const sel = action.selectors as
							| { testid?: string; flowlensId?: string; accessibleName?: string }
							| undefined;
						if (sel?.testid) touchedKeys.add(sel.testid);
						if (sel?.flowlensId) touchedKeys.add(sel.flowlensId);
						if (sel?.accessibleName) touchedKeys.add(sel.accessibleName);
						const cn = (action as { controlName?: string }).controlName;
						if (cn) touchedKeys.add(cn);
						void chrome.runtime.sendMessage({ type: 'semantic_action', action });
					},
					onScreenshotRequest: ({ actionIndex, reason }) => {
						void chrome.runtime.sendMessage({ type: 'request_screenshot', actionIndex, reason });
					},
					onError: (err) => {
						console.warn('[Flowlens] recorder error', err);
					},
				});

				sendResponse({ ok: true });
				return true;
			}

			if (m.type === 'recorder_stop') {
				const r = recorder;
				recorder = null;
				if (!r) {
					sendResponse({ ok: false, reason: 'no recorder' });
					return true;
				}
				// Capture the page-wide form-control inventory BEFORE stop
				// resolves. Stopping rrweb doesn't tear down the DOM but the
				// page may navigate or the user may close the tab right
				// after, so doing the synchronous walk here is the safest
				// place. Failure here must never block the stop response —
				// the matrix prompt will simply fall back to the
				// touched-only path.
				let pageControls: unknown[] = [];
				try {
					pageControls = extractPageControls({ touchedKeys });
					console.log(
						`[Flowlens] captured ${pageControls.length} page controls at stop (touched=${touchedKeys.size})`,
					);
				} catch (err) {
					console.warn('[Flowlens] extractPageControls failed:', err);
				}
				// Forward inventory to the SW so it lands in the finish
				// payload alongside actions/cookies/storage.
				void chrome.runtime.sendMessage({ type: 'page_controls', items: pageControls });

				void r.stop().then(() => sendResponse({ ok: true }));
				return true;
			}

			// Pause / resume are kept as no-ops on the page: the recorder itself
			// (rrweb capture, semantic actions) is paused/resumed by the SW via
			// its own bookkeeping; there's no in-page UI to reflect the state.
			if (m.type === 'recorder_pause') return false;
			if (m.type === 'recorder_resume') return false;
			return false;
		});
	},
});

function bytesToBase64(bytes: Uint8Array): string {
	let bin = '';
	for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i] ?? 0);
	return btoa(bin);
}
