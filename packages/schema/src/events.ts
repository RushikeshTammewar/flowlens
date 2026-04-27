import { z } from 'zod';
import { StepResultSchema, RunStatusSchema } from './run';

export const SseEventSchema = z.discriminatedUnion('type', [
	z.object({
		type: z.literal('run_started'),
		runId: z.string().uuid(),
		liveUrl: z.string(),
	}),
	z.object({
		type: z.literal('step_started'),
		runId: z.string().uuid(),
		stepIndex: z.number().int().nonnegative(),
	}),
	z.object({
		type: z.literal('step_finished'),
		runId: z.string().uuid(),
		stepIndex: z.number().int().nonnegative(),
		result: StepResultSchema,
	}),
	z.object({
		type: z.literal('run_paused'),
		runId: z.string().uuid(),
		reason: z.enum(['auth', 'user']),
		hint: z.string(),
	}),
	z.object({
		type: z.literal('run_resumed'),
		runId: z.string().uuid(),
	}),
	z.object({
		type: z.literal('run_complete'),
		runId: z.string().uuid(),
		status: RunStatusSchema,
		healthScore: z.number().int().min(0).max(100).nullable(),
	}),
	z.object({
		type: z.literal('compile_progress'),
		flowId: z.string().uuid(),
		pct: z.number().int().min(0).max(100),
		stage: z.string(),
	}),
	z.object({
		type: z.literal('compile_complete'),
		flowId: z.string().uuid(),
	}),
]);
export type SseEvent = z.infer<typeof SseEventSchema>;

export const ExtensionMessageSchema = z.discriminatedUnion('type', [
	z.object({ type: z.literal('start_recording'), siteOrigin: z.string() }),
	z.object({ type: z.literal('stop_recording') }),
	z.object({ type: z.literal('pause_recording') }),
	z.object({ type: z.literal('resume_recording') }),
	z.object({ type: z.literal('rrweb_chunk'), payload: z.unknown() }),
	z.object({
		type: z.literal('semantic_action'),
		payload: z.object({
			index: z.number().int().nonnegative(),
			actionType: z.string(),
			url: z.string(),
			selectors: z.record(z.string(), z.string().optional()),
			value: z.string().optional(),
		}),
	}),
	z.object({ type: z.literal('refresh_auth'), siteOrigin: z.string() }),
]);
export type ExtensionMessage = z.infer<typeof ExtensionMessageSchema>;
