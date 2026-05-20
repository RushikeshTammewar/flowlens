/**
 * Provider-resolution primitives. Lives in its own file (not index.ts) so
 * `./client.ts` can import it without circular-import hazards.
 */

export type LlmProvider = 'openai' | 'azure';

const DEFAULT_PROVIDER: LlmProvider = 'openai';

/**
 * Read the active provider from env. `azure_foundry` → `azure`; anything
 * else (or unset) → `openai`.
 */
export function getProvider(): LlmProvider {
	const raw = (process.env.LLM_PROVIDER ?? '').toLowerCase().trim();
	if (raw === 'azure_foundry' || raw === 'azure') return 'azure';
	if (raw === 'openai' || raw === '') return 'openai';
	if (typeof console !== 'undefined') {
		console.warn(
			`[llm-config] LLM_PROVIDER=${JSON.stringify(raw)} not recognized; falling back to '${DEFAULT_PROVIDER}'`,
		);
	}
	return DEFAULT_PROVIDER;
}
