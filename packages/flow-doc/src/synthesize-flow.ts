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
 */
import { z } from 'zod';
import type OpenAI from 'openai';
import type { PageControlSummary } from '@flowlens/schema';
import { MODELS } from '@flowlens/llm-config';
import { imageContent, structuredCall, textContent } from './structured';
import { SYNTHESIZE_SYSTEM_PROMPT } from './prompts';

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
