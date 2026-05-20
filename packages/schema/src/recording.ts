import { z } from 'zod';
import {
	HardenedSelectorsSchema,
	ControlTypeSchema,
	ControlConstraintsSchema,
	PageControlSummarySchema,
} from './flow';

/**
 * Action types observed during *recording* (DOM events).
 *
 * Distinct from `FlowStepAction` (the post-compile flow-step action set):
 *   - Recording captures `change` and `submit` (raw DOM events) but never
 *     `wait` / `assert` / `select` — those are synthesized by the compile
 *     pipeline as it normalizes raw events into a Flow document.
 *   - The compile pipeline maps `change` -> `input`, `submit` -> a chained
 *     click + `assert`, etc.
 */
export const RecordedActionTypeSchema = z.enum([
	'navigate',
	'click',
	'input',
	'change',
	'submit',
	'keypress',
	'scroll',
]);
export type RecordedActionType = z.infer<typeof RecordedActionTypeSchema>;

export const RecordedActionSchema = z.object({
	index: z.number().int().nonnegative(),
	timestamp: z.number().int().nonnegative(),
	type: RecordedActionTypeSchema,
	url: z.string(),
	selectors: HardenedSelectorsSchema,
	value: z.string().optional(),
	isSensitiveByHeuristic: z.boolean().default(false),
	rrwebEventId: z.number().int().nonnegative().optional(),
	screenshotKey: z.string().optional(),
	// Control-context (optional, populated only on form-control events).
	controlType: ControlTypeSchema.optional(),
	availableOptions: z.array(z.string()).optional(),
	constraints: ControlConstraintsSchema.optional(),
	controlName: z.string().optional(),
	// Set by the compile-pipeline normalizer when it coalesces a burst:
	// holds the recorder's original action index so resolveScreenshotUrl
	// can find the blob even after we re-index for display.
	screenshotLookupIndex: z.number().int().nonnegative().optional(),
});
export type RecordedAction = z.infer<typeof RecordedActionSchema>;

export const ViewportSchema = z.object({
	w: z.number().int().positive(),
	h: z.number().int().positive(),
	dpr: z.number().positive(),
});
export type Viewport = z.infer<typeof ViewportSchema>;

export const RecordingChunkMetaSchema = z.object({
	blobKey: z.string(),
	bytes: z.number().int().nonnegative(),
	ordinal: z.number().int().nonnegative(),
});
export type RecordingChunkMeta = z.infer<typeof RecordingChunkMetaSchema>;

// Re-use the canonical cookie/storage shapes defined in cookie.ts so the
// extension upload payload and the on-disk CookieSnapshot can never drift.
import { ChromeCookieSchema, StorageSnapshotSchema } from './cookie';

export const RecordingFinishPayloadSchema = z.object({
	cookies: z.array(ChromeCookieSchema),
	storage: StorageSnapshotSchema,
	origins: z.array(z.string()),
	actions: z.array(RecordedActionSchema),
	viewport: ViewportSchema,
	userAgent: z.string(),
	// Page-wide control inventory captured at recording stop (Part 2 of
	// flowlens-25). Optional — extensions running an older bundle won't
	// include it; the API tolerates absence and matrix-gen falls back to
	// "only-touched-controls" prompting.
	pageControls: z.array(PageControlSummarySchema).optional(),
});
export type RecordingFinishPayload = z.infer<typeof RecordingFinishPayloadSchema>;
