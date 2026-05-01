/**
 * Centralized model selection for every LLM call in v3.
 *
 * Imported by:
 *   - apps/web (API routes, lib/openai.ts)
 *   - packages/flow-doc (compile pipeline)
 *   - packages/replay-engine (judge, investigator, drift)
 *   - apps/replay-worker (Python mirror in app/llm_client.py)
 *
 * Design rules:
 *   - Every LLM call site goes through this map. No model strings inline.
 *   - Every entry has BOTH an `openai` mapping (direct OpenAI API) AND an
 *     `azure` mapping (Azure AI Foundry / Azure OpenAI deployment NAME).
 *     The active provider is selected by `LLM_PROVIDER` env (`openai` |
 *     `azure_foundry`).
 *   - Each entry is overridable per-environment via FLOWLENS_MODEL_* env vars.
 *     Overrides take precedence over the provider mapping (the override is
 *     applied verbatim — for Azure that means it must be a deployment name).
 *
 * The `azure` column defaults to GPT-5 family for hot reasoning paths and
 * GPT-5-mini for cheap vision/judge paths. The user must create matching
 * deployments in Foundry Studio before flipping `LLM_PROVIDER=azure_foundry`.
 * Recommended deployment names (chosen so the defaults below "just work"):
 *
 *   gpt-5        — variant generation, intent classification, investigator
 *   gpt-5-mini   — narration, judge, data gen, sibling gen, sensitive classifier
 *   gpt-5-nano   — fallback ultracheap (optional)
 *   o4-mini      — reasoning fallback (optional, kept for parity)
 *   gpt-4.1      — only if GPT-5 unavailable in your region/quota
 *   gpt-4.1-mini — only if GPT-5-mini unavailable
 */

// Bare specifiers — see cookies-vault/src/index.ts for the rationale
// (works for Next/Webpack/esbuild bundlers AND tsx-driven Node CLIs).
export type { LlmProvider } from './provider';
import { getProvider } from './provider';
export { getProvider } from './provider';

/**
 * Per-stage provider → model name mapping. Keep in sync with
 * apps/replay-worker/app/llm_client.py (Python mirror).
 *
 * IMPORTANT: when `LLM_PROVIDER=azure_foundry`, the `azure` value must match
 * a DEPLOYMENT NAME you created in Foundry Studio (it is NOT a base model id).
 * Deployment names are arbitrary — by convention we name them after the model
 * id so the table below is also a deployment-creation checklist.
 */
const MODEL_TABLE = {
	/** Per-step intent narration during compile (vision). */
	narrate: { openai: 'gpt-4.1-mini', azure: 'gpt-5.4-mini' },
	/**
	 * Whole-flow synthesis after narration (vision + control inventory +
	 * Phase 4 FeatureContract).
	 *
	 * Standardized to the mini variant per the HLD/LLD model table —
	 * synthesize is a single-shot prompt with structured output and
	 * doesn't need full GPT-5/4.1 reasoning. Phase 4 contract synthesis
	 * adds ~400 output tokens vs V1 — still cheap on the mini model.
	 * Override with FLOWLENS_MODEL_SYNTHESIZE=gpt-4.1 if a regression
	 * shows the mini model under-extracting behaviors.
	 */
	synthesize: { openai: 'gpt-4.1-mini', azure: 'gpt-5.4-mini' },
	/** browser-use Agent loop on critical or drifted steps. */
	replayAgent: { openai: 'gpt-4.1-mini', azure: 'gpt-5.4-mini' },
	/** T3 yes/no judge after every critical replay step. */
	judge: { openai: 'gpt-4.1-mini', azure: 'gpt-5.4-mini' },
	/** Failure investigator: classifies failures (app_bug | flaky | env | auth). */
	investigator: { openai: 'o4-mini', azure: 'o4-mini' },
	/** One-shot site model, cached per-site for 7 days. */
	siteModel: { openai: 'gpt-4.1', azure: 'gpt-5.4' },
	/** Per-step test data generator (unique emails, realistic names). */
	dataGen: { openai: 'gpt-4.1-mini', azure: 'gpt-5.4-mini' },
	/** Sibling/negative-path flow generator (post-recording opt-in). */
	siblingGen: { openai: 'gpt-4.1-mini', azure: 'gpt-5.4-mini' },
	/** Cross-run drift analyzer (compares two runs). */
	driftAnalyzer: { openai: 'gpt-4.1', azure: 'gpt-4.1' },
	/** Sensitive-data classifier fallback when the regex heuristic is uncertain. */
	sensitiveClassifier: { openai: 'gpt-4.1-mini', azure: 'gpt-5.4-mini' },
	/**
	 * Test-matrix generator (Phase 3.5b — Pro tier).
	 * Reasoning model is intentional: one-time-per-flow cost amortized across
	 * every future batch run. On Azure we use GPT-5.4 (Apr 2026 GA) with
	 * `reasoning_effort=high` per user instruction "dont be sticky with only o3".
	 */
	matrixGenerator: { openai: 'o3', azure: 'gpt-5.4' },
	matrixGeneratorFallback: { openai: 'o4-mini', azure: 'o4-mini' },
	/** AI cluster analysis after a matrix batch completes. */
	matrixCluster: { openai: 'o4-mini', azure: 'gpt-5.4-mini' },
} as const;

export type ModelKey = keyof typeof MODEL_TABLE;

/**
 * Per-stage env override keys.
 *
 * The canonical name is `FLOWLENS_MODEL_<CAMEL_TO_SCREAMING_SNAKE>`. Several
 * older keys ship in existing .env files (FLOWLENS_MODEL_DRIFT,
 * FLOWLENS_MODEL_SENSITIVE, FLOWLENS_MODEL_MATRIX_FALLBACK) — those are
 * accepted as legacy aliases so flipping providers doesn't require an env
 * rewrite. New deployments should use the canonical keys.
 *
 * Keep the LEGACY_ALIASES table in sync with the Python mirror in
 * apps/replay-worker/app/llm_client.py.
 */
const LEGACY_ALIASES: Partial<Record<ModelKey, string>> = {
	driftAnalyzer: 'FLOWLENS_MODEL_DRIFT',
	sensitiveClassifier: 'FLOWLENS_MODEL_SENSITIVE',
	matrixGeneratorFallback: 'FLOWLENS_MODEL_MATRIX_FALLBACK',
};

function canonicalEnvKey(stage: ModelKey): string {
	const snake = stage.replace(/[A-Z]/g, (c) => '_' + c).toUpperCase();
	return `FLOWLENS_MODEL_${snake}`;
}

/**
 * Resolve a stage to the concrete model/deployment name for the active
 * provider. Per-stage env override wins if present (canonical key first,
 * then legacy alias).
 *
 * Evaluated lazily on every call — safe to flip LLM_PROVIDER at runtime.
 */
export function modelFor(stage: ModelKey): string {
	const canonical = process.env[canonicalEnvKey(stage)];
	if (canonical && canonical.trim().length > 0) return canonical;
	const legacyKey = LEGACY_ALIASES[stage];
	if (legacyKey) {
		const legacy = process.env[legacyKey];
		if (legacy && legacy.trim().length > 0) return legacy;
	}
	const provider = getProvider();
	return MODEL_TABLE[stage][provider];
}

/**
 * MODELS proxy preserves the original `MODELS.narrate` access pattern but
 * resolves at call-time so flipping LLM_PROVIDER takes effect without a
 * process restart in dev. Read-only.
 */
export const MODELS: Readonly<Record<ModelKey, string>> = new Proxy(
	{} as Record<ModelKey, string>,
	{
		get(_target, prop) {
			if (typeof prop !== 'string') return undefined;
			if (!(prop in MODEL_TABLE)) return undefined;
			return modelFor(prop as ModelKey);
		},
		ownKeys() {
			return Object.keys(MODEL_TABLE);
		},
		getOwnPropertyDescriptor(_target, prop) {
			if (typeof prop === 'string' && prop in MODEL_TABLE) {
				return { enumerable: true, configurable: true, value: modelFor(prop as ModelKey) };
			}
			return undefined;
		},
	},
);

export type ModelName = string;

/** Snapshot of every stage's resolved model for the current provider. */
export function modelTableSnapshot(): Record<ModelKey, string> {
	const out = {} as Record<ModelKey, string>;
	for (const k of Object.keys(MODEL_TABLE) as ModelKey[]) out[k] = modelFor(k);
	return out;
}

export { getLlmClient, hasLlmCredentials } from './client';
