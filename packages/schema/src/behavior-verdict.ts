/**
 * Phase 4 / Tier 1 — two-axis verdict Zod schemas.
 *
 * The Phase 4 verdict is two-axis:
 *   correctness — does the feature do what it claims for IN-DOMAIN inputs?
 *   robustness  — does it stay safe for OUT-OF-DOMAIN / hostile inputs?
 *
 * Both axes are computed by aggregating per-mode outcomes for each
 * expected behavior in the FeatureContract. A behavior is "verified"
 * when every variant covering it (across all 4 modes + invariant) passes
 * its assertion; "failed" when any critical variant fails; "partial"
 * when only a subset failed; "inconclusive" when there's not enough
 * evidence (e.g. all variants errored).
 *
 * Stored on `run_batches.behavior_verdicts` (jsonb array) plus four
 * scalar counters for the headline pill in MatrixReport.tsx.
 *
 * Feature flag: FLOWLENS_PHASE4_ENABLED
 * Logged under scope: [phase4:verdict]
 * Migration item (LLD §19): row 9 — `run_batches` two-axis verdict
 *   columns + aggregator (Tier 4 wires the aggregator).
 */

import { z } from 'zod';

/**
 * Per-mode rollup for a single behavior. `variantsTotal` includes
 * disabled variants too, so a 0/0 row means "no variants generated for
 * this mode" (rendered as "—" in the report) rather than "all passed".
 */
export const ModeOutcomeSchema = z.object({
	mode: z.enum(['verify', 'edge', 'stress', 'adversarial', 'invariant']),
	variantsTotal: z.number().int().nonnegative(),
	variantsPassed: z.number().int().nonnegative(),
	variantsFailed: z.number().int().nonnegative(),
});
export type ModeOutcome = z.infer<typeof ModeOutcomeSchema>;

/**
 * Verdict for one expected behavior across all modes that targeted it.
 *
 *  - `behaviorTitle` is a copy of the human-readable claim
 *    (`given/when/then` joined) so the report is renderable from this
 *    row alone, without re-fetching the FeatureContract.
 *  - `failingVariantIds` lets the lightbox link directly to each
 *    failing variant's run.
 *  - `failureSummary` is a 1-line debug hint produced by the
 *    investigator (Tier 4); leave undefined on partial/inconclusive
 *    until the LLM has spoken.
 */
export const BehaviorVerdictSchema = z.object({
	behaviorId: z.string(),
	behaviorTitle: z.string(),
	status: z.enum(['verified', 'failed', 'partial', 'inconclusive']),
	modes: z.array(ModeOutcomeSchema),
	failingVariantIds: z.array(z.string()).default([]),
	failureSummary: z.string().optional(),
});
export type BehaviorVerdict = z.infer<typeof BehaviorVerdictSchema>;

/**
 * What the side panel + web report render. Aggregator builds this from
 * the four scalar counters + behavior verdict array stored on the
 * `run_batches` row.
 */
export const TwoAxisReportSchema = z.object({
	correctness: z.object({
		verified: z.number().int().nonnegative(),
		total: z.number().int().nonnegative(),
	}),
	robustness: z.object({
		verified: z.number().int().nonnegative(),
		total: z.number().int().nonnegative(),
	}),
	behaviorVerdicts: z.array(BehaviorVerdictSchema),
	clusterSummary: z.string().nullable(),
});
export type TwoAxisReport = z.infer<typeof TwoAxisReportSchema>;
