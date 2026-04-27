/**
 * Suggest 1–3 sibling flows after a recording. Lightweight gpt-4.1-mini call.
 */
import { z } from 'zod';
import { MODELS } from '@flowlens/llm-config';
import { structuredCall } from './structured';
import { SIBLINGS_SYSTEM_PROMPT } from './prompts';

export const SiblingFlowSchema = z.object({
	name: z.string().min(1).max(120),
	description: z.string().max(400),
	task: z.string().min(1).max(800),
	rationale: z.string().max(280),
});
export const SiblingFlowsOutputSchema = z.object({
	flows: z.array(SiblingFlowSchema).max(3).default([]),
});
export type SiblingFlowsOutput = z.infer<typeof SiblingFlowsOutputSchema>;

export interface SiblingsInput {
	siteOrigin: string;
	parentFlow: { name: string; description: string };
	steps: Array<{ intent: string; expectedOutcome: string; isCritical: boolean }>;
}

export async function suggestSiblingFlows(input: SiblingsInput): Promise<{
	value: SiblingFlowsOutput;
	usage: { promptTokens: number; completionTokens: number; totalTokens: number };
	model: string;
}> {
	const userText = [
		`Site: ${input.siteOrigin}`,
		`Recorded flow: ${input.parentFlow.name} — ${input.parentFlow.description}`,
		'',
		'Recorded steps:',
		...input.steps.map(
			(s, i) => `- step ${i} [${s.isCritical ? 'critical' : 'cosmetic'}]: ${s.intent} → ${s.expectedOutcome}`,
		),
	].join('\n');

	return structuredCall({
		model: MODELS.siblingGen,
		systemPrompt: SIBLINGS_SYSTEM_PROMPT,
		userContent: userText,
		schema: SiblingFlowsOutputSchema,
		schemaName: 'SiblingFlows',
		maxOutputTokens: 700,
	});
}
