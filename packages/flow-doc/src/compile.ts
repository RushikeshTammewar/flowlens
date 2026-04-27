/**
 * Recording → Flow Document compile pipeline. Called from
 * `apps/web/src/app/api/recordings/[id]/finish/route.ts` (initially as a
 * fire-and-forget Promise; Vercel Workflow migration is tracked in LLD §5).
 *
 * Stages (per LLD §5):
 *   1. Normalize: drop noise (cookie banners, scroll-only steps).
 *   2. Narrate: parallel ×4 LLM call per remaining action (vision).
 *   3. Synthesize: single gpt-4.1 call producing the Flow document.
 *   4. Sibling generation: optional gpt-4.1-mini call, capped at 3 flows.
 *
 * Each stage emits a `compile_progress` SSE-shaped event via `progress.emit`.
 */
import type { FlowStep, RecordedAction } from '@flowlens/schema';
import { narrateStep, type NarrationOutput } from './narrate-step';
import { synthesizeFlow, type FlowSynthesisOutput } from './synthesize-flow';
import { suggestSiblingFlows, type SiblingFlowsOutput } from './sibling-flows';
import { classifySensitive } from './sensitive-classify';

export interface CompileProgressEvent {
	pct: number; // 0..100
	stage: 'normalize' | 'narrate' | 'synthesize' | 'siblings' | 'persist';
	detail?: string;
}

export type CompileProgressEmitter = (e: CompileProgressEvent) => void;

export interface CompileInput {
	flowId: string;
	siteOrigin: string;
	siteModelText: string | null;
	actions: RecordedAction[];
	/** Resolves a per-action screenshot to an https:// URL OpenAI vision can fetch. */
	resolveScreenshotUrl: (input: { actionIndex: number }) => Promise<string | null>;
	progress: CompileProgressEmitter;
	/** Concurrency for narrate-step calls. Default 4. */
	narrateConcurrency?: number;
	/** When true, skip the sibling-flow LLM call (e.g. on re-compile). */
	skipSiblings?: boolean;
}

export interface CompileOutput {
	steps: FlowStep[];
	synthesis: FlowSynthesisOutput;
	siblings: SiblingFlowsOutput | null;
	llmTokensUsed: number;
	llmCostUsdMicroEstimate: number;
}

/** Drop low-information actions (scroll-only, duplicate clicks within 250ms, etc.). */
function normalizeActions(actions: RecordedAction[]): RecordedAction[] {
	const out: RecordedAction[] = [];
	let lastClickKey: string | null = null;
	let lastClickAt = -Infinity;
	for (const a of actions) {
		// Scroll-only with no DOM mutation hints — drop.
		if (a.type === 'scroll') continue;
		// Coalesce repeated clicks on the same target within 250ms.
		if (a.type === 'click') {
			const key = JSON.stringify(a.selectors);
			if (key === lastClickKey && a.timestamp - lastClickAt < 250) continue;
			lastClickKey = key;
			lastClickAt = a.timestamp;
		}
		out.push(a);
	}
	// Re-index to be contiguous after filtering.
	return out.map((a, i) => ({ ...a, index: i }));
}

const TOKEN_PRICE_USD_MICRO_PER_M_INPUT: Record<string, number> = {
	'gpt-4.1-mini': 400,
	'gpt-4.1': 2_500,
	'o4-mini': 1_100,
};
const TOKEN_PRICE_USD_MICRO_PER_M_OUTPUT: Record<string, number> = {
	'gpt-4.1-mini': 1_600,
	'gpt-4.1': 10_000,
	'o4-mini': 4_400,
};

function estimateCostUsdMicro(model: string, prompt: number, completion: number): number {
	const inRate = TOKEN_PRICE_USD_MICRO_PER_M_INPUT[model] ?? 1_000;
	const outRate = TOKEN_PRICE_USD_MICRO_PER_M_OUTPUT[model] ?? 5_000;
	return Math.round(((prompt / 1_000_000) * inRate + (completion / 1_000_000) * outRate) * 1_000_000) / 1_000_000;
}

async function pMap<T, R>(items: T[], fn: (item: T, i: number) => Promise<R>, concurrency: number): Promise<R[]> {
	const results: R[] = new Array(items.length);
	let cursor = 0;
	const workers = Array.from({ length: Math.max(1, concurrency) }, async () => {
		while (true) {
			const i = cursor++;
			if (i >= items.length) return;
			const item = items[i];
			if (item === undefined) return;
			results[i] = await fn(item, i);
		}
	});
	await Promise.all(workers);
	return results;
}

export async function compileRecording(input: CompileInput): Promise<CompileOutput> {
	const { progress } = input;
	let totalTokens = 0;
	let totalCostUsdMicro = 0;

	progress({ pct: 0, stage: 'normalize' });
	const normalized = normalizeActions(input.actions);
	if (normalized.length === 0) {
		throw new Error('Recording contained no semantic actions after normalization.');
	}
	progress({ pct: 10, stage: 'normalize', detail: `${normalized.length} actions retained` });

	progress({ pct: 11, stage: 'narrate', detail: 'classifying ambiguous inputs' });
	// LLM-fallback sensitive classifier — only run on input/change actions that
	// the regex/input-type heuristic in @flowlens/recorder-core flagged as NOT
	// sensitive. Catches non-obvious cases (security questions, custom auth
	// fields, etc.). Keeps cost bounded — typically 1-3 calls per recording.
	const ambiguous = normalized.filter(
		(a) => (a.type === 'input' || a.type === 'change') && !a.isSensitiveByHeuristic && a.value,
	);
	const reclassified = new Set<number>();
	for (const a of ambiguous.slice(0, 5)) {
		try {
			const res = await classifySensitive({
				fieldName: a.selectors.css ?? '',
				fieldId: a.selectors.testid ?? '',
				placeholder: '',
				autocomplete: '',
				surroundingLabelText: a.selectors.accessibleName ?? '',
			});
			if (res.value.isSensitive && res.value.confidence >= 0.6) {
				reclassified.add(a.index);
				totalTokens += res.usage.totalTokens;
				totalCostUsdMicro += estimateCostUsdMicro(
					res.model,
					res.usage.promptTokens,
					res.usage.completionTokens,
				);
			}
		} catch {
			// Best-effort; never fail the whole compile on classifier hiccups.
		}
	}

	progress({ pct: 12, stage: 'narrate' });
	const narrations = await pMap(
		normalized,
		async (action, i) => {
			const currentScreenshotUrl = await input.resolveScreenshotUrl({ actionIndex: action.index });
			if (!currentScreenshotUrl) {
				// Skip narration for actions we have no screenshot for; we'll fall back
				// to a heuristic intent below.
				return { action, narration: null as NarrationOutput | null, model: '', tokens: 0 };
			}
			const prevAction = normalized[i - 1];
			const prevScreenshotUrl = prevAction
				? await input.resolveScreenshotUrl({ actionIndex: prevAction.index })
				: null;

			const res = await narrateStep({
				prevScreenshotUrl,
				currentScreenshotUrl,
				actionType: action.type,
				url: action.url,
				pageTitle: '', // we don't capture page title per-action yet (Phase 2.5)
				recordedValue: action.value ?? null,
				selectors: {
					...(action.selectors.role !== undefined ? { role: action.selectors.role } : {}),
					...(action.selectors.accessibleName !== undefined ? { accessibleName: action.selectors.accessibleName } : {}),
					...(action.selectors.testid !== undefined ? { testid: action.selectors.testid } : {}),
					...(action.selectors.css !== undefined ? { css: action.selectors.css } : {}),
				},
			});
			totalTokens += res.usage.totalTokens;
			totalCostUsdMicro += estimateCostUsdMicro(res.model, res.usage.promptTokens, res.usage.completionTokens);
			progress({
				pct: 12 + Math.round(((i + 1) / normalized.length) * 60),
				stage: 'narrate',
				detail: `step ${i + 1}/${normalized.length}`,
			});
			return { action, narration: res.value, model: res.model, tokens: res.usage.totalTokens };
		},
		input.narrateConcurrency ?? 4,
	);

	progress({ pct: 75, stage: 'synthesize' });
	const synthesisInput = narrations.map(({ action, narration }) => ({
		index: action.index,
		actionType: action.type,
		intent: narration?.intent ?? `${action.type} on ${action.url}`,
		expectedOutcome: narration?.expectedOutcome ?? 'page state advances',
		isCritical: narration?.isCritical ?? action.type !== 'scroll',
	}));

	const synthesisResult = await synthesizeFlow({
		siteOrigin: input.siteOrigin,
		siteModelText: input.siteModelText,
		narratedSteps: synthesisInput,
	});
	totalTokens += synthesisResult.usage.totalTokens;
	totalCostUsdMicro += estimateCostUsdMicro(
		synthesisResult.model,
		synthesisResult.usage.promptTokens,
		synthesisResult.usage.completionTokens,
	);

	// Apply revisions returned by the synthesizer.
	const stepRevisions = new Map(
		synthesisResult.value.stepRevisions.map((r) => [r.index, r]),
	);

	const steps: FlowStep[] = narrations.map(({ action, narration }) => {
		const revision = stepRevisions.get(action.index);
		const intent = revision?.intentRevision ?? narration?.intent ?? `${action.type} on ${action.url}`;
		const expected =
			revision?.expectedOutcomeRevision ?? narration?.expectedOutcome ?? 'page state advances';
		const isSensitive = action.isSensitiveByHeuristic || reclassified.has(action.index);
		return {
			index: action.index,
			action: actionTypeToFlowStep(action.type),
			intent,
			expectedOutcome: expected,
			isCritical: narration?.isCritical ?? action.type !== 'scroll',
			selectors: action.selectors,
			...(action.value !== undefined && !isSensitive ? { recordedValue: action.value } : {}),
			isSensitive,
			recordedScreenshotKey: action.screenshotKey ?? '',
			...(action.url ? { url: action.url } : {}),
		};
	});

	progress({ pct: 90, stage: 'siblings' });
	let siblings: SiblingFlowsOutput | null = null;
	if (!input.skipSiblings) {
		try {
			const sib = await suggestSiblingFlows({
				siteOrigin: input.siteOrigin,
				parentFlow: { name: synthesisResult.value.name, description: synthesisResult.value.description },
				steps: steps.map((s) => ({
					intent: s.intent,
					expectedOutcome: s.expectedOutcome,
					isCritical: s.isCritical,
				})),
			});
			siblings = sib.value;
			totalTokens += sib.usage.totalTokens;
			totalCostUsdMicro += estimateCostUsdMicro(sib.model, sib.usage.promptTokens, sib.usage.completionTokens);
		} catch (err) {
			// Sibling generation is opt-in; never fail the whole compile if it errors.
			progress({
				pct: 92,
				stage: 'siblings',
				detail: `sibling generation skipped: ${(err as Error).message}`,
			});
		}
	}

	progress({ pct: 100, stage: 'persist' });
	return {
		steps,
		synthesis: synthesisResult.value,
		siblings,
		llmTokensUsed: totalTokens,
		llmCostUsdMicroEstimate: Math.round(totalCostUsdMicro * 1_000_000),
	};
}

function actionTypeToFlowStep(t: RecordedAction['type']): FlowStep['action'] {
	switch (t) {
		case 'change':
			return 'input';
		case 'submit':
			return 'click';
		case 'navigate':
			return 'navigate';
		case 'click':
			return 'click';
		case 'input':
			return 'input';
		case 'keypress':
			return 'keypress';
		case 'scroll':
			return 'scroll';
		default:
			return 'click';
	}
}
