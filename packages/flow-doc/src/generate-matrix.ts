/**
 * Test Matrix generator (Phase 3.5b — Pro-tier).
 *
 * Given a compiled flow, ask `o3` (with `o4-mini` fallback) to generate N
 * adversarial test variants. Each variant is a small JSON document that
 * declares:
 *   - which family it belongs to (boundary / format / encoding / locale / …)
 *   - a short `name` and `description`
 *   - per-step `fieldOverrides` that the replay engine will apply
 *   - an `expectedOutcome` discriminator that the T3 judge uses to decide
 *     pass/fail (success / validation_error / rejection / silent_acceptance_unsafe)
 *
 * Cost: ~$0.05–0.08 per call at o3 with `reasoning_effort=medium`. Amortized
 * once-per-flow cost; every future batch run reuses the same variants.
 *
 * The replay engine reads `variant.fieldOverrides` and substitutes the value
 * at each step's input field before driving the agent. The T3 judge reads
 * `variant.expectedOutcome` to know what to assert against.
 */
import { z } from 'zod';
import { zodResponseFormat } from 'openai/helpers/zod';
import type OpenAI from 'openai';
import {
	type PageControlSummary,
	type FeatureContract,
	AssertionSpecSchema,
} from '@flowlens/schema';
import { MODELS, getLlmClient, getProvider } from '@flowlens/llm-config';
import { imageContent, textContent } from './structured';

export const VariantFamilySchema = z.enum([
	'happy_path',
	'boundary',
	'format',
	'encoding',
	'adversarial',
	'locale',
	'state',
	'auth',
]);
export type VariantFamily = z.infer<typeof VariantFamilySchema>;

export const VariantExpectedOutcomeSchema = z.discriminatedUnion('kind', [
	z.object({
		kind: z.literal('success'),
		criteria: z.string().max(280),
	}),
	z.object({
		kind: z.literal('validation_error'),
		messageContains: z.array(z.string().max(120)).min(1).max(5),
	}),
	z.object({
		kind: z.literal('rejection'),
		criteria: z.string().max(280),
	}),
	z.object({
		kind: z.literal('silent_acceptance_unsafe'),
		criteria: z.string().max(280),
	}),
]);
export type VariantExpectedOutcome = z.infer<typeof VariantExpectedOutcomeSchema>;

// OpenAI structured-outputs ("strict") doesn't support open-ended object dicts
// — every property in `properties` must also be in `required`. We model
// `fieldOverrides` as an array of `{stepIndex, value}` pairs on the wire,
// then map back to a `{[stepIndex]: value}` map after parsing so downstream
// code (DB schema + replay engine) keeps using the simpler shape.
const FieldOverridePairSchema = z.object({
	stepIndex: z.number().int().nonnegative(),
	value: z.string(),
});

const TestVariantWireSchema = z.object({
	family: VariantFamilySchema,
	name: z.string().min(1).max(120),
	description: z.string().min(1).max(400),
	rationale: z.string().min(1).max(400),
	expectedOutcome: VariantExpectedOutcomeSchema,
	fieldOverrides: z.array(FieldOverridePairSchema),
	fragility: z.enum(['low', 'medium', 'high']),
});

export const TestVariantSchema = TestVariantWireSchema.transform((v) => {
	const map: Record<string, string> = {};
	for (const o of v.fieldOverrides) map[String(o.stepIndex)] = o.value;
	return { ...v, fieldOverrides: map };
});
export type TestVariant = z.infer<typeof TestVariantSchema>;

export const GenerateMatrixResultSchema = z.object({
	variants: z.array(TestVariantWireSchema).min(1).max(50),
});
export type GenerateMatrixResult = z.infer<typeof GenerateMatrixResultSchema>;

export interface GenerateMatrixInput {
	flow: {
		id: string;
		name: string;
		description: string | null;
		preconditions: string[];
		steps: Array<{
			index: number;
			action: string;
			intent: string;
			expectedOutcome: string;
			isCritical: boolean;
			recordedValue?: string | null;
			isSensitive?: boolean;
			// Control-context plumbed through from the compile pipeline.
			// When `controlType` is known, matrix-gen MUST respect it
			// (e.g. radios/selects can only take values from
			// `availableOptions`; text fields with maxLength must produce
			// boundary variants at the exact bound).
			controlType?:
				| 'radio'
				| 'checkbox'
				| 'select'
				| 'text'
				| 'number'
				| 'email'
				| 'password'
				| 'textarea'
				| 'unknown';
			availableOptions?: string[] | null;
			constraints?: {
				minLength?: number;
				maxLength?: number;
				min?: number;
				max?: number;
				pattern?: string;
			} | null;
			controlName?: string | null;
		}>;
		/**
		 * Page-wide control inventory captured at recording stop. Includes
		 * EVERY visible form control on the page — both the ones the user
		 * touched and the ones they didn't. Powers the COMBINATORIAL
		 * variant family below (e.g. user filtered by language; combine
		 * with min-enrollments=10000 (untouched) to test
		 * filter+threshold). Optional — older flows recorded before this
		 * field landed simply skip the section.
		 */
		pageControls?: PageControlSummary[];
	};
	count: number; // 5 / 10 / 20
	/**
	 * Optional URL to a representative screenshot from the flow. When
	 * supplied, the user prompt is sent as a multi-part [text, image]
	 * payload so vision-capable Foundry deployments (e.g. gpt-5.4) can
	 * see the actual UI before generating variants. No-op when null.
	 */
	screenshotUrl?: string | null;
	/**
	 * Vision detail level for the page screenshot. `low` (default) keeps
	 * the cost ~$0 but sends a small thumbnail; `high` sends the full
	 * resolution image (~$0.01 extra per call) which is what the LLM needs
	 * to actually read button labels, option text, and validation copy.
	 * The test-matrix route opts into `high` so the model can ground
	 * combinatorial variants in actual visible labels.
	 */
	screenshotDetail?: 'low' | 'high' | 'auto';
}

const SYSTEM_PROMPT = `You are a senior QA engineer with 10 years of experience finding edge cases in web applications. Given a recorded user flow, generate adversarial test variants that exercise different failure modes.

For each variant:
1. Pick a family that captures the failure mode: happy_path | boundary | format | encoding | adversarial | locale | state | auth
2. Identify the input field(s) where the override applies — use the recorded step index as the key in fieldOverrides
3. Specify expectedOutcome — what should happen if the app handles this correctly:
   - success: the flow should complete normally
   - validation_error: the app should show a specific error message; list 1-5 strings the message should contain
   - rejection: the app should refuse the action without a specific message
   - silent_acceptance_unsafe: the app silently accepts a value it shouldn't (security/data-integrity bug)

Variant families to use:
- boundary: empty string, single char, max-length, min-length, zero, negative, very large numbers
- format: malformed email/URL/phone, wrong date format, mixed case, leading/trailing whitespace
- encoding: unicode (emoji, RTL, zero-width), HTML/JS injection, SQL-ish, control chars, mojibake
- adversarial: prompt injection, length bombs, recursive/self-referential, known security payloads
- locale: non-Latin scripts (CJK, Arabic, Devanagari), locale-specific number/date formats
- state: stale data, conflicting state (e.g. clicking after timeout), retry/double-click
- auth: missing auth, expired auth, wrong scope
- happy_path: ALWAYS include exactly 1 happy_path variant per batch (sanity baseline)

CONTROL-AWARE VARIANT RULES (CRITICAL — read carefully):

If a step lists \`availableOptions\` (radios, checkboxes, <select>):
  - The ONLY valid override values are entries from \`availableOptions\` verbatim.
  - DO NOT generate whitespace, encoding, unicode, format, or length variants on these fields. The browser literally cannot put a unicode-confusable into a 3-option radio — the test will succeed-by-accident or fail in a way unrelated to your hypothesis.
  - Useful variants for fixed-choice fields: state (toggle a different option than recorded), order (interact in unexpected sequence), locale-of-surrounding-context (locale variants on neighboring TEXT fields, not the radio itself).
  - If you can't think of a meaningful state/order variant, DO NOT generate one — pick a different field.

If a step has \`constraints\` (\`maxLength\`, \`minLength\`, \`min\`, \`max\`, \`pattern\`):
  - boundary variants MUST use the exact bounds: e.g. for \`maxLength: 6\`, generate "exactly 6 chars" and "7 chars (over)" — not 100 chars.
  - For numeric \`min\`/\`max\`, generate values at, just under, and just over the bounds.
  - format variants must respect the regex \`pattern\` if given (or break it as a designed format-violation case).

If a step's \`controlType\` is \`password\`:
  - Treat as sensitive — generate length/format variants but never log/display the actual value.

If a step's \`controlType\` is \`unknown\` (or no metadata): apply the existing variant families freely; you have no UI-shape constraint.

PAGE SCREENSHOT:
You will receive ONE page screenshot showing the application surface the user
recorded against. USE IT to understand:
  - What other controls exist on the page beyond the steps the user touched.
    These are valid surface for variants combining the recorded interaction
    with an untouched control.
  - Whether the recorded controls are fixed-choice (radio/select) or free-text.
  - Visual constraints (button labels, validation messages, layout).
Generate variants that exercise the page as a senior QA engineer would —
including combinations of touched + untouched controls when meaningful.

Cross-check field labels against intent text (e.g. if intent says "min
enrollments" but screenshot shows "max enrollments", trust the screenshot).
Skip variants targeting fields that aren't visibly in the form.

COMBINATORIAL VARIANTS:
The user only interacted with SOME controls. Other untouched controls on the
page (surfaced under "ALL FORM CONTROLS ON THE PAGE" in the user message,
flagged "USER DID NOT TOUCH") are valid variant targets. Generate at least 1
variant that combines the recorded interaction with a value set on a
previously-untouched control when it makes semantic sense (e.g. user
filtered by language; combine with "min enrollments=10000" to test
filter+threshold interaction). Use the variant's \`fieldOverrides\` to express
the touched-step override; describe the untouched-control value in the
variant's \`description\` and \`rationale\` so the replay engine and the
human reviewer both know to set it. Untouched-control overrides go into
\`fieldOverrides\` keyed by the untouched control's recorded step index ONLY
if such a step exists; when there is no recorded step targeting that
control, embed the value in \`description\` instead and rely on the replay
agent to find the control on the page.

Quality bar:
- Every variant must be PLAUSIBLE for this specific app — read the flow's name, description, and step intents to understand what it does
- DO NOT generate variants that test things the recorded flow doesn't exercise (e.g. don't test login fields if the flow is a search)
- Vary fragility: low (very common, app should definitely handle), medium (less common but real), high (esoteric, may be acceptable to fail)
- One variant per (family, target-field) — no duplicates`;

/** Pretty-print control-context fields onto a single step line. */
function formatControlContext(s: GenerateMatrixInput['flow']['steps'][number]): string {
	const parts: string[] = [];
	if (s.controlType) parts.push(`controlType=${s.controlType}`);
	if (s.controlName) parts.push(`name=${JSON.stringify(s.controlName)}`);
	if (s.availableOptions && s.availableOptions.length > 0) {
		parts.push(`availableOptions=${JSON.stringify(s.availableOptions)}`);
	}
	if (s.constraints) {
		const c = s.constraints;
		const flat: string[] = [];
		if (c.minLength !== undefined) flat.push(`minLength:${c.minLength}`);
		if (c.maxLength !== undefined) flat.push(`maxLength:${c.maxLength}`);
		if (c.min !== undefined) flat.push(`min:${c.min}`);
		if (c.max !== undefined) flat.push(`max:${c.max}`);
		if (c.pattern !== undefined) flat.push(`pattern:${JSON.stringify(c.pattern)}`);
		if (flat.length > 0) parts.push(`constraints={${flat.join(',')}}`);
	}
	return parts.length > 0 ? ` ${parts.join(' ')}` : '';
}

/**
 * Pretty-print one page-wide control inventory entry as a single line, e.g.:
 *   - Language: radio, options=[Any, Java, Python] (user touched this)
 *   - Min enrollments: number input, min=0, max=999999 (USER DID NOT TOUCH — currently empty)
 */
function formatPageControl(c: PageControlSummary): string {
	const labelParts: string[] = [];
	if (c.label) labelParts.push(c.label);
	else if (c.name) labelParts.push(c.name);
	else if (c.id) labelParts.push(c.id);
	else labelParts.push('(unlabeled)');
	const label = labelParts.join(' ');

	const kindBlurb = (() => {
		switch (c.kind) {
			case 'radioGroup':
				return 'radio';
			case 'checkboxGroup':
				return 'checkbox group';
			case 'select':
				return 'select';
			case 'textarea':
				return 'textarea';
			case 'submit':
				return 'submit button';
			case 'button':
				return 'button';
			case 'input':
				return c.controlType === 'unknown' ? 'input' : `${c.controlType ?? 'text'} input`;
		}
	})();

	const meta: string[] = [];
	if (c.availableOptions && c.availableOptions.length > 0) {
		meta.push(`options=[${c.availableOptions.join(', ')}]`);
	}
	if (c.constraints) {
		const cc = c.constraints;
		if (cc.min !== undefined) meta.push(`min=${cc.min}`);
		if (cc.max !== undefined) meta.push(`max=${cc.max}`);
		if (cc.minLength !== undefined) meta.push(`minLength=${cc.minLength}`);
		if (cc.maxLength !== undefined) meta.push(`maxLength=${cc.maxLength}`);
		if (cc.pattern !== undefined) meta.push(`pattern=${JSON.stringify(cc.pattern)}`);
	}

	const interactionTag = c.interactedDuringRecording
		? '(user touched this)'
		: c.value
			? `(USER DID NOT TOUCH — currently set to ${JSON.stringify(c.value)})`
			: '(USER DID NOT TOUCH — currently empty)';

	const metaStr = meta.length > 0 ? `, ${meta.join(', ')}` : '';
	return ` - ${label}: ${kindBlurb}${metaStr} ${interactionTag}`;
}

const USER_PROMPT_TEMPLATE = (input: GenerateMatrixInput) => {
	const inputSteps = input.flow.steps
		.filter((s) => s.action === 'input' || s.action === 'select' || s.controlType !== undefined)
		.map(
			(s) =>
				`  step[${s.index}] action=${s.action} intent=${JSON.stringify(s.intent)} recordedValue=${
					s.recordedValue ? JSON.stringify(s.recordedValue) : 'null'
				}${formatControlContext(s)}${
					s.isSensitive ? ' (sensitive — DO NOT GENERATE OVERRIDES; PII/secrets only)' : ''
				}`,
		)
		.join('\n');

	const pageControlsSection =
		input.flow.pageControls && input.flow.pageControls.length > 0
			? `

ALL FORM CONTROLS ON THE PAGE (whether the user interacted with them or not):
${input.flow.pageControls.map(formatPageControl).join('\n')}

Untouched controls in this list are FAIR GAME for combinatorial variants
(see COMBINATORIAL VARIANTS in the system prompt).`
			: '';

	return `Flow: ${input.flow.name}
${input.flow.description ? `Description: ${input.flow.description}` : ''}
${input.flow.preconditions.length ? `Preconditions: ${input.flow.preconditions.join('; ')}` : ''}

Steps the user performed (showing only steps with overridable input fields, with UI-shape metadata):
${inputSteps || '  (no input fields — generate state / locale / encoding-via-URL variants instead)'}

Full step list for context:
${input.flow.steps.map((s) => `  step[${s.index}] action=${s.action} intent=${s.intent} expectedOutcome=${s.expectedOutcome}`).join('\n')}${pageControlsSection}

Generate exactly ${input.count} variants. The first variant MUST be \`family: happy_path\` as a baseline. The remaining ${input.count - 1} should be a mix of failure-mode families, no duplicates per (family, target-field). Honor the CONTROL-AWARE VARIANT RULES from the system prompt — fixed-choice fields (any step with availableOptions) must NEVER receive whitespace/unicode/encoding overrides.`;
};

export async function generateTestMatrix(
	input: GenerateMatrixInput,
): Promise<{
	variants: TestVariant[];
	model: string;
	usage: { promptTokens: number; completionTokens: number; totalTokens: number };
}> {
	// Provider routing happens inside getLlmClient(): when LLM_PROVIDER=
	// azure_foundry it returns an AzureOpenAI client and `model` is treated
	// as a Foundry deployment name.
	const client = getLlmClient();
	const provider = getProvider();

	const userPromptText = USER_PROMPT_TEMPLATE(input);

	// Build vision-or-text user content. gpt-5.4 on Azure Foundry IS
	// vision-capable per the Apr 2026 deployment table, so we attach a
	// representative screenshot when one is supplied. o-series reasoning
	// models also accept image_url parts. We fall back gracefully to
	// text-only when no screenshot URL is available.
	const userContent: OpenAI.Chat.Completions.ChatCompletionUserMessageParam['content'] =
		input.screenshotUrl
			? [
					textContent(userPromptText),
					imageContent({
						url: input.screenshotUrl,
						detail: input.screenshotDetail ?? 'low',
					}),
				]
			: userPromptText;

	// Dev-only: log the prompt shape on the first call per process so the
	// smoke test in the PR can verify vision is wired (look for
	// "[matrix-generator] sending vision prompt" in Vercel logs).
	if (process.env.FLOWLENS_LOG_MATRIX_PROMPT === '1') {
		console.info(
			`[matrix-generator] sending ${input.screenshotUrl ? 'vision' : 'text-only'} prompt for flow=${input.flow.id} ` +
				`screenshotUrl=${input.screenshotUrl ?? 'null'} ` +
				`screenshotDetail=${input.screenshotDetail ?? 'low'} ` +
				`pageControls=${input.flow.pageControls?.length ?? 0}`,
		);
		console.info('[matrix-generator] user prompt:\n' + userPromptText);
	}

	// Try the primary first; fall back on rate-limit / model-unavailable.
	const tryModel = async (model: string) => {
		// On OpenAI, only `o*` reasoning models accept reasoning_effort and
		// gpt-4.* ignore it. On Azure Foundry, GPT-5 deployments ALSO accept
		// reasoning_effort (it's the official knob in the April 2026 Azure
		// OpenAI preview API), so we turn it on for both o-series and gpt-5*
		// deployment names.
		const wantsReasoning =
			provider === 'azure'
				? /^(o\d|gpt-5)/i.test(model)
				: model.startsWith('o');
		const response = await client.chat.completions.parse({
			model,
			messages: [
				{ role: 'system', content: SYSTEM_PROMPT },
				{ role: 'user', content: userContent },
			],
			response_format: zodResponseFormat(GenerateMatrixResultSchema, 'TestMatrix'),
			// Default to `high` reasoning — user explicitly wants max
			// thinking depth for variant generation since the matrix
			// generator is the brain of the senior-QA pitch. Roughly
			// 100-130s per call against gpt-5.4 on Foundry. Override
			// via FLOWLENS_MATRIX_REASONING_EFFORT for cost-tight runs.
			...(wantsReasoning
				? {
						reasoning_effort:
							((process.env.FLOWLENS_MATRIX_REASONING_EFFORT as
								| 'low'
								| 'medium'
								| 'high'
								| undefined) ?? 'high') as 'low' | 'medium' | 'high',
					}
				: {}),
		});
		const choice = response.choices[0];
		if (!choice?.message.parsed) {
			throw new Error(
				`Matrix generator returned no parsed message (refusal=${choice?.message.refusal ?? 'none'})`,
			);
		}
		// Convert array-of-pairs `fieldOverrides` to the `{[stepIndex]: value}`
		// map used by the rest of the pipeline.
		const variants: TestVariant[] = choice.message.parsed.variants.map((v) => {
			const map: Record<string, string> = {};
			for (const o of v.fieldOverrides) map[String(o.stepIndex)] = o.value;
			return { ...v, fieldOverrides: map };
		});
		return {
			variants,
			model,
			usage: {
				promptTokens: response.usage?.prompt_tokens ?? 0,
				completionTokens: response.usage?.completion_tokens ?? 0,
				totalTokens: response.usage?.total_tokens ?? 0,
			},
		};
	};

	try {
		return await tryModel(MODELS.matrixGenerator);
	} catch (err) {
		const msg = (err as Error).message ?? '';
		if (
			msg.includes('rate_limit') ||
			msg.includes('model_not_found') ||
			msg.includes('model not found') ||
			msg.includes('does not exist')
		) {
			console.warn(
				`[matrix-generator] ${MODELS.matrixGenerator} unavailable, falling back to ${MODELS.matrixGeneratorFallback}: ${msg}`,
			);
			return await tryModel(MODELS.matrixGeneratorFallback);
		}
		throw err;
	}
}

// ───────────────────────────────────────────────────────────────────────
// Phase 4 / Tier 2 — Mode-aware, contract-grounded matrix generator.
//
// Distinct from V1 in three ways:
//   1. Takes a `featureContract` (synthesized by `synthesizeFlowWithContract`)
//      and partitions variants by behaviorId — every variant cites the
//      behavior it exercises, enabling per-behavior verdict aggregation.
//   2. Each variant carries an explicit `mode` ∈ verify | edge | stress |
//      adversarial | invariant. This is the test plan grouping the senior-
//      QA UX renders. Aggregator uses `mode` to compute the two-axis
//      Correctness x Robustness verdict (LLD §15.2).
//   3. Each variant carries a structured `assertion` (deterministic spec +
//      LLM fallback prompt) and `shouldPass` flag. The assertion engine
//      (Tier 3, sidecar/web) reads these — no more "T3 judge guesses
//      pass/fail from screenshot alone".
//
// V1 (`generateTestMatrix`) is unchanged — Phase-4-disabled callers keep
// the existing family-based variant shape. When the flag flips on, the
// test-matrix route calls `generateTestMatrixWithContract` instead.
// ───────────────────────────────────────────────────────────────────────

export const VariantModeSchema = z.enum([
	'verify',
	'edge',
	'stress',
	'adversarial',
	'invariant',
]);
export type VariantMode = z.infer<typeof VariantModeSchema>;

const TestVariantV2WireSchema = z.object({
	mode: VariantModeSchema,
	behaviorId: z.string().min(1).max(120),
	name: z.string().min(1).max(120),
	description: z.string().min(1).max(400),
	rationale: z.string().min(1).max(400),
	// Senior QA's hypothesis for what could go wrong here. Surfaces in
	// the report when the variant fails so the human can quickly grok
	// "ah, this is the SQL-injection-style payload they were testing".
	riskHypothesis: z.string().min(1).max(280),
	// Whether the assertion is expected to pass on a healthy app. For
	// adversarial-mode variants, `shouldPass: false` means "the app
	// should reject this input"; the assertion engine flips its sense
	// accordingly when scoring.
	shouldPass: z.boolean(),
	assertion: z.object({
		spec: AssertionSpecSchema,
		fallbackPrompt: z.string().min(1).max(280),
	}),
	fieldOverrides: z.array(FieldOverridePairSchema),
	// Kept from V1 — many existing UI surfaces still render `family`
	// for sorting and color-coding. The Phase-4 modes are richer but
	// orthogonal to the family taxonomy; we map mode → likely family
	// in the prompt and let the model fill it in.
	family: VariantFamilySchema,
	fragility: z.enum(['low', 'medium', 'high']),
});

export const TestVariantV2Schema = TestVariantV2WireSchema.transform((v) => {
	const map: Record<string, string> = {};
	for (const o of v.fieldOverrides) map[String(o.stepIndex)] = o.value;
	return { ...v, fieldOverrides: map };
});
export type TestVariantV2 = z.infer<typeof TestVariantV2Schema>;

export const GenerateMatrixV2ResultSchema = z.object({
	variants: z.array(TestVariantV2WireSchema).min(1).max(60),
});

export interface GenerateMatrixWithContractInput extends GenerateMatrixInput {
	/**
	 * Required for V2. The senior-QA contract synthesized by
	 * `synthesizeFlowWithContract`. Variants must cite a behaviorId
	 * from this contract; un-cited variants are dropped post-parse.
	 */
	featureContract: FeatureContract;
	/**
	 * Per-mode targets (variant counts). Defaults to a balanced spread.
	 * The route can override (e.g. cheap-tier orgs get fewer stress
	 * variants).
	 */
	modeTargets?: Partial<Record<VariantMode, number>>;
}

const SYSTEM_PROMPT_V2 = `You are a senior QA engineer designing a test plan for a feature.

Inputs you receive:
- The flow document (recorded interaction summary).
- A FEATURE CONTRACT: structured description of what the feature does (inputs, expected behaviors with Given/When/Then, invariants).
- A page screenshot.
- The full inventory of form controls on the page (touched + untouched).

Output strict JSON: an array of test variants. Each variant exercises ONE behavior from the contract under ONE testing mode. The plan you produce becomes the cells of a behavior x mode grid in the report (LLD §15.2 two-axis verdict).

TESTING MODES (REQUIRED — every variant has exactly one):
- verify: Reproduce the recorded interaction with realistic data; expected to PASS. Confirms the behavior works at all. 1 verify variant per behavior is usually enough.
- edge: Boundary or near-boundary inputs (empty, max-length, zero, last allowed option, off-by-one). Expected to PASS — the app should handle these correctly. 1-2 edge variants per behavior.
- stress: Volume / repetition / concurrency-shaped variants (many filters at once, very large numbers within bounds, rapid retries). Expected to PASS. 1 stress variant per behavior when meaningful.
- adversarial: Hostile input — injection payloads, unicode confusables, prompt-injection, format-violation, length bombs. Expected to be REJECTED (shouldPass: false). 1-2 adversarial variants per behavior, ONLY for inputs where rejection is meaningful (don't run adversarial against a fixed-choice radio).
- invariant: Variants that exercise the contract's INVARIANTS (page doesn't crash, no 5xx, submit disabled when required empty, etc.). Not tied to a specific behavior — use behaviorId="invariant-<short-name>" matching one of the contract's invariants.

CONTROL-AWARE RULES (CRITICAL):
- Fixed-choice fields (controlType=radio|select|checkboxGroup with availableOptions): ONLY emit values from availableOptions. NO whitespace/unicode/encoding overrides — the browser cannot store them. For these fields, edge=last-allowed-option, adversarial=NOT MEANINGFUL (skip).
- Numeric fields with min/max: edge variants MUST hit exact bounds (min, min-1, max, max+1).
- Text fields with maxLength: edge variants MUST hit exact bounds (length=maxLength, length=maxLength+1).
- Sensitive fields (controlType=password OR isSensitive=true): NO overrides at all — the recorded value stays.

ASSERTIONS (every variant gets one):
The assertion is what the replay engine will check after the variant runs. Pick the cheapest deterministic spec that captures the behavior's observableOutcome:

  url_matches: { pattern }                        // for navigations
  dom_text_present: { selector?, text }           // app rendered an expected string
  dom_text_absent: { selector?, text }            // a blocked input did NOT echo
  dom_count: { selector, op, value }              // table row count, matches expected
  row_content_match: { selector, columnIndex?, expectedValue }   // table row contents
  console_no_errors: {}                           // no console.error during the run
  no_network_5xx: {}                              // no 5xx responses observed
  page_load_no_crash: {}                          // page DOM is non-empty after action
  screenshot_judge: {}                            // last-resort LLM vision verdict

Always include a 1-sentence \`fallbackPrompt\` describing what a human would check — used only when the deterministic spec is inconclusive (assertion engine LLM fallback).

shouldPass:
- verify / edge / stress / invariant variants: true (app should handle this correctly)
- adversarial variants: false (app should REJECT this input — assertion's success means rejection happened)

QUALITY BAR:
- Cover EVERY behavior in expectedBehaviors with at least 1 verify variant. If you can't cover a behavior, skip the variant and let the report show "unverified".
- Cover EVERY invariant with 1 invariant variant.
- Don't generate variants that test things the contract doesn't claim. Don't invent behaviors.
- Don't over-generate adversarial variants on fixed-choice fields — produce 0 there, more on text fields.
- Each variant must reference a behaviorId from the contract (or "invariant-<name>" for invariant mode).

family: pick the closest V1 family for backwards-compat (happy_path | boundary | format | encoding | adversarial | locale | state | auth).

Don't include any preamble. Strict JSON only.`;

function formatFeatureContract(contract: FeatureContract): string {
	const inputLines = contract.inputs.map((i) => {
		const dom = Array.isArray(i.domain)
			? `[${i.domain.join(', ')}]`
			: i.domain;
		const cons: string[] = [];
		if (i.constraints) {
			const c = i.constraints;
			if (c.minLength !== undefined) cons.push(`minLength=${c.minLength}`);
			if (c.maxLength !== undefined) cons.push(`maxLength=${c.maxLength}`);
			if (c.min !== undefined) cons.push(`min=${c.min}`);
			if (c.max !== undefined) cons.push(`max=${c.max}`);
			if (c.pattern !== undefined) cons.push(`pattern=${JSON.stringify(c.pattern)}`);
		}
		const consStr = cons.length ? ` {${cons.join(',')}}` : '';
		const dflt = i.defaultValue ? ` default=${JSON.stringify(i.defaultValue)}` : '';
		return `  - ${i.name} (${i.controlType}) domain=${dom}${consStr}${dflt}`;
	});

	const behaviorLines = contract.expectedBehaviors.map(
		(b) =>
			`  - id=${b.id} importance=${b.importance}\n      Given ${b.given}\n      When ${b.when}\n      Then ${b.then}\n      Observable: ${b.observableOutcome}`,
	);

	const invariantLines = contract.invariants.map((i, idx) => `  ${idx + 1}. ${i}`);

	return [
		`FEATURE CONTRACT — ${contract.featureName}`,
		'',
		'Inputs:',
		inputLines.length ? inputLines.join('\n') : '  (none)',
		'',
		'Expected behaviors:',
		behaviorLines.length ? behaviorLines.join('\n') : '  (none)',
		'',
		'Invariants:',
		invariantLines.length ? invariantLines.join('\n') : '  (none)',
	].join('\n');
}

const USER_PROMPT_TEMPLATE_V2 = (input: GenerateMatrixWithContractInput) => {
	const inputSteps = input.flow.steps
		.filter(
			(s) =>
				s.action === 'input' || s.action === 'select' || s.controlType !== undefined,
		)
		.map(
			(s) =>
				`  step[${s.index}] action=${s.action} intent=${JSON.stringify(s.intent)} recordedValue=${
					s.recordedValue ? JSON.stringify(s.recordedValue) : 'null'
				}${formatControlContext(s)}${
					s.isSensitive ? ' (sensitive — DO NOT GENERATE OVERRIDES)' : ''
				}`,
		)
		.join('\n');

	const pageControlsSection =
		input.flow.pageControls && input.flow.pageControls.length > 0
			? `\n\nALL FORM CONTROLS ON THE PAGE:\n${input.flow.pageControls.map(formatPageControl).join('\n')}`
			: '';

	// Default mode targets — total ~12 variants. Keeps cost predictable
	// (~1 matrix-gen call ≈ $0.20 at high reasoning) while giving the
	// 4-mode UX visible coverage. Route can override.
	const targets = {
		verify: input.modeTargets?.verify ?? 3,
		edge: input.modeTargets?.edge ?? 3,
		stress: input.modeTargets?.stress ?? 2,
		adversarial: input.modeTargets?.adversarial ?? 2,
		invariant: input.modeTargets?.invariant ?? 2,
	};
	const targetTotal =
		targets.verify + targets.edge + targets.stress + targets.adversarial + targets.invariant;

	return `Flow: ${input.flow.name}
${input.flow.description ? `Description: ${input.flow.description}` : ''}

${formatFeatureContract(input.featureContract)}

Steps the user performed (overridable input fields with UI-shape metadata):
${inputSteps || '  (no input fields — focus on state/locale variants and invariants)'}

Full step list for context:
${input.flow.steps.map((s) => `  step[${s.index}] action=${s.action} intent=${s.intent}`).join('\n')}${pageControlsSection}

Generate a test plan with approximately ${targetTotal} variants distributed roughly as:
  verify: ${targets.verify}     (one per behavior; reproduces recorded path with realistic data)
  edge: ${targets.edge}        (boundary / near-boundary; expected to pass)
  stress: ${targets.stress}      (volume / repetition; expected to pass)
  adversarial: ${targets.adversarial} (hostile input; expected to be REJECTED — shouldPass=false)
  invariant: ${targets.invariant}    (cross-cutting properties from the contract's invariants)

Skip any mode for behaviors where it's not meaningful (e.g. don't generate adversarial for a fixed-choice radio). It's better to have 8 high-signal variants than 12 weak ones.`;
};

export async function generateTestMatrixWithContract(
	input: GenerateMatrixWithContractInput,
): Promise<{
	variants: TestVariantV2[];
	model: string;
	usage: { promptTokens: number; completionTokens: number; totalTokens: number };
}> {
	const client = getLlmClient();
	const provider = getProvider();
	const userPromptText = USER_PROMPT_TEMPLATE_V2(input);

	const userContent: OpenAI.Chat.Completions.ChatCompletionUserMessageParam['content'] =
		input.screenshotUrl
			? [
					textContent(userPromptText),
					imageContent({
						url: input.screenshotUrl,
						detail: input.screenshotDetail ?? 'high',
					}),
				]
			: userPromptText;

	if (process.env.FLOWLENS_LOG_MATRIX_PROMPT === '1') {
		console.info(
			`[phase4:matrix-gen] sending ${input.screenshotUrl ? 'vision' : 'text-only'} prompt for flow=${input.flow.id} ` +
				`featureName=${JSON.stringify(input.featureContract.featureName)} ` +
				`behaviors=${input.featureContract.expectedBehaviors.length} ` +
				`invariants=${input.featureContract.invariants.length}`,
		);
	}

	const tryModel = async (model: string) => {
		const wantsReasoning =
			provider === 'azure'
				? /^(o\d|gpt-5)/i.test(model)
				: model.startsWith('o');
		const response = await client.chat.completions.parse({
			model,
			messages: [
				{ role: 'system', content: SYSTEM_PROMPT_V2 },
				{ role: 'user', content: userContent },
			],
			response_format: zodResponseFormat(GenerateMatrixV2ResultSchema, 'TestMatrixV2'),
			...(wantsReasoning
				? {
						reasoning_effort:
							((process.env.FLOWLENS_MATRIX_REASONING_EFFORT as
								| 'low'
								| 'medium'
								| 'high'
								| undefined) ?? 'high') as 'low' | 'medium' | 'high',
					}
				: {}),
		});
		const choice = response.choices[0];
		if (!choice?.message.parsed) {
			throw new Error(
				`Phase-4 matrix generator returned no parsed message (refusal=${choice?.message.refusal ?? 'none'})`,
			);
		}

		// Drop variants citing unknown behaviorIds. Loud-warn so the
		// LLM hallucinations are visible in logs but the run still
		// produces a usable plan. Invariant-mode variants get a free
		// pass — they cite "invariant-<...>" tokens that we don't
		// strictly check against the contract list (the contract's
		// invariants are free-form strings, not IDs).
		const knownBehaviorIds = new Set(
			input.featureContract.expectedBehaviors.map((b) => b.id),
		);
		const dropped: string[] = [];
		const variants: TestVariantV2[] = choice.message.parsed.variants
			.filter((v) => {
				if (v.mode === 'invariant') return true;
				if (knownBehaviorIds.has(v.behaviorId)) return true;
				dropped.push(`${v.name} (cited unknown behaviorId=${v.behaviorId})`);
				return false;
			})
			.map((v) => {
				const map: Record<string, string> = {};
				for (const o of v.fieldOverrides) map[String(o.stepIndex)] = o.value;
				return { ...v, fieldOverrides: map };
			});

		if (dropped.length > 0) {
			console.warn(
				`[phase4:matrix-gen] dropped ${dropped.length} variant(s) with unknown behaviorIds: ${dropped.join('; ')}`,
			);
		}

		console.info(
			`[phase4:matrix-gen] flow=${input.flow.id} model=${model} ` +
				`generated=${variants.length} (verify=${variants.filter((v) => v.mode === 'verify').length} ` +
				`edge=${variants.filter((v) => v.mode === 'edge').length} ` +
				`stress=${variants.filter((v) => v.mode === 'stress').length} ` +
				`adversarial=${variants.filter((v) => v.mode === 'adversarial').length} ` +
				`invariant=${variants.filter((v) => v.mode === 'invariant').length}) ` +
				`tokens=${response.usage?.total_tokens ?? 0}`,
		);

		return {
			variants,
			model,
			usage: {
				promptTokens: response.usage?.prompt_tokens ?? 0,
				completionTokens: response.usage?.completion_tokens ?? 0,
				totalTokens: response.usage?.total_tokens ?? 0,
			},
		};
	};

	try {
		return await tryModel(MODELS.matrixGenerator);
	} catch (err) {
		const msg = (err as Error).message ?? '';
		if (
			msg.includes('rate_limit') ||
			msg.includes('model_not_found') ||
			msg.includes('model not found') ||
			msg.includes('does not exist')
		) {
			console.warn(
				`[phase4:matrix-gen] ${MODELS.matrixGenerator} unavailable, falling back to ${MODELS.matrixGeneratorFallback}: ${msg}`,
			);
			return await tryModel(MODELS.matrixGeneratorFallback);
		}
		throw err;
	}
}
