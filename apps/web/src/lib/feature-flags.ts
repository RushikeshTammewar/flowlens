/**
 * Phase 4 / Tier 1 — feature-flag central registry.
 *
 * Thin wrapper around `process.env` so every Phase 4 codepath has a
 * single import surface for "should I run the new pipeline?".
 *
 * Feature flag: FLOWLENS_PHASE4_ENABLED
 * Logged under scope: [phase4:flag]
 * Migration item (LLD §19): cross-cuts rows 3, 5, 6, 8 (each row's
 *   "Flag-gate" column maps to one of the flags below).
 */

/**
 * Phase 4 — AI senior-QA pipeline. When false, compile/replay/UI fall
 * back to the Phase 3 flow (variant families instead of mode-aware
 * variants, step-driven judge instead of assertion engine, no
 * FeatureContract). This is the master kill-switch for the rollout.
 *
 * Set `FLOWLENS_PHASE4_ENABLED=true` in the deployment env to opt in.
 */
export const FEATURE_FLAGS = {
	contractAndModeAwareVariants: process.env.FLOWLENS_PHASE4_ENABLED === 'true',
} as const;

/**
 * Convenience predicate. Importers should prefer this over reading
 * `FEATURE_FLAGS.contractAndModeAwareVariants` directly so any future
 * gradual-rollout logic (org allowlist, % bucket, …) lives behind one
 * function.
 */
export function isPhase4Enabled(): boolean {
	return FEATURE_FLAGS.contractAndModeAwareVariants;
}

/**
 * Standardised log scope for Phase 4 callsites. Use as:
 *   console.info(`${PHASE4_LOG_SCOPE}:contract synthesized for flow=%s`, id);
 * so a single `grep '[phase4:'` surfaces every breadcrumb across the
 * monorepo.
 */
export const PHASE4_LOG_SCOPE = '[phase4';
