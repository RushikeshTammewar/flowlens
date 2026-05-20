/**
 * LLM client + phase-1 helper stubs.
 *
 * Every helper here has a stable signature and a Zod-validated return type so
 * phase 2 can fill in the bodies without breaking call sites. Phase 1 returns
 * deterministic placeholder values so the rest of the system compiles and
 * runs end-to-end.
 *
 * Phase 2 implementation guidance:
 *   - Prefer OpenAI v6's native Zod structured output via
 *     `client.chat.completions.parse({ response_format: zodResponseFormat(Schema, 'name'), ... })`
 *     (or `client.responses.parse(...)`). It removes JSON-parse failure modes
 *     entirely. Import path: `import { zodResponseFormat } from 'openai/helpers/zod'`.
 *   - Vision: pass image_url content blocks (`{ type: 'image_url', image_url: { url, detail: 'low' } }`).
 *   - Always thread `MODELS.<stage>` from `@flowlens/llm-config` — never inline a model string.
 *
 * Real implementations land per [LLD §5–§7](/docs/v3/LLD.md).
 *
 * Provider routing: `getLlmClient()` from @flowlens/llm-config returns either
 * a direct OpenAI client or an AzureOpenAI client (when LLM_PROVIDER=azure_foundry),
 * but the call surface (`client.chat.completions.parse/create`) is identical.
 */
import type OpenAI from 'openai';
import { z } from 'zod';
import { MODELS, getLlmClient } from '@flowlens/llm-config';

function getClient(): OpenAI {
	return getLlmClient();
}

// ────────────────────────────────────────────────────────────
// Schemas (return contracts)
// ────────────────────────────────────────────────────────────

export const NarrationOutputSchema = z.object({
	intent: z.string(),
	expectedOutcome: z.string(),
	isCritical: z.boolean(),
	fragility: z.enum(['low', 'medium', 'high']),
});
export type NarrationOutput = z.infer<typeof NarrationOutputSchema>;

export const FlowSynthesisOutputSchema = z.object({
	name: z.string(),
	description: z.string(),
	preconditions: z.array(z.string()),
	postconditions: z.array(z.string()),
	fragilityHints: z.array(z.string()),
	stepRevisions: z
		.array(
			z.object({
				index: z.number().int().nonnegative(),
				intentRevision: z.string().optional(),
				expectedOutcomeRevision: z.string().optional(),
			}),
		)
		.default([]),
});
export type FlowSynthesisOutput = z.infer<typeof FlowSynthesisOutputSchema>;

export const JudgeVerdictSchema = z.object({
	verdict: z.enum(['pass', 'fail']),
	reason: z.string(),
	confidence: z.number().min(0).max(1),
});
export type JudgeVerdict = z.infer<typeof JudgeVerdictSchema>;

export const TestDataOutputSchema = z.object({
	value: z.string(),
	rationale: z.string(),
});
export type TestDataOutput = z.infer<typeof TestDataOutputSchema>;

export const SiblingFlowsOutputSchema = z.object({
	flows: z
		.array(
			z.object({
				name: z.string(),
				description: z.string(),
				task: z.string(),
				rationale: z.string(),
			}),
		)
		.default([]),
});
export type SiblingFlowsOutput = z.infer<typeof SiblingFlowsOutputSchema>;

// ────────────────────────────────────────────────────────────
// Phase-1 stubs — TODO: real prompts in phase 2
// ────────────────────────────────────────────────────────────

export interface NarrateInput {
	prevImageBlobKey: string | null;
	currentImageBlobKey: string;
	actionType: string;
	url: string;
	pageTitle: string;
	recordedValue?: string;
	selectors: { role?: string; accessibleName?: string; testid?: string; css?: string };
}

/**
 * Convert one recorded action into a semantic step. Vision call.
 * TODO(phase-2): implement with `getClient().chat.completions.create({ model: MODELS.narrate, ... })`.
 */
export async function narrate(input: NarrateInput): Promise<NarrationOutput> {
	void input;
	void getClient;
	void MODELS.narrate;
	return NarrationOutputSchema.parse({
		intent: '(phase-1 stub: narration not implemented)',
		expectedOutcome: '(phase-1 stub: outcome not implemented)',
		isCritical: false,
		fragility: 'low',
	});
}

export interface JudgeInput {
	expectedOutcome: string;
	replayScreenshotBlobKey: string;
	recordedScreenshotBlobKey: string;
}

/**
 * T3 AI judge. Yes/no verdict + reason. Vision call.
 * TODO(phase-2): implement with structured output schema.
 */
export async function judge(input: JudgeInput): Promise<JudgeVerdict> {
	void input;
	void MODELS.judge;
	return JudgeVerdictSchema.parse({
		verdict: 'pass',
		reason: '(phase-1 stub: judge not implemented)',
		confidence: 0.5,
	});
}

export interface SynthesizeInput {
	siteOrigin: string;
	siteModelText: string | null;
	narratedSteps: Array<{ intent: string; expectedOutcome: string; isCritical: boolean }>;
}

/**
 * Synthesize the Flow document from narrated steps. Text-only.
 * TODO(phase-2): implement with `MODELS.synthesize`.
 */
export async function synthesize(input: SynthesizeInput): Promise<FlowSynthesisOutput> {
	void input;
	void MODELS.synthesize;
	return FlowSynthesisOutputSchema.parse({
		name: '(phase-1 stub) Untitled flow',
		description: '(phase-1 stub: synthesis not implemented)',
		preconditions: [],
		postconditions: [],
		fragilityHints: [],
		stepRevisions: [],
	});
}

export interface DataGenInput {
	field: string;
	fieldType: 'email' | 'username' | 'name' | 'address' | 'phone' | 'text' | 'number' | 'other';
	recordedValue: string | null;
	flowGoal: string;
	uniquenessSeed: string;
}

/**
 * Generate fresh test data for a single field at replay time.
 * TODO(phase-2): implement with `MODELS.dataGen`. For known field types we can
 * skip the LLM entirely (uuid-suffixed emails, faker for names, etc.).
 */
export async function dataGen(input: DataGenInput): Promise<TestDataOutput> {
	void MODELS.dataGen;
	if (input.fieldType === 'email') {
		return TestDataOutputSchema.parse({
			value: `flowlens+${input.uniquenessSeed}@example.com`,
			rationale: 'Deterministic uniqueness-seeded email; no LLM call.',
		});
	}
	return TestDataOutputSchema.parse({
		value: input.recordedValue ?? '',
		rationale: '(phase-1 stub: data generator falls through to recorded value)',
	});
}

export interface SiblingFlowsInput {
	siteOrigin: string;
	parentFlow: { name: string; description: string; intentSummary: string };
	maxFlows?: number;
}

/**
 * Suggest 1–3 sibling flows after a recording. Lightweight creative call.
 * TODO(phase-2): implement with `MODELS.siblingGen`.
 */
export async function suggestSiblingFlows(
	input: SiblingFlowsInput,
): Promise<SiblingFlowsOutput> {
	void input;
	void MODELS.siblingGen;
	return SiblingFlowsOutputSchema.parse({ flows: [] });
}

// ────────────────────────────────────────────────────────────
// Health check helper (used by /api/health route)
// ────────────────────────────────────────────────────────────

/**
 * @deprecated prefer `hasLlmCredentials()` from `@flowlens/llm-config` which
 * is provider-aware. Kept for back-compat with /api/health.
 */
export function hasOpenAiKey(): boolean {
	return !!process.env.OPENAI_API_KEY?.trim();
}
