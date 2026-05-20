/**
 * Re-export shim. Real registry lives in @flowlens/llm-config so that
 * packages/flow-doc and packages/replay-engine can import the same constants
 * without a `apps/web` → `packages/*` cycle.
 */
export { MODELS, type ModelKey, type ModelName } from '@flowlens/llm-config';
