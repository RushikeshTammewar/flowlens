/**
 * Centralized model selection for every LLM call in v3.
 *
 * Imported by:
 *   - apps/web (API routes, lib/openai.ts)
 *   - packages/flow-doc (compile pipeline)
 *   - packages/replay-engine (judge, investigator, drift)
 *   - apps/replay-worker (Python mirror in src/flowlens_worker/models.py)
 *
 * Design rules:
 *   - Every LLM call site goes through this map. No model strings inline.
 *   - Each entry is overridable per-environment via FLOWLENS_MODEL_* env vars.
 *   - Defaults map to OpenAI's April 2026 lineup. ChatBrowserUse remains a
 *     fallback for the replay agent only (see LLD §5.5).
 */
export const MODELS = {
	/** Per-step intent narration during compile (vision). */
	narrate: process.env.FLOWLENS_MODEL_NARRATE ?? 'gpt-4.1-mini',
	/** Whole-flow synthesis after narration (text only, multi-step reasoning). */
	synthesize: process.env.FLOWLENS_MODEL_SYNTHESIZE ?? 'gpt-4.1',
	/** browser-use Agent loop on critical or drifted steps. */
	replayAgent: process.env.FLOWLENS_MODEL_REPLAY_AGENT ?? 'gpt-4.1-mini',
	/** T3 yes/no judge after every critical replay step. */
	judge: process.env.FLOWLENS_MODEL_JUDGE ?? 'gpt-4.1-mini',
	/** Failure investigator: classifies failures (app_bug | flaky | env | auth). */
	investigator: process.env.FLOWLENS_MODEL_INVESTIGATOR ?? 'o4-mini',
	/** One-shot site model, cached per-site for 7 days. */
	siteModel: process.env.FLOWLENS_MODEL_SITE_MODEL ?? 'gpt-4.1',
	/** Per-step test data generator (unique emails, realistic names). */
	dataGen: process.env.FLOWLENS_MODEL_DATA_GEN ?? 'gpt-4.1-mini',
	/** Sibling/negative-path flow generator (post-recording opt-in). */
	siblingGen: process.env.FLOWLENS_MODEL_SIBLING_GEN ?? 'gpt-4.1-mini',
	/** Cross-run drift analyzer (compares two runs). */
	driftAnalyzer: process.env.FLOWLENS_MODEL_DRIFT ?? 'gpt-4.1',
	/** Sensitive-data classifier fallback when the regex heuristic is uncertain. */
	sensitiveClassifier: process.env.FLOWLENS_MODEL_SENSITIVE ?? 'gpt-4.1-mini',
	/**
	 * Test-matrix generator (Phase 3.5b — Pro tier).
	 * Reasoning model is intentional: one-time-per-flow cost amortized across every
	 * future batch run, so the marginal cost vs gpt-4.1-mini is rounding error.
	 * Use o4-mini as the rate-limit fallback.
	 */
	matrixGenerator: process.env.FLOWLENS_MODEL_MATRIX_GENERATOR ?? 'o3',
	matrixGeneratorFallback: process.env.FLOWLENS_MODEL_MATRIX_FALLBACK ?? 'o4-mini',
	/** AI cluster analysis after a matrix batch completes. */
	matrixCluster: process.env.FLOWLENS_MODEL_MATRIX_CLUSTER ?? 'o4-mini',
} as const;

export type ModelKey = keyof typeof MODELS;
export type ModelName = (typeof MODELS)[ModelKey];
