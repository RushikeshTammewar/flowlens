/**
 * LLM-fallback sensitive-data classifier. Only called when the regex/input-type
 * heuristic in @flowlens/recorder-core returned `isSensitive=false` but the
 * field name or context is suspicious.
 */
import { z } from 'zod';
import { MODELS } from '@flowlens/llm-config';
import { structuredCall } from './structured';
import { SENSITIVE_SYSTEM_PROMPT } from './prompts';

export const SensitiveClassifyOutputSchema = z.object({
	isSensitive: z.boolean(),
	confidence: z.number().min(0).max(1),
	reason: z.string().max(140),
});
export type SensitiveClassifyOutput = z.infer<typeof SensitiveClassifyOutputSchema>;

export interface SensitiveClassifyInput {
	fieldName: string;
	fieldId: string;
	placeholder: string;
	autocomplete: string;
	surroundingLabelText: string;
}

export async function classifySensitive(input: SensitiveClassifyInput): Promise<{
	value: SensitiveClassifyOutput;
	usage: { promptTokens: number; completionTokens: number; totalTokens: number };
	model: string;
}> {
	const userText = [
		`Field name: ${input.fieldName || '(none)'}`,
		`Field id: ${input.fieldId || '(none)'}`,
		`Placeholder: ${input.placeholder || '(none)'}`,
		`Autocomplete: ${input.autocomplete || '(none)'}`,
		`Surrounding label text: ${input.surroundingLabelText || '(none)'}`,
	].join('\n');

	return structuredCall({
		model: MODELS.sensitiveClassifier,
		systemPrompt: SENSITIVE_SYSTEM_PROMPT,
		userContent: userText,
		schema: SensitiveClassifyOutputSchema,
		schemaName: 'SensitiveClassification',
		maxOutputTokens: 200,
	});
}
