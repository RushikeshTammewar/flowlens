# @flowlens/recorder-core

Framework-agnostic Flowlens recording primitives. Used by the extension's
content script + (future) any other surface that needs to capture a flow.

## Surface

```ts
import {
	startRecorder,
	createScreenshotScheduler,
	hardenSelectors,
	detectSensitive,
	rrwebToActionStream,
	createNdjsonChunker,
} from '@flowlens/recorder-core';

const recorder = startRecorder({
	onChunk(chunk) {
		// chunk = { ordinal, gzipped: Uint8Array, bytes }
		// upload to /api/recordings/:id/chunks
	},
	onSemanticAction(action) {
		// action = RecordedAction (typed in @flowlens/schema)
	},
	onScreenshotRequest({ actionIndex, reason }) {
		screenshotScheduler.request({ actionIndex });
	},
});

const screenshotScheduler = createScreenshotScheduler({
	minIntervalMs: 250,
	async requester({ actionIndex }) {
		const png = await chrome.tabs.captureVisibleTab(); // service worker side
		return { pngBase64: png };
	},
	onCaptured({ actionIndex, pngBase64 }) {
		// upload screenshot
	},
});

// later:
await recorder.stop();
await screenshotScheduler.flush();
```

## What lives here vs the extension

- **Here**: pure DOM + rrweb logic, no `chrome.*` APIs.
- **Extension**: `chrome.tabs.captureVisibleTab`, `chrome.cookies.getAll`, the
  service-worker upload logic, the side panel UI.

## Testing

The package has zero `chrome.*` calls so it can be unit-tested in JSDOM.
