/**
 * Screenshot scheduler. Sits between the recorder (which emits
 * `onScreenshotRequest`) and the actual chrome.tabs.captureVisibleTab call
 * (which lives in the extension service worker).
 *
 * Responsibilities:
 *   - debounce consecutive screenshot requests at most 1/N ms
 *   - coalesce requests with the same (actionIndex) into one capture
 *   - call the supplied `requester` (which actually invokes
 *     chrome.tabs.captureVisibleTab) and pipe the result back via `onCaptured`
 */

export type ScreenshotRequester = (req: { actionIndex: number }) => Promise<{
	pngBase64: string;
} | null>;

export interface ScreenshotSchedulerOptions {
	/** Min interval between captures, ms. Default 250. */
	minIntervalMs?: number;
	requester: ScreenshotRequester;
	onCaptured: (capture: { actionIndex: number; pngBase64: string }) => void;
	onError?: (err: Error) => void;
}

export interface ScreenshotScheduler {
	request: (input: { actionIndex: number }) => void;
	flush: () => Promise<void>;
}

export function createScreenshotScheduler(
	opts: ScreenshotSchedulerOptions,
): ScreenshotScheduler {
	const minInterval = opts.minIntervalMs ?? 250;
	let lastCaptureAt = 0;
	let pending = new Map<number, number>(); // actionIndex -> queuedAt
	let timer: ReturnType<typeof setTimeout> | null = null;
	let inflight = 0;

	const drain = async () => {
		if (timer) {
			clearTimeout(timer);
			timer = null;
		}
		if (pending.size === 0) return;

		const now = Date.now();
		const dt = now - lastCaptureAt;
		if (dt < minInterval) {
			timer = setTimeout(() => void drain(), minInterval - dt);
			return;
		}

		// Take one — the latest queued is the most representative of "post-action".
		const entries = Array.from(pending.entries()).sort((a, b) => b[1] - a[1]);
		const winner = entries[0];
		if (!winner) return;
		const [actionIndex] = winner;
		pending.delete(actionIndex);
		lastCaptureAt = Date.now();
		inflight++;
		try {
			const res = await opts.requester({ actionIndex });
			if (res) opts.onCaptured({ actionIndex, pngBase64: res.pngBase64 });
		} catch (err) {
			opts.onError?.(err instanceof Error ? err : new Error(String(err)));
		} finally {
			inflight--;
		}

		if (pending.size > 0) {
			timer = setTimeout(() => void drain(), minInterval);
		}
	};

	return {
		request: ({ actionIndex }) => {
			pending.set(actionIndex, Date.now());
			if (!timer) {
				timer = setTimeout(() => void drain(), 50);
			}
		},
		flush: async () => {
			while (pending.size > 0 || inflight > 0) {
				await drain();
				if (pending.size > 0) await new Promise((r) => setTimeout(r, minInterval));
			}
		},
	};
}
