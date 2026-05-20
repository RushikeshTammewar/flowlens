/**
 * Per-step intent narration. Vision call. Cheap (gpt-4.1-mini).
 */
import { z } from 'zod';
import { MODELS } from '@flowlens/llm-config';
import { structuredCall, imageContent, textContent } from './structured';
import { NARRATE_SYSTEM_PROMPT } from './prompts';

export const NarrationOutputSchema = z.object({
	intent: z.string().min(1).max(280),
	expectedOutcome: z.string().min(1).max(280),
	isCritical: z.boolean(),
	fragility: z.enum(['low', 'medium', 'high']),
});
export type NarrationOutput = z.infer<typeof NarrationOutputSchema>;

export interface NarrateInput {
	prevScreenshotUrl: string | null;
	currentScreenshotUrl: string;
	actionType: string;
	url: string;
	pageTitle: string;
	recordedValue: string | null;
	selectors: { role?: string; accessibleName?: string; testid?: string; css?: string };
}

export async function narrateStep(input: NarrateInput): Promise<{
	value: NarrationOutput;
	usage: { promptTokens: number; completionTokens: number; totalTokens: number };
	model: string;
}> {
	const userParts = [
		textContent(
			`Action: ${input.actionType}\nURL: ${input.url}\nTitle: ${input.pageTitle}\nRecorded value: ${
				input.recordedValue ?? 'n/a'
			}\nSelectors: ${JSON.stringify(input.selectors)}\n\nThe first image is the page BEFORE the action. The second image is AFTER.`,
		),
		...(input.prevScreenshotUrl ? [imageContent({ url: input.prevScreenshotUrl, detail: 'low' })] : []),
		imageContent({ url: input.currentScreenshotUrl, detail: 'low' }),
	];

	return structuredCall({
		model: MODELS.narrate,
		systemPrompt: NARRATE_SYSTEM_PROMPT,
		userContent: userParts,
		schema: NarrationOutputSchema,
		schemaName: 'StepNarration',
		maxOutputTokens: 400,
	});
}
