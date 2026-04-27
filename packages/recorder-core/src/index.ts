export { startRecorder, type RecorderHandle, type RecorderCallbacks } from './record';
export {
	createScreenshotScheduler,
	type ScreenshotScheduler,
	type ScreenshotRequester,
} from './screenshot-scheduler';
export {
	hardenSelectors,
	type SelectorContext,
} from './selector-harden';
export {
	detectSensitive,
	type SensitiveCheckInput,
} from './sensitive-detect';
export {
	rrwebToActionStream,
	type ActionStreamOptions,
} from './action-stream';
export {
	createNdjsonChunker,
	type NdjsonChunker,
	type ChunkEmitted,
} from './chunker';
