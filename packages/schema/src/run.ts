import { z } from 'zod';

export const RunStatusSchema = z.enum([
	'queued',
	'running',
	'paused_auth',
	'paused_user',
	'passed',
	'failed',
	'errored',
	'canceled',
]);
export type RunStatus = z.infer<typeof RunStatusSchema>;

export const RunTriggerSchema = z.enum(['user', 'schedule', 'webhook', 'sibling_chain']);
export type RunTrigger = z.infer<typeof RunTriggerSchema>;

export const StepStatusSchema = z.enum([
	'passed',
	'failed',
	'flaky',
	'blocked_auth',
	'inconclusive',
	'skipped',
]);
export type StepStatus = z.infer<typeof StepStatusSchema>;

export const SelectorResolvedViaSchema = z.enum([
	'testid',
	'role-name',
	'css',
	'xpath',
	'flowlens-id',
	'llm',
	'recorded-only',
]);
export type SelectorResolvedVia = z.infer<typeof SelectorResolvedViaSchema>;

export const T3JudgeVerdictSchema = z.object({
	verdict: z.enum(['pass', 'fail']),
	reason: z.string(),
	confidence: z.number().min(0).max(1),
});
export type T3JudgeVerdict = z.infer<typeof T3JudgeVerdictSchema>;

export const VisualDiffSchema = z.object({
	score: z.number().min(0).max(1),
	threshold: z.number().min(0).max(1),
	passed: z.boolean(),
	overlayKey: z.string(),
});
export type VisualDiff = z.infer<typeof VisualDiffSchema>;

export const StepResultSchema = z.object({
	id: z.string().uuid(),
	runId: z.string().uuid(),
	stepIndex: z.number().int().nonnegative(),
	status: StepStatusSchema,
	startedAt: z.string().datetime(),
	finishedAt: z.string().datetime().nullable(),
	durationMs: z.number().int().nonnegative().nullable(),
	selectorResolvedVia: SelectorResolvedViaSchema.nullable(),
	replayScreenshotKey: z.string().nullable(),
	judge: T3JudgeVerdictSchema.nullable(),
	visualDiff: VisualDiffSchema.nullable(),
	consoleErrors: z.array(z.string()).default([]),
	networkErrors: z.array(z.object({ url: z.string(), status: z.number().int() })).default([]),
	llmStepsUsed: z.number().int().nonnegative().default(0),
	llmCostUsdMicro: z.number().int().nonnegative().default(0),
	errorMessage: z.string().nullable(),
});
export type StepResult = z.infer<typeof StepResultSchema>;

export const RunSchema = z.object({
	id: z.string().uuid(),
	orgId: z.string().uuid(),
	flowId: z.string().uuid(),
	triggeredBy: RunTriggerSchema,
	triggeredByUserId: z.string().uuid().nullable(),
	status: RunStatusSchema,
	buSessionId: z.string().nullable(),
	buCdpUrl: z.string().nullable(),
	liveUrl: z.string().nullable(),
	publicShareToken: z.string().nullable(),
	startedAt: z.string().datetime().nullable(),
	finishedAt: z.string().datetime().nullable(),
	durationMs: z.number().int().nonnegative().nullable(),
	costUsdMicro: z.number().int().nonnegative().nullable(),
	workflowRunId: z.string().nullable(),
	healthScore: z.number().int().min(0).max(100).nullable(),
	summary: z.string().nullable(),
	errorClass: z.enum(['app_bug', 'flaky', 'env', 'auth']).nullable(),
	cookieSnapshotId: z.string().uuid().nullable(),
	createdAt: z.string().datetime(),
});
export type Run = z.infer<typeof RunSchema>;
