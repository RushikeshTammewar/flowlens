/**
 * Wire types shared with the Python sidecar (apps/replay-worker).
 *
 * MUST match `apps/replay-worker/app/contracts.py` field names exactly. We do
 * not alias across the wire — Pydantic's camelCase fields and our Zod schemas
 * are the same on both sides.
 */
import { z } from 'zod';
import { HardenedSelectorsSchema } from '@flowlens/schema';

export const WorkerJudgeVerdictSchema = z.object({
	verdict: z.enum(['pass', 'fail']),
	reason: z.string(),
	confidence: z.number().min(0).max(1),
});
export type WorkerJudgeVerdict = z.infer<typeof WorkerJudgeVerdictSchema>;

export const WorkerSelectorResolvedViaSchema = z.enum([
	'testid',
	'role-name',
	'css',
	'xpath',
	'flowlens-id',
	'llm',
	'recorded-only',
]);

export const WorkerStepResultSchema = z.object({
	runId: z.string(),
	stepIndex: z.number().int().nonnegative(),
	status: z.enum(['passed', 'failed', 'flaky', 'blocked_auth', 'inconclusive', 'skipped']),
	durationMs: z.number().int().nonnegative(),
	selectorResolvedVia: WorkerSelectorResolvedViaSchema.nullable().optional(),
	replayScreenshotBlobKey: z.string().nullable().optional(),
	judge: WorkerJudgeVerdictSchema.nullable().optional(),
	consoleErrors: z.array(z.string()).default([]),
	networkErrors: z.array(z.unknown()).default([]),
	llmStepsUsed: z.number().int().nonnegative().default(0),
	llmCostUsdMicro: z.number().int().nonnegative().default(0),
	errorMessage: z.string().nullable().optional(),
});
export type WorkerStepResult = z.infer<typeof WorkerStepResultSchema>;

export const StepStartedEventSchema = z.object({
	type: z.literal('step_started'),
	runId: z.string(),
	stepIndex: z.number().int().nonnegative(),
});
export type StepStartedEvent = z.infer<typeof StepStartedEventSchema>;

export const StepFinishedEventSchema = z.object({
	type: z.literal('step_finished'),
	result: WorkerStepResultSchema,
});
export type StepFinishedEvent = z.infer<typeof StepFinishedEventSchema>;

export const RunPausedEventSchema = z.object({
	type: z.literal('run_paused'),
	runId: z.string(),
	reason: z.enum(['auth', 'user']),
	hint: z.string(),
	blockedAtStepIndex: z.number().int().nonnegative(),
});
export type RunPausedEvent = z.infer<typeof RunPausedEventSchema>;

export const RunCompleteEventSchema = z.object({
	type: z.literal('run_complete'),
	runId: z.string(),
	status: z.enum(['passed', 'failed', 'errored']),
	healthScore: z.number().int().min(0).max(100),
	summary: z.string(),
	errorClass: z.enum(['app_bug', 'flaky', 'env', 'auth']).nullable().optional(),
});
export type RunCompleteEvent = z.infer<typeof RunCompleteEventSchema>;

export const ReplayWorkerEventSchema = z.discriminatedUnion('type', [
	StepStartedEventSchema,
	StepFinishedEventSchema,
	RunPausedEventSchema,
	RunCompleteEventSchema,
]);
export type ReplayWorkerEvent = z.infer<typeof ReplayWorkerEventSchema>;

// ─── /run request (mirrors Python RunRequest) ────────────────────────────────

export const WorkerFlowStepSchema = z.object({
	index: z.number().int().nonnegative(),
	action: z.enum(['navigate', 'click', 'input', 'select', 'keypress', 'wait', 'assert', 'scroll']),
	intent: z.string(),
	expectedOutcome: z.string(),
	isCritical: z.boolean(),
	selectors: HardenedSelectorsSchema,
	recordedValue: z.string().optional(),
	isSensitive: z.boolean().default(false),
	recordedScreenshotKey: z.string().default(''),
	url: z.string().optional(),
});
export type WorkerFlowStep = z.infer<typeof WorkerFlowStepSchema>;

export const WorkerFlowSchema = z.object({
	id: z.string(),
	name: z.string(),
	siteOrigin: z.string(),
	steps: z.array(WorkerFlowStepSchema),
});
export type WorkerFlow = z.infer<typeof WorkerFlowSchema>;

export const RunRequestSchema = z.object({
	runId: z.string(),
	flow: WorkerFlowSchema,
	cdpUrl: z.string(),
	liveUrl: z.string().nullable().optional(),
	mode: z.object({ name: z.enum(['hybrid', 'fast', 'full_llm']).default('hybrid') }).default({}),
	recordedScreenshotsByIndex: z.record(z.string(), z.string()).default({}),
	sensitiveData: z.record(z.string(), z.string()).default({}),
});
export type RunRequest = z.infer<typeof RunRequestSchema>;

// ─── /resolve ────────────────────────────────────────────────────────────────

export const ResolveRequestSchema = z.object({
	cdpUrl: z.string(),
	selectors: HardenedSelectorsSchema,
});
export type ResolveRequest = z.infer<typeof ResolveRequestSchema>;

export const ResolveResultSchema = z.discriminatedUnion('found', [
	z.object({
		found: z.literal(true),
		backendNodeId: z.number().int(),
		via: WorkerSelectorResolvedViaSchema,
	}),
	z.object({
		found: z.literal(false),
		reason: z.enum(['no_match', 'multiple_matches', 'page_not_settled']),
	}),
]);
export type ResolveResult = z.infer<typeof ResolveResultSchema>;
