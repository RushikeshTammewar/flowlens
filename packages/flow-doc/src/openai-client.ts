/**
 * Server-only LLM client used inside the compile pipeline.
 *
 * Delegates to `@flowlens/llm-config` so every workspace package shares one
 * provider-routing decision. When `LLM_PROVIDER=azure_foundry` this returns
 * an `AzureOpenAI` instance pointed at the Foundry resource; otherwise a
 * plain `OpenAI` instance against api.openai.com. Both expose the identical
 * `chat.completions.{create,parse}` surface so call sites don't change.
 */
import type OpenAI from 'openai';
import { getLlmClient } from '@flowlens/llm-config';

/**
 * Backwards-compat name. Real implementation lives in @flowlens/llm-config.
 * Old imports `import { getOpenAi } from './openai-client'` keep working.
 */
export function getOpenAi(): OpenAI {
	return getLlmClient();
}
