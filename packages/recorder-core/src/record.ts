/**
 * rrweb wrapper. Emits rrweb events through `onChunk` (NDJSON chunks),
 * notifies `onSemanticAction` whenever a user-visible interaction lands.
 *
 * Stays framework-agnostic so it can run in any content script context.
 */
import { record as rrwebRecord, type eventWithTime } from 'rrweb';

type StopFn = (() => void) | undefined;
import type { RecordedAction } from '@flowlens/schema';
import { hardenSelectors } from './selector-harden';
import { rrwebToActionStream } from './action-stream';
import { detectSensitive } from './sensitive-detect';
import { createNdjsonChunker } from './chunker';

export interface RecorderCallbacks {
	/** Called whenever a chunk of rrweb events is ready (~64KB or every flushEveryMs). */
	onChunk: (chunk: { ordinal: number; gzipped: Uint8Array; bytes: number }) => void;
	/** Called for each high-level user action (click, input, navigate, …). */
	onSemanticAction: (action: RecordedAction) => void;
	/** Called whenever an action wants a screenshot (debounced upstream). */
	onScreenshotRequest: (input: { actionIndex: number; reason: ScreenshotReason }) => void;
	/** Called once per recording when the underlying rrweb session ends. */
	onError?: (err: Error) => void;
}

export type ScreenshotReason = 'pointerdown' | 'change' | 'submit' | 'beforeunload' | 'navigate';

export interface RecorderHandle {
	stop: () => Promise<void>;
	pause: () => void;
	resume: () => void;
	isRunning: () => boolean;
}

export interface StartRecorderOptions extends RecorderCallbacks {
	/** Flush rrweb chunk every N ms even if size threshold not hit. Default 1500. */
	flushEveryMs?: number;
	/** Chunk size threshold in bytes (pre-gzip). Default 65_536. */
	chunkBytes?: number;
	/** Recording start timestamp; defaults to performance.timeOrigin. */
	startedAtEpochMs?: number;
}

export function startRecorder(opts: StartRecorderOptions): RecorderHandle {
	const startedAt = opts.startedAtEpochMs ?? Date.now();
	const chunker = createNdjsonChunker({
		chunkBytes: opts.chunkBytes ?? 65_536,
		flushEveryMs: opts.flushEveryMs ?? 1500,
		onChunk: opts.onChunk,
	});

	let paused = false;
	let actionIndex = 0;
	const semanticState = rrwebToActionStream({
		emit: (raw) => {
			if (paused) return;
			const ctx = raw.target;
			const selectors = ctx ? hardenSelectors({ element: ctx }) : {};
			const sensitive = ctx
				? detectSensitive({
						element: ctx,
						...(raw.value !== undefined ? { value: raw.value } : {}),
				  })
				: { isSensitive: false };

			const action: RecordedAction = {
				index: actionIndex++,
				timestamp: raw.timestamp - startedAt,
				type: raw.type,
				url: location.href,
				selectors,
				...(raw.value !== undefined && !sensitive.isSensitive ? { value: raw.value } : {}),
				isSensitiveByHeuristic: sensitive.isSensitive,
				...(raw.rrwebEventId !== undefined ? { rrwebEventId: raw.rrwebEventId } : {}),
			};
			opts.onSemanticAction(action);

			// Request a screenshot for every meaningful action; the scheduler
			// upstream debounces consecutive requests.
			const reason: ScreenshotReason | null =
				raw.type === 'click'
					? 'pointerdown'
					: raw.type === 'change' || raw.type === 'input'
						? 'change'
						: raw.type === 'submit'
							? 'submit'
							: raw.type === 'navigate'
								? 'navigate'
								: null;
			if (reason) {
				opts.onScreenshotRequest({ actionIndex: action.index, reason });
			}
		},
	});

	let stopFn: StopFn;
	try {
		stopFn = rrwebRecord({
			emit(event: eventWithTime) {
				if (paused) return;
				chunker.push(event);
				semanticState.handleRrwebEvent(event);
			},
			recordCanvas: false,
			collectFonts: false,
			sampling: {
				mousemove: 50,
				scroll: 100,
				input: 'last',
			},
			maskAllInputs: false, // we redact sensitive values per-field via heuristic
		});
	} catch (err) {
		opts.onError?.(err instanceof Error ? err : new Error(String(err)));
	}

	const onUnload = () => {
		opts.onScreenshotRequest({ actionIndex: actionIndex++, reason: 'beforeunload' });
	};
	window.addEventListener('beforeunload', onUnload);

	let stopped = false;

	return {
		isRunning: () => !stopped,
		pause: () => {
			paused = true;
		},
		resume: () => {
			paused = false;
		},
		stop: async () => {
			if (stopped) return;
			stopped = true;
			window.removeEventListener('beforeunload', onUnload);
			try {
				stopFn?.();
			} catch {
				// rrweb's stop is best-effort
			}
			await chunker.flushFinal();
		},
	};
}
