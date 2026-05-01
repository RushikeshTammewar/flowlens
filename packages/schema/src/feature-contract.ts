/**
 * Phase 4 / Tier 1 — Feature Contract Zod schemas.
 *
 * The Feature Contract is the structured, testable thing the senior-QA
 * pipeline emits from a recording. It supersedes the free-text
 * `flows.description` for the new code path: it lists the inputs to the
 * feature, the expected behaviors (each a given/when/then claim), and
 * any cross-cutting invariants. Matrix-gen consumes it to produce a
 * 4-mode test plan; the side panel renders it as a preview card; the
 * report uses `expectedBehaviors` as the rows of the per-behavior verdict
 * grid.
 *
 * Existing free-text description is NOT removed — legacy flows keep
 * NULL `featureContract` and the UI falls back to `description`.
 *
 * Feature flag: FLOWLENS_PHASE4_ENABLED
 * Logged under scope: [phase4:contract]
 * Migration item (LLD §19): row 2 — `flows.feature_contract` jsonb column.
 */

import { z } from 'zod';

import { ControlConstraintsSchema, ControlTypeSchema } from './flow';

/**
 * One input to the feature — derived from the recording's touched controls
 * union the page-control inventory captured at recording stop.
 *
 *  - `domain` is `'text' | 'number'` for free-form fields, or an explicit
 *    string array for radios/selects (so matrix-gen knows the closed set
 *    without re-reading the page).
 *  - `constraints` mirrors `ControlConstraints` from `flow.ts` (min/max
 *    length, regex, numeric bounds) so the assertion engine can pick a
 *    bound-check that the form actually enforces.
 *  - `defaultValue` is informational; null when there is no recorded
 *    starting value.
 */
export const ContractInputSchema = z.object({
	name: z.string(),
	controlType: ControlTypeSchema,
	domain: z.union([z.literal('text'), z.literal('number'), z.array(z.string())]),
	constraints: ControlConstraintsSchema.optional(),
	defaultValue: z.string().nullable().optional(),
});
export type ContractInput = z.infer<typeof ContractInputSchema>;

/**
 * One expected behavior — a testable claim with given/when/then phrasing
 * plus an `observableOutcome` (what the assertion engine should verify
 * after the variant runs).
 *
 *  - `id` is a stable hash keyed off the behavior text — used as the soft
 *    FK from `test_variants.behavior_id` and as the primary key for the
 *    per-behavior verdict rollup.
 *  - `importance: 'critical'` flips a behavior from "robustness" to
 *    "correctness" axis in the two-axis verdict.
 */
export const BehaviorSchema = z.object({
	id: z.string(),
	given: z.string(),
	when: z.string(),
	then: z.string(),
	observableOutcome: z.string(),
	importance: z.enum(['critical', 'normal']).default('normal'),
});
export type Behavior = z.infer<typeof BehaviorSchema>;

/**
 * The full FeatureContract — the unit of compile output that drives every
 * downstream Phase 4 LLM stage. Stored as `flows.feature_contract` jsonb;
 * legacy flows have NULL.
 *
 *  - `synthesizedAt`/`synthesizedByModel` are debug breadcrumbs so we can
 *    trace which compile run/which model produced this contract.
 */
export const FeatureContractSchema = z.object({
	featureName: z.string(),
	inputs: z.array(ContractInputSchema).default([]),
	expectedBehaviors: z.array(BehaviorSchema).default([]),
	invariants: z.array(z.string()).default([]),
	synthesizedAt: z.string().datetime().optional(),
	synthesizedByModel: z.string().optional(),
});
export type FeatureContract = z.infer<typeof FeatureContractSchema>;
