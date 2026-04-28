/**
 * Whole-flow synthesis after all steps are narrated. Text-only call to gpt-4.1.
 */
import { z } from 'zod';
import { MODELS } from '@flowlens/llm-config';
import { structuredCall } from './structured';
import { SYNTHESIZE_SYSTEM_PROMPT } from './prompts';

export const FlowSynthesisOutputSchema = z.object({
	name: z.string().min(1).max(120),
	description: z.string().max(400).default(''),
	preconditions: z.array(z.string().max(200)).default([]),
	postconditions: z.array(z.string().max(200)).default([]),
	fragilityHints: z.array(z.string().max(200)).default([]),
	// OpenAI's structured-output API rejects `.optional()` fields that aren't
	// also `.nullable()` (zod-to-json-schema emits a missing-field shape that
	// the API can't satisfy). Use `.nullable().optional()` so OpenAI can pass
	// `null` and we treat it as "no revision". The compile pipeline reads
	// these as `revision?.intentRevision ?? narration.intent` so null is fine.
	stepRevisions: z
		.array(
			z.object({
				index: z.number().int().nonnegative(),
				intentRevision: z.string().max(280).nullable().optional(),
				expectedOutcomeRevision: z.string().max(280).nullable().optional(),
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
	}>;
}

export async function synthesizeFlow(input: SynthesizeInput): Promise<{
	value: FlowSynthesisOutput;
	usage: { promptTokens: number; completionTokens: number; totalTokens: number };
	model: string;
}> {
	const stepBullets = input.narratedSteps
		.map(
			(s) =>
				`- step ${s.index} [${s.actionType}, ${s.isCritical ? 'critical' : 'cosmetic'}]: ${s.intent} → ${s.expectedOutcome}`,
		)
		.join('\n');

	const userText = [
		`Site origin: ${input.siteOrigin}`,
		input.siteModelText ? `Site model:\n${input.siteModelText}` : 'Site model: (not yet generated)',
		'',
		'Narrated steps:',
		stepBullets,
	].join('\n');

	return structuredCall({
		model: MODELS.synthesize,
		systemPrompt: SYNTHESIZE_SYSTEM_PROMPT,
		userContent: userText,
		schema: FlowSynthesisOutputSchema,
		schemaName: 'FlowSynthesis',
		maxOutputTokens: 800,
	});
}
