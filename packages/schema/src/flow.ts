import { z } from 'zod';

export const HardenedSelectorsSchema = z.object({
	role: z.string().optional(),
	accessibleName: z.string().optional(),
	testid: z.string().optional(),
	css: z.string().optional(),
	xpath: z.string().optional(),
	flowlensId: z.string().optional(),
});
export type HardenedSelectors = z.infer<typeof HardenedSelectorsSchema>;

/**
 * Control-context — UI-shape metadata captured at recording time. Lives in
 * flow.ts (not recording.ts) so FlowStepSchema can reference it without
 * pulling in cookie/storage schemas. Re-exported from recording.ts so
 * existing `import { ControlType } from '@flowlens/schema'` keeps working.
 */
export const ControlTypeSchema = z.enum([
	'radio',
	'checkbox',
	'select',
	'text',
	'number',
	'email',
	'password',
	'textarea',
	'unknown',
]);
export type ControlType = z.infer<typeof ControlTypeSchema>;

export const ControlConstraintsSchema = z.object({
	minLength: z.number().int().nonnegative().optional(),
	maxLength: z.number().int().nonnegative().optional(),
	min: z.number().optional(),
	max: z.number().optional(),
	pattern: z.string().optional(),
});
export type ControlConstraints = z.infer<typeof ControlConstraintsSchema>;

/**
 * Page-wide form control inventory captured ONCE at recording stop. Surfaces
 * EVERY control on the page (not just the ones the user touched) so matrix-gen
 * can generate combinatorial variants — e.g. "user filtered by language;
 * combine with min-enrollments=10000 (untouched control) to test filter +
 * threshold interaction".
 *
 * Lives in the recording's NDJSON action-stream blob as an envelope line at
 * the head of the file (no separate column / no DB migration needed).
 *
 * `kind` covers the broad input class so the prompt can describe it cleanly
 * even when `controlType` is `unknown`. `interactedDuringRecording` mirrors
 * whether ANY captured action targeted this control by name/id, so the
 * prompt can say "(USER DID NOT TOUCH — currently empty)".
 */
export const PageControlSummarySchema = z.object({
	kind: z.enum(['input', 'textarea', 'select', 'submit', 'button', 'radioGroup', 'checkboxGroup']),
	controlType: ControlTypeSchema.optional(),
	name: z.string().optional(),
	id: z.string().optional(),
	label: z.string().optional(),
	value: z.string().optional(),
	availableOptions: z.array(z.string()).optional(),
	constraints: ControlConstraintsSchema.optional(),
	interactedDuringRecording: z.boolean().default(false),
});
export type PageControlSummary = z.infer<typeof PageControlSummarySchema>;

export const FlowStepActionSchema = z.enum([
	'navigate',
	'click',
	'input',
	'select',
	'keypress',
	'wait',
	'assert',
	'scroll',
]);
export type FlowStepAction = z.infer<typeof FlowStepActionSchema>;

export const FlowStepSchema = z.object({
	index: z.number().int().nonnegative(),
	action: FlowStepActionSchema,
	intent: z.string(),
	expectedOutcome: z.string(),
	isCritical: z.boolean(),
	selectors: HardenedSelectorsSchema,
	recordedValue: z.string().optional(),
	isSensitive: z.boolean().default(false),
	recordedScreenshotKey: z.string(),
	url: z.string().optional(),
	durationMsHint: z.number().int().nonnegative().optional(),
	// Control-context plumbed through from RecordedAction for matrix-gen
	// constraint awareness. Optional — older flows compiled before Fix 1
	// won't have these populated.
	controlType: ControlTypeSchema.optional(),
	availableOptions: z.array(z.string()).optional(),
	constraints: ControlConstraintsSchema.optional(),
	controlName: z.string().optional(),
});
export type FlowStep = z.infer<typeof FlowStepSchema>;

export const FlowSourceSchema = z.enum(['recorded', 'ai_suggested', 'manual']);
export type FlowSource = z.infer<typeof FlowSourceSchema>;

export const FlowStatusSchema = z.enum(['draft', 'compiling', 'ready', 'archived']);
export type FlowStatus = z.infer<typeof FlowStatusSchema>;

export const FlowSchema = z.object({
	id: z.string().uuid(),
	orgId: z.string().uuid(),
	siteId: z.string().uuid(),
	createdByUserId: z.string().uuid(),
	name: z.string().min(1).max(200),
	description: z.string().nullable(),
	source: FlowSourceSchema,
	preconditions: z.array(z.string()).default([]),
	postconditions: z.array(z.string()).default([]),
	fragilityHints: z.array(z.string()).default([]),
	steps: z.array(FlowStepSchema),
	rrwebBlobKey: z.string().nullable(),
	cookieSnapshotId: z.string().uuid().nullable(),
	buProfileId: z.string().nullable(),
	parentFlowId: z.string().uuid().nullable(),
	status: FlowStatusSchema,
	createdAt: z.string().datetime(),
	updatedAt: z.string().datetime(),
});
export type Flow = z.infer<typeof FlowSchema>;
