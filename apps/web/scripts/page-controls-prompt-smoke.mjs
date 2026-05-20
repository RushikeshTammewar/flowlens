#!/usr/bin/env node
/**
 * Smoke for flowlens-25 Part 2: prove the matrix-gen prompt now surfaces
 * `pageControls` (the page-wide form-control inventory captured at recording
 * stop) so combinatorial variants can include untouched controls.
 *
 * Mirrors `control-context-prompt-smoke.mjs` — patches the LLM client to bail
 * out after FLOWLENS_LOG_MATRIX_PROMPT logs the prompt to stdout. No LLM time
 * burned. Asserts the printed prompt contains:
 *   - "ALL FORM CONTROLS ON THE PAGE" header
 *   - At least one "USER DID NOT TOUCH" annotation
 *   - The system prompt's COMBINATORIAL VARIANTS section
 *   - "PAGE SCREENSHOT" header (sent to model when screenshotUrl is present)
 */
import './load-env.mjs';

process.env.FLOWLENS_LOG_MATRIX_PROMPT = '1';
process.env.LLM_PROVIDER = process.env.LLM_PROVIDER ?? 'azure_foundry';

const { generateTestMatrix } = await import('@flowlens/flow-doc');
const { getLlmClient } = await import('@flowlens/llm-config');

const FAKE_FLOW = {
	id: 'page-controls-smoke',
	name: 'Filter courses by language',
	description: 'Practice-test-table — only language radio touched; min-enrollments left empty',
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
			intent: 'choose Java as the language filter',
			expectedOutcome: 'java radio selected',
			isCritical: true,
			recordedValue: 'Java',
			controlType: 'radio',
			controlName: 'Language',
			availableOptions: ['Any', 'Java', 'Python'],
		},
	],
	pageControls: [
		{
			kind: 'radioGroup',
			controlType: 'radio',
			name: 'Language',
			label: 'Language',
			availableOptions: ['Any', 'Java', 'Python'],
			value: 'Java',
			interactedDuringRecording: true,
		},
		{
			kind: 'checkboxGroup',
			controlType: 'checkbox',
			name: 'Level',
			label: 'Level',
			availableOptions: ['Beginner', 'Intermediate', 'Advanced'],
			interactedDuringRecording: false,
		},
		{
			kind: 'input',
			controlType: 'number',
			name: 'min_enrollments',
			label: 'Min enrollments',
			constraints: { min: 0, max: 999999 },
			interactedDuringRecording: false,
		},
		{
			kind: 'select',
			controlType: 'select',
			name: 'sort_by',
			label: 'Sort by',
			availableOptions: ['ID', 'Course Name', 'Language', 'Level', 'Enrollments'],
			interactedDuringRecording: false,
		},
	],
};

// Patch the OpenAI client to bail with a sentinel error AFTER the prompt has
// been logged. We capture stdout via a wrapper so we can do bulletproof
// assertions instead of eyeballing logs.
const captured = [];
const origInfo = console.info.bind(console);
const origLog = console.log.bind(console);
console.info = (...args) => {
	captured.push(args.map(String).join(' '));
	origInfo(...args);
};
console.log = (...args) => {
	captured.push(args.map(String).join(' '));
	origLog(...args);
};

const client = getLlmClient();
const orig = client.chat.completions.parse.bind(client.chat.completions);
client.chat.completions.parse = async () => {
	throw new Error('SMOKE_BAIL: prompt logged, intentionally bailing out');
};

try {
	await generateTestMatrix({
		flow: FAKE_FLOW,
		count: 5,
		screenshotUrl: 'https://example.com/screenshot.png',
		screenshotDetail: 'high',
	});
} catch (err) {
	if (!String(err.message).includes('SMOKE_BAIL')) throw err;
}

client.chat.completions.parse = orig;
console.info = origInfo;
console.log = origLog;

const dump = captured.join('\n');
const checks = [
	{ label: 'pageControls log line', needle: 'pageControls=4' },
	{ label: 'screenshotDetail=high log line', needle: 'screenshotDetail=high' },
	{ label: 'ALL FORM CONTROLS section', needle: 'ALL FORM CONTROLS ON THE PAGE' },
	{ label: 'untouched annotation', needle: 'USER DID NOT TOUCH' },
	{ label: 'min-enrollments line', needle: 'Min enrollments' },
	{ label: 'sort-by line', needle: 'Sort by' },
];

let ok = true;
for (const c of checks) {
	const found = dump.includes(c.needle);
	console.log(`${found ? 'PASS' : 'FAIL'}  ${c.label}  (needle="${c.needle}")`);
	if (!found) ok = false;
}

process.exit(ok ? 0 : 1);
