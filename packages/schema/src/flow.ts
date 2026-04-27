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
