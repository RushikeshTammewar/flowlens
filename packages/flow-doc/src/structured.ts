/**
 * Tiny wrapper around OpenAI v6's native Zod structured-output helpers.
 *
 * Uses `chat.completions.parse` + `zodResponseFormat` so we never see a JSON
 * parse error: a malformed response either retries (handled upstream) or
 * throws a typed error. Every LLM call in flow-doc goes through this.
 */
import type OpenAI from 'openai';
import type { z } from 'zod';
import { zodResponseFormat } from 'openai/helpers/zod';
import { getOpenAi } from './openai-client';

export interface StructuredCallInput<T extends z.ZodTypeAny> {
	model: string;
	systemPrompt: string;
	userContent: OpenAI.Chat.Completions.ChatCompletionContentPart[] | string;
	schema: T;
	schemaName: string;
	temperature?: number;
	maxOutputTokens?: number;
}

export interface StructuredCallResult<T> {
	value: T;
	usage: {
		promptTokens: number;
		completionTokens: number;
		totalTokens: number;
	};
	model: string;
}

export async function structuredCall<T extends z.ZodTypeAny>(
	input: StructuredCallInput<T>,
): Promise<StructuredCallResult<z.infer<T>>> {
	const client = getOpenAi();
	const response = await client.chat.completions.parse({
		model: input.model,
		messages: [
			{ role: 'system', content: input.systemPrompt },
			{
				role: 'user',
				content: input.userContent as OpenAI.Chat.Completions.ChatCompletionUserMessageParam['content'],
			},
		],
		response_format: zodResponseFormat(input.schema, input.schemaName),
		...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
		...(input.maxOutputTokens !== undefined ? { max_completion_tokens: input.maxOutputTokens } : {}),
	});

	const choice = response.choices[0];
	if (!choice?.message.parsed) {
		throw new Error(
			`OpenAI structured-output parse failed for schema=${input.schemaName} model=${input.model}: ${choice?.message.refusal ?? 'no message'}`,
		);
	}

	return {
		value: choice.message.parsed as z.infer<T>,
		usage: {
			promptTokens: response.usage?.prompt_tokens ?? 0,
			completionTokens: response.usage?.completion_tokens ?? 0,
			totalTokens: response.usage?.total_tokens ?? 0,
		},
		model: input.model,
	};
}

export function imageContent(opts: { url: string; detail?: 'low' | 'high' | 'auto' }) {
	return {
		type: 'image_url' as const,
		image_url: { url: opts.url, detail: opts.detail ?? 'low' },
	};
}

export function textContent(text: string) {
	return { type: 'text' as const, text };
}
