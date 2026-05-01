/**
 * Whole-flow synthesis after all steps are narrated. Vision-aware: when a
 * representative page screenshot is provided we attach it (low detail) so
 * gpt-4.1 can see the actual application surface. We also surface page-wide
 * control inventory + per-step controlType / recordedValue so the synthesized
 * flow doc reflects what's really on the page (touched + untouched controls)
 * instead of inferring from text-only step intents.
 *
 * Cost / latency: ~$0.005 extra per compile (one low-detail image), ~+1s
 * latency. Quality lift on `description` / `preconditions` /
 * `postconditions` / `fragilityHints` is significant — the model stops
 * inventing and starts describing what it sees.
 *
 * Phase 4 / Tier 2 — `synthesizeFlowWithContract()` is the additive
 * variant that ALSO emits a `featureContract` (universal Feature Contract
 * schema: featureName / inputs / expectedBehaviors / invariants). The V1
 * `synthesizeFlow()` is kept verbatim for callers that don't have Phase 4
 * enabled. Both functions share the same control-context plumbing.
 *
 * Feature flag: FLOWLENS_PHASE4_ENABLED (consumed by compile-inline.ts).
 * Logged under scope: [phase4:contract]
 * Migration item (LLD §19): row 6 (synthesize → contract).
 */
import { z } from 'zod';
import type OpenAI from 'openai';
import {
	type PageControlSummary,
	FeatureContractSchema,
	type FeatureContract,
} from '@flowlens/schema';
import { MODELS } from '@flowlens/llm-config';
import { imageContent, structuredCall, textContent } from './structured';
import {
	SYNTHESIZE_SYSTEM_PROMPT,
	SYNTHESIZE_WITH_CONTRACT_SYSTEM_PROMPT,
} from './prompts';

export const FlowSynthesisOutputSchema = z.object({
	name: z.string().min(1).max(120),
	description: z.string().max(400).default(''),
	preconditions: z.array(z.string().max(200)).default([]),
	postconditions: z.array(z.string().max(200)).default([]),
	fragilityHints: z.array(z.string().max(200)).default([]),
	// OpenAI's structured-output API requires every property to be marked
	// required AND nullable (instead of optional). The SDK's
	// `zodResponseFormat` converter respects `.nullable()` directly but emits
	// a shape OpenAI rejects when any field is just `.optional()`. Keep
	// these as required-nullable strings — the model emits `null` to mean
	// "no revision" and the compile pipeline reads it as
	// `revision?.intentRevision ?? narration.intent` so null falls through.
	stepRevisions: z
		.array(
			z.object({
				index: z.number().int().nonnegative(),
				intentRevision: z.string().max(280).nullable(),
				expectedOutcomeRevision: z.string().max(280).nullable(),
			}),
		)
		.default([]),
});
export type FlowSynthesisOutput = z.infer<typeof FlowSynthesisOutputSchema>;

export interface SynthesizeInput {
	siteOrigin: string;
	siteModelText: string | null;
	narratedSteps: Array<{
		index: number;
		actionType: string;
		intent: string;
		expectedOutcome: string;
		isCritical: boolean;
		// Optional richer context — when present, surfaced in the prompt so
		// synthesize understands the actual UI surface, not just intent text.
		recordedValue?: string | null;
		controlType?: string | null;
		controlName?: string | null;
		availableOptions?: string[] | null;
	}>;
	/**
	 * Optional page screenshot. Best pick: the first step where the user
	 * interacted with a form control (shows page layout + control state).
	 * Sent at `detail: 'low'` to keep cost negligible.
	 */
	pageScreenshotUrl?: string | null;
	/** Optional page-wide control inventory captured at recording stop. */
	pageControls?: PageControlSummary[] | null;
}

export async function synthesizeFlow(input: SynthesizeInput): Promise<{
	value: FlowSynthesisOutput;
	usage: { promptTokens: number; completionTokens: number; totalTokens: number };
	model: string;
}> {
	const stepBullets = input.narratedSteps
		.map((s) => {
			const meta: string[] = [];
			if (s.controlType) {
				meta.push(`controlType=${s.controlType}`);
				if (s.controlName) meta.push(`name="${s.controlName}"`);
				if (s.availableOptions && s.availableOptions.length > 0) {
					meta.push(`availableOptions=[${s.availableOptions.join(', ')}]`);
				}
			}
			if (s.recordedValue !== undefined && s.recordedValue !== null && s.recordedValue !== '') {
				meta.push(`recordedValue=${JSON.stringify(s.recordedValue)}`);
			}
			const metaSuffix = meta.length ? `\n    ${meta.join(' ')}` : '';
			return `- step ${s.index} [${s.actionType}, ${s.isCritical ? 'critical' : 'cosmetic'}]: ${s.intent} → ${s.expectedOutcome}${metaSuffix}`;
		})
		.join('\n');

	const controlsSection = (() => {
		if (!input.pageControls || input.pageControls.length === 0) return '';
		const lines = input.pageControls.map((c) => {
			const parts: string[] = [];
			parts.push(`${c.label || c.name || c.id || '<unnamed>'}: ${c.controlType}`);
			if (c.availableOptions && c.availableOptions.length > 0) {
				parts.push(`options=[${c.availableOptions.join(', ')}]`);
			}
			if (c.constraints) {
				const cons: string[] = [];
				if (c.constraints.minLength !== undefined) cons.push(`minLength=${c.constraints.minLength}`);
				if (c.constraints.maxLength !== undefined) cons.push(`maxLength=${c.constraints.maxLength}`);
				if (c.constraints.min !== undefined) cons.push(`min=${c.constraints.min}`);
				if (c.constraints.max !== undefined) cons.push(`max=${c.constraints.max}`);
				if (c.constraints.pattern) cons.push(`pattern=${c.constraints.pattern}`);
				if (cons.length) parts.push(`{${cons.join(',')}}`);
			}
			parts.push(c.interactedDuringRecording ? '(touched)' : '(NOT touched)');
			return ` - ${parts.join(' ')}`;
		});
		return [
			'',
			'All form controls visible on the page at recording end (whether the user touched them or not):',
			...lines,
		].join('\n');
	})();

	const userText = [
		`Site origin: ${input.siteOrigin}`,
		input.siteModelText ? `Site model:\n${input.siteModelText}` : 'Site model: (not yet generated)',
		controlsSection,
		'',
		'Narrated steps:',
		stepBullets,
	]
		.filter((s) => s !== '')
		.join('\n');

	const userContent: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [
		textContent(userText),
		...(input.pageScreenshotUrl
			? [imageContent({ url: input.pageScreenshotUrl, detail: 'low' as const })]
			: []),
	];

	return structuredCall({
		model: MODELS.synthesize,
		systemPrompt: SYNTHESIZE_SYSTEM_PROMPT,
		userContent,
		schema: FlowSynthesisOutputSchema,
		schemaName: 'FlowSynthesis',
		maxOutputTokens: 800,
	});
}

// ───────────────────────────────────────────────────────────────────────
// Phase 4 / Tier 2 — Feature Contract synthesis
//
// Same single-call shape as V1 (cost: one extra ~600 token completion),
// but the schema additionally requires the model to emit a structured
// `featureContract`. The contract is the input to mode-aware matrix-gen
// (Phase 4 / Tier 2b) and to the two-axis verdict aggregator (Tier 4b).
//
// We embed the FeatureContract Zod schema verbatim — it's the same source
// of truth used by `aggregate-batch-verdict.ts` (Tier 4b) and the web
// dashboard's report renderer (Tier 4c). One schema, three consumers.
// ───────────────────────────────────────────────────────────────────────

export const FlowSynthesisWithContractOutputSchema =
	FlowSynthesisOutputSchema.extend({
		featureContract: FeatureContractSchema,
	});
export type FlowSynthesisWithContractOutput = z.infer<
	typeof FlowSynthesisWithContractOutputSchema
>;

export async function synthesizeFlowWithContract(
	input: SynthesizeInput,
): Promise<{
	value: FlowSynthesisWithContractOutput;
	usage: { promptTokens: number; completionTokens: number; totalTokens: number };
	model: string;
}> {
	// Reuse the V1 prompt-building logic verbatim — only the system
	// prompt (asks for contract too) and schema (adds featureContract)
	// differ. Keeps the two paths in lockstep on control-context
	// formatting, page-controls inventory, screenshot wiring.
	const stepBullets = input.narratedSteps
		.map((s) => {
			const meta: string[] = [];
			if (s.controlType) {
				meta.push(`controlType=${s.controlType}`);
				if (s.controlName) meta.push(`name="${s.controlName}"`);
				if (s.availableOptions && s.availableOptions.length > 0) {
					meta.push(`availableOptions=[${s.availableOptions.join(', ')}]`);
				}
			}
			if (s.recordedValue !== undefined && s.recordedValue !== null && s.recordedValue !== '') {
				meta.push(`recordedValue=${JSON.stringify(s.recordedValue)}`);
			}
			const metaSuffix = meta.length ? `\n    ${meta.join(' ')}` : '';
			return `- step ${s.index} [${s.actionType}, ${s.isCritical ? 'critical' : 'cosmetic'}]: ${s.intent} → ${s.expectedOutcome}${metaSuffix}`;
		})
		.join('\n');

	const controlsSection = (() => {
		if (!input.pageControls || input.pageControls.length === 0) return '';
		const lines = input.pageControls.map((c) => {
			const parts: string[] = [];
			parts.push(`${c.label || c.name || c.id || '<unnamed>'}: ${c.controlType}`);
			if (c.availableOptions && c.availableOptions.length > 0) {
				parts.push(`options=[${c.availableOptions.join(', ')}]`);
			}
			if (c.constraints) {
				const cons: string[] = [];
				if (c.constraints.minLength !== undefined) cons.push(`minLength=${c.constraints.minLength}`);
				if (c.constraints.maxLength !== undefined) cons.push(`maxLength=${c.constraints.maxLength}`);
				if (c.constraints.min !== undefined) cons.push(`min=${c.constraints.min}`);
				if (c.constraints.max !== undefined) cons.push(`max=${c.constraints.max}`);
				if (c.constraints.pattern) cons.push(`pattern=${c.constraints.pattern}`);
				if (cons.length) parts.push(`{${cons.join(',')}}`);
			}
			parts.push(c.interactedDuringRecording ? '(touched)' : '(NOT touched)');
			return ` - ${parts.join(' ')}`;
		});
		return [
			'',
			'All form controls visible on the page at recording end (whether the user touched them or not):',
			...lines,
		].join('\n');
	})();

	const userText = [
		`Site origin: ${input.siteOrigin}`,
		input.siteModelText ? `Site model:\n${input.siteModelText}` : 'Site model: (not yet generated)',
		controlsSection,
		'',
		'Narrated steps:',
		stepBullets,
	]
		.filter((s) => s !== '')
		.join('\n');

	// Phase 4 — send the page screenshot at `high` detail (vs `low` in
	// V1). The contract extractor needs to read button labels, validation
	// hints, and option text to ground behaviors in what's actually
	// visible. ~+$0.01/call cost; matters for "AI as senior QA" quality.
	const userContent: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [
		textContent(userText),
		...(input.pageScreenshotUrl
			? [imageContent({ url: input.pageScreenshotUrl, detail: 'high' as const })]
			: []),
	];

	const startedAt = Date.now();
	const result = await structuredCall({
		model: MODELS.synthesize,
		systemPrompt: SYNTHESIZE_WITH_CONTRACT_SYSTEM_PROMPT,
		userContent,
		schema: FlowSynthesisWithContractOutputSchema,
		schemaName: 'FlowSynthesisWithContract',
		// Roughly +400 tokens for the contract block on top of the V1
		// budget. Leaves headroom for ~6 behaviors / ~10 inputs / ~5
		// invariants — well above the practical cap a senior QA would
		// extract from a single feature recording.
		maxOutputTokens: 1400,
	});

	const c = result.value.featureContract;
	console.info(
		`[phase4:contract] synthesized featureName=${JSON.stringify(c.featureName)} ` +
			`inputs=${c.inputs.length} behaviors=${c.expectedBehaviors.length} ` +
			`invariants=${c.invariants.length} model=${result.model} ` +
			`tokens=${result.usage.totalTokens} ${Date.now() - startedAt}ms`,
	);

	// Stamp synthesis metadata so downstream readers (web dashboard,
	// matrix-gen) can tell which model produced this contract.
	result.value.featureContract = {
		...c,
		synthesizedAt: new Date().toISOString(),
		synthesizedByModel: result.model,
	} satisfies FeatureContract;

	return result;
}
