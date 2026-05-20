#!/usr/bin/env node
/**
 * End-to-end smoke for the matrix generator across providers.
 *
 * Calls `generateTestMatrix()` with a tiny synthetic flow, once per provider.
 * Confirms the provider routing reaches generate-matrix.ts.
 *
 * No DB writes — generates variants in memory and prints them.
 */
import './load-env.mjs';
import { generateTestMatrix } from '@flowlens/flow-doc';
import { getProvider, modelFor } from '@flowlens/llm-config';

const TINY_FLOW = {
	id: 'smoke-flow',
	name: 'login with email and password',
	description: 'User signs into example.com with email + password',
	preconditions: ['user has an account'],
	steps: [
		{
			index: 0,
			action: 'navigate',
			intent: 'go to login page',
			expectedOutcome: 'login form visible',
			isCritical: false,
		},
		{
			index: 1,
			action: 'input',
			intent: 'enter email address',
			expectedOutcome: 'email field filled',
			isCritical: true,
			recordedValue: 'user@example.com',
			isSensitive: false,
		},
		{
			index: 2,
			action: 'input',
			intent: 'enter password',
			expectedOutcome: 'password field filled',
			isCritical: true,
			recordedValue: 'hunter2',
			isSensitive: true,
		},
		{
			index: 3,
			action: 'click',
			intent: 'click sign in button',
			expectedOutcome: 'redirected to dashboard',
			isCritical: true,
		},
	],
};

async function probeMatrix() {
	const provider = getProvider();
	const model = modelFor('matrixGenerator');
	const t0 = Date.now();
	try {
		const r = await generateTestMatrix({ flow: TINY_FLOW, count: 5 });
		return {
			provider,
			requestedModel: model,
			respondedModel: r.model,
			ok: true,
			latencyMs: Date.now() - t0,
			variantCount: r.variants.length,
			variantNames: r.variants.map((v) => `${v.family}: ${v.name}`),
			usage: r.usage,
		};
	} catch (err) {
		return {
			provider,
			requestedModel: model,
			ok: false,
			latencyMs: Date.now() - t0,
			error: err.message,
			status: err.status ?? null,
		};
	}
}

const want = (process.argv[2] ?? 'both').toLowerCase();

const savedOverrides = Object.fromEntries(
	Object.entries(process.env).filter(([k]) => k.startsWith('FLOWLENS_MODEL_')),
);
for (const k of Object.keys(savedOverrides)) delete process.env[k];

const results = {};
if (want === 'azure' || want === 'both') {
	process.env.LLM_PROVIDER = 'azure_foundry';
	results.azure = await probeMatrix();
}
if (want === 'openai' || want === 'both') {
	process.env.LLM_PROVIDER = 'openai';
	results.openai = await probeMatrix();
}

for (const [k, v] of Object.entries(savedOverrides)) process.env[k] = v;

console.log(JSON.stringify(results, null, 2));
process.exit(0);
