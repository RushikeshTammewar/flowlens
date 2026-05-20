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

import { ControlTypeSchema } from './flow';

/**
 * Constraints schema used inside the FeatureContract.
 *
 * NOTE: This is a separate schema from `ControlConstraintsSchema` in
 * `flow.ts` even though the field set is identical. Reason: the contract
 * is the input shape OpenAI's structured-outputs API consumes
 * (`response_format`), and that API requires every field in `properties`
 * to also be in `required` — i.e. `.optional()` is rejected, and only
 * `.nullable()` is allowed for "no value". The `flow.ts` variant uses
 * `.optional()` and is consumed by NORMAL parsing (stored DB jsonb,
 * recorder payloads) where optional/missing is the natural shape. We
 * keep both schemas and convert at the boundary.
 *
 * The two are kept structurally compatible — a value matching either
 * one matches the other after a trivial null-pruning pass. Helper:
 * `pruneNullsToOptional()` below.
 */
export const StrictControlConstraintsSchema = z.object({
	minLength: z.number().int().nonnegative().nullable(),
	maxLength: z.number().int().nonnegative().nullable(),
	min: z.number().nullable(),
	max: z.number().nullable(),
	pattern: z.string().nullable(),
});
export type StrictControlConstraints = z.infer<typeof StrictControlConstraintsSchema>;

/**
 * One input to the feature — derived from the recording's touched controls
 * union the page-control inventory captured at recording stop.
 *
 *  - `domain` is `'text' | 'number'` for free-form fields, or an explicit
 *    string array for radios/selects (so matrix-gen knows the closed set
 *    without re-reading the page).
 *  - `constraints` is the strict-nullable variant above; null when the
 *    field has no validation constraints. Individual sub-fields are also
 *    nullable so OpenAI strict-mode accepts the schema.
 *  - `defaultValue` is informational; null when there is no recorded
 *    starting value.
 */
export const ContractInputSchema = z.object({
	name: z.string(),
	controlType: ControlTypeSchema,
	domain: z.union([z.literal('text'), z.literal('number'), z.array(z.string())]),
	constraints: StrictControlConstraintsSchema.nullable(),
	defaultValue: z.string().nullable(),
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
	// Required (not optional with default) — OpenAI strict-mode rejects
	// `default()` on enum properties because they're surfaced via
	// `.optional()` under the hood. The synthesize prompt always asks
	// the model to fill this; if it returns null we treat as 'normal'
	// at the consumer (UI/aggregator).
	importance: z.enum(['critical', 'normal']),
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
	inputs: z.array(ContractInputSchema),
	expectedBehaviors: z.array(BehaviorSchema),
	invariants: z.array(z.string()),
	// Nullable (not optional) so the same schema parses both LLM
	// responses (where these are emitted as null) and stored jsonb
	// (where compile-inline.ts stamps them post-parse).
	synthesizedAt: z.string().datetime().nullable(),
	synthesizedByModel: z.string().nullable(),
});
export type FeatureContract = z.infer<typeof FeatureContractSchema>;
