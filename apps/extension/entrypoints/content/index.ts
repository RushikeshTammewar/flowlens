/**
 * Content script. Owns three jobs:
 *  1. Listen for `recorder_start` / `recorder_stop` from the background.
 *  2. Instantiate @flowlens/recorder-core and pipe its events back.
 *  3. Mount the in-page recording overlay (anchored bottom-right) inside a
 *     Shadow Root so host-page CSS can't bleed in.
 *
 * The overlay is implemented in vanilla DOM (see `./overlay.ts`) to keep the
 * content-script bundle small. The side panel keeps the rich React + Framer
 * Motion experience.
 */
import { defineContentScript } from 'wxt/utils/define-content-script';
import { startRecorder, type RecorderHandle } from '@flowlens/recorder-core';
import { mountOverlay, type OverlayHandle } from './overlay';

export default defineContentScript({
	matches: ['<all_urls>'],
	runAt: 'document_idle',

	main() {
		console.log('[Flowlens] content script ready on', location.href);

		let recorder: RecorderHandle | null = null;
		let overlay: OverlayHandle | null = null;
		let shadowHost: HTMLElement | null = null;

		const teardownOverlay = () => {
			overlay?.destroy();
			overlay = null;
			shadowHost?.remove();
			shadowHost = null;
		};

		const setupOverlay = () => {
			if (overlay) return;
			shadowHost = document.createElement('div');
			shadowHost.setAttribute('data-flowlens-overlay', '');
			// Pinned style on the host to dodge inherited body styles (transforms,
			// stacking context). Inner styles live inside the shadow root.
			shadowHost.setAttribute(
				'style',
				'all: initial; position: fixed; inset: 0; pointer-events: none; z-index: 2147483646;',
			);
			document.documentElement.appendChild(shadowHost);
			const shadow = shadowHost.attachShadow({ mode: 'open' });
			const wrapper = document.createElement('div');
			wrapper.style.pointerEvents = 'auto';
			shadow.appendChild(wrapper);
			overlay = mountOverlay(wrapper, {
				onNote: (text) => {
					void chrome.runtime.sendMessage({ type: 'overlay_note', text });
				},
				onPause: () => {
					void chrome.runtime.sendMessage({ type: 'overlay_pause' });
				},
				onResume: () => {
					void chrome.runtime.sendMessage({ type: 'overlay_resume' });
				},
				onStop: () => {
					void chrome.runtime.sendMessage({ type: 'stop_recording' });
				},
			});
		};

		chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
			if (typeof message !== 'object' || message === null) return false;
			const m = message as Record<string, unknown>;

			if (m.type === 'recorder_start') {
				if (recorder?.isRunning()) {
					sendResponse({ ok: false, reason: 'already running' });
					return true;
				}
				recorder = startRecorder({
					onChunk: ({ ordinal, gzipped }) => {
						void chrome.runtime.sendMessage({
							type: 'rrweb_chunk',
							ordinal,
							gzippedBase64: bytesToBase64(gzipped),
						});
					},
					onSemanticAction: (action) => {
						overlay?.bumpAction();
						void chrome.runtime.sendMessage({ type: 'semantic_action', action });
					},
					onScreenshotRequest: ({ actionIndex, reason }) => {
						void chrome.runtime.sendMessage({ type: 'request_screenshot', actionIndex, reason });
					},
					onError: (err) => {
						console.warn('[Flowlens] recorder error', err);
					},
				});
				setupOverlay();
				sendResponse({ ok: true });
				return true;
			}

			if (m.type === 'recorder_stop') {
				const r = recorder;
				recorder = null;
				teardownOverlay();
				if (!r) {
					sendResponse({ ok: false, reason: 'no recorder' });
					return true;
				}
				void r.stop().then(() => sendResponse({ ok: true }));
				return true;
			}

			if (m.type === 'recorder_pause') {
				overlay?.setPaused(true);
				return false;
			}
			if (m.type === 'recorder_resume') {
				overlay?.setPaused(false);
				return false;
			}
			return false;
		});

		// Tear down if the page unloads mid-recording.
		window.addEventListener('beforeunload', teardownOverlay);
	},
});

function bytesToBase64(bytes: Uint8Array): string {
	let bin = '';
	for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i] ?? 0);
	return btoa(bin);
}
