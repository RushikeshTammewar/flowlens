#!/usr/bin/env node
/**
 * Provider-routing smoke test for the LLM abstraction.
 *
 * Runs the same trivial completion via `getLlmClient()` against:
 *   1. The provider configured in .env.local (whatever `LLM_PROVIDER` is set to)
 *   2. The other provider, by overriding LLM_PROVIDER for that single iteration
 *
 * Reports response, latency, and resolved model name for each.
 *
 * Usage:
 *   node scripts/foundry-smoke.mjs           # both providers
 *   node scripts/foundry-smoke.mjs azure     # azure only
 *   node scripts/foundry-smoke.mjs openai    # openai only
 */
import './load-env.mjs';
import {
	getLlmClient,
	getProvider,
	hasLlmCredentials,
	modelFor,
} from '@flowlens/llm-config';

async function probe(stage = 'judge') {
	const provider = getProvider();
	const creds = hasLlmCredentials();
	const model = modelFor(stage);
	const overrideKey = process.env[
		`FLOWLENS_MODEL_${stage.replace(/[A-Z]/g, (c) => '_' + c).toUpperCase()}`
	];
	if (!creds.configured) {
		return {
			provider,
			model,
			modelOverridden: !!overrideKey,
			ok: false,
			error: `provider=${provider} but credentials missing (hasOpenai=${creds.hasOpenai}, hasAzure=${creds.hasAzure})`,
		};
	}
	const client = getLlmClient({ fresh: true });
	const t0 = Date.now();
	try {
		const r = await client.chat.completions.create({
			model,
			max_completion_tokens: 5,
			messages: [{ role: 'user', content: 'Reply with the single word OK.' }],
		});
		return {
			provider,
			model,
			modelOverridden: !!overrideKey,
			ok: true,
			latencyMs: Date.now() - t0,
			reply: r.choices[0]?.message?.content ?? '',
			usage: r.usage,
			respondedModel: r.model,
		};
	} catch (err) {
		return {
			provider,
			model,
			modelOverridden: !!overrideKey,
			ok: false,
			latencyMs: Date.now() - t0,
			error: err.message,
			status: err.status ?? null,
			code: err.code ?? null,
		};
	}
}

const want = (process.argv[2] ?? 'both').toLowerCase();

// Snapshot + temporarily clear FLOWLENS_MODEL_* overrides so each provider's
// default deployment is surfaced. Restore at end.
const savedOverrides = Object.fromEntries(
	Object.entries(process.env).filter(([k]) => k.startsWith('FLOWLENS_MODEL_')),
);
for (const k of Object.keys(savedOverrides)) delete process.env[k];

const results = {};
if (want === 'azure' || want === 'both') {
	process.env.LLM_PROVIDER = 'azure_foundry';
	results.azure = await probe();
}
if (want === 'openai' || want === 'both') {
	process.env.LLM_PROVIDER = 'openai';
	results.openai = await probe();
}

for (const [k, v] of Object.entries(savedOverrides)) process.env[k] = v;

console.log(JSON.stringify(results, null, 2));
process.exit(0);
