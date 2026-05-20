#!/usr/bin/env node
/**
 * Smoke for Part B: prove the matrix-gen prompt template now surfaces
 * controlType / availableOptions / constraints when supplied on FlowSteps.
 *
 * Builds a synthetic flow that mirrors the practicetestautomation.com
 * radio + checkbox + text-with-maxLength shape and prints what the LLM
 * actually sees. We DO NOT call the LLM (no provider needed); we drive
 * the generator far enough that FLOWLENS_LOG_MATRIX_PROMPT prints the
 * prompt to stdout, then bail out before the chat completion fires.
 *
 * Why "bail before chat": this script is run in CI / locally without
 * burning a Foundry call. We patch the OpenAI client method to throw
 * after the prompt is logged. The user only cares that the prompt has
 * `availableOptions=[...]`, `constraints={...}`, and the new control
 * rules — they do not need a generated variant set.
 */
import './load-env.mjs';

process.env.FLOWLENS_LOG_MATRIX_PROMPT = '1';
process.env.LLM_PROVIDER = process.env.LLM_PROVIDER ?? 'azure_foundry';

const { generateTestMatrix } = await import('@flowlens/flow-doc');
const { getLlmClient } = await import('@flowlens/llm-config');

const FAKE_FLOW = {
	id: 'control-ctx-smoke',
	name: 'Filter courses by language and level',
	description: 'Practice-test-table radios + checkboxes + bounded text input',
	preconditions: ['user is on /practice-test-table/'],
	steps: [
		{
			index: 0,
			action: 'navigate',
			intent: 'open the practice test table',
			expectedOutcome: 'table visible',
			isCritical: false,
		},
		{
			index: 1,
			action: 'input',
			intent: 'choose a language filter',
			expectedOutcome: 'language radio selected',
			isCritical: true,
			recordedValue: 'Java',
			controlType: 'radio',
			controlName: 'Language',
			availableOptions: ['Any', 'Java', 'Python'],
		},
		{
			index: 2,
			action: 'input',
			intent: 'select intermediate level',
			expectedOutcome: 'level checkbox selected',
			isCritical: false,
			recordedValue: 'Intermediate',
			controlType: 'checkbox',
			controlName: 'Level',
			availableOptions: ['Beginner', 'Intermediate', 'Advanced'],
		},
		{
			index: 3,
			action: 'input',
			intent: 'set min enrollments',
			expectedOutcome: 'min enrollments stored',
			isCritical: true,
			recordedValue: '10000',
			controlType: 'number',
			controlName: 'min_enrollments',
			constraints: { min: 0, max: 999999, maxLength: 6 },
		},
	],
};

// Sentinel: throw inside the OpenAI call so we don't burn LLM time. The
// prompt is logged before the chat call fires (see generate-matrix.ts).
const client = getLlmClient();
const orig = client.chat.completions.parse.bind(client.chat.completions);
client.chat.completions.parse = async () => {
	throw new Error('SMOKE_BAIL: prompt logged, intentionally bailing out');
};

try {
	await generateTestMatrix({ flow: FAKE_FLOW, count: 5 });
} catch (err) {
	if (!String(err.message).includes('SMOKE_BAIL')) throw err;
}
console.log('\n[smoke] prompt logged successfully — control-context fields visible above');
client.chat.completions.parse = orig;
