/**
 * Phase 4 / Tier 1 — Assertion engine Zod schemas.
 *
 * The assertion engine replaces the per-step LLM judge for Phase 4
 * variants. Each variant carries an `assertion` describing the
 * deterministic check the sidecar should run after the variant's last
 * step (URL match, DOM text presence, table row predicate, …) plus an
 * English `fallbackPrompt` the LLM judge consumes when no deterministic
 * handler can rule on the result.
 *
 * Design rule: prefer earlier (more deterministic) handlers over later
 * ones. The handlers are listed in `AssertionKindSchema` in priority
 * order.
 *
 * Feature flag: FLOWLENS_PHASE4_ENABLED
 * Logged under scope: [phase4:assertion]
 * Migration item (LLD §19): rows 4 (`test_variants.assertion`) and 6
 *   (assertion engine in apps/replay-worker — Tier 3).
 */

import { z } from 'zod';

/**
 * Kinds of deterministic assertions the assertion engine can verify
 * against raw CDP data captured by the sidecar. `screenshot_judge` is
 * the LLM-vision fallback used when no deterministic handler applies.
 */
export const AssertionKindSchema = z.enum([
	'url_matches',
	'dom_text_present',
	'dom_text_absent',
	'dom_count',
	'row_content_match',
	'console_no_errors',
	'no_network_5xx',
	'page_load_no_crash',
	'screenshot_judge',
]);
export type AssertionKind = z.infer<typeof AssertionKindSchema>;

/**
 * The per-kind payload the engine needs to evaluate an assertion. Kept
 * as a discriminated union on `kind` so the engine can switch by string.
 *
 *  - `url_matches`        — current URL matches a JS regex (`pattern`).
 *  - `dom_text_present`   — at least one visible element matches `text`,
 *    optionally narrowed by `within` selector.
 *  - `dom_text_absent`    — opposite of `dom_text_present`.
 *  - `dom_count`          — count of `selector` matches a comparator.
 *  - `row_content_match`  — every `rowSelector` row contains
 *    `expectedValue` inside `cellSelector`.
 *  - `console_no_errors`  — T1 invariant (no console.error during run).
 *  - `no_network_5xx`     — T1 invariant (no 5xx in captured network).
 *  - `page_load_no_crash` — T1 invariant (page didn't navigate to
 *    chrome-error://).
 *  - `screenshot_judge`   — pure LLM vision fallback; `fallbackPrompt`
 *    on the parent `AssertionSchema` carries the English claim.
 */
export const AssertionSpecSchema = z.union([
	z.object({ kind: z.literal('url_matches'), pattern: z.string() }),
	z.object({
		kind: z.literal('dom_text_present'),
		text: z.string(),
		within: z.string().optional(),
	}),
	z.object({
		kind: z.literal('dom_text_absent'),
		text: z.string(),
		within: z.string().optional(),
	}),
	z.object({
		kind: z.literal('dom_count'),
		selector: z.string(),
		op: z.enum(['eq', 'gte', 'lte']),
		n: z.number().int().nonnegative(),
	}),
	z.object({
		kind: z.literal('row_content_match'),
		rowSelector: z.string(),
		cellSelector: z.string(),
		expectedValue: z.string(),
	}),
	z.object({ kind: z.literal('console_no_errors') }),
	z.object({ kind: z.literal('no_network_5xx') }),
	z.object({ kind: z.literal('page_load_no_crash') }),
	z.object({ kind: z.literal('screenshot_judge') }),
]);
export type AssertionSpec = z.infer<typeof AssertionSpecSchema>;

/**
 * One assertion attached to a variant (or step). `fallbackPrompt` is
 * always populated so the LLM judge has a self-contained English claim
 * to evaluate when the deterministic handler is inconclusive.
 */
export const AssertionSchema = z.object({
	spec: AssertionSpecSchema,
	fallbackPrompt: z.string(),
});
export type Assertion = z.infer<typeof AssertionSchema>;

/**
 * What the assertion engine returned at evaluation time. Stored on
 * `step_results.assertion_eval` when an assertion targets a single step;
 * variant-level rollups live on the run/run_batch verdict tables.
 *
 *  - `evaluatedKind` may differ from the requested kind when the engine
 *    falls back to `screenshot_judge` — debugging aid.
 *  - `evidence` is free-form (matched URL, captured row text, console
 *    error sample, …) so reviewers can see WHY a verdict came out.
 */
export const AssertionEvalSchema = z.object({
	passed: z.boolean(),
	evaluatedKind: AssertionKindSchema,
	reason: z.string(),
	evidence: z.record(z.unknown()).optional(),
	evaluatedAt: z.string().datetime(),
	durationMs: z.number().int().nonnegative(),
	llmFallbackUsed: z.boolean().default(false),
});
export type AssertionEval = z.infer<typeof AssertionEvalSchema>;
