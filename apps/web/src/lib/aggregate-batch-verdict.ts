/**
 * Phase 4 / Tier 3 — Two-axis verdict aggregator.
 *
 * Runs ONCE per batch in the web layer (not the sidecar) after every
 * variant terminates. Reads:
 *   - `test_variants` (mode + behaviorId + shouldPass per variant)
 *   - `runs` (status + variantId for variant→run join)
 *   - `step_results.assertion_eval` (sidecar-emitted variant-level
 *     AssertionEval, persisted by run-batch-inline.ts on the LAST step)
 *
 * Produces:
 *   - `BehaviorVerdict[]` — one entry per behaviorId touched by the
 *     batch (plus a synthetic one per invariant-mode variant).
 *   - `TwoAxisReport` — Correctness x Robustness rollup with
 *     {verified, total} pairs.
 *
 * Persists to `run_batches.behavior_verdicts` jsonb + the four scalar
 * `correctness/robustness {verified, total} count` columns. The
 * side-panel `MatrixReport.tsx` reads the scalars for the headline
 * pill and the verdicts array for the per-behavior detail (Tier 4 UI).
 *
 * POLARITY (single source of truth):
 *   The sidecar's AssertionEval reports the RAW assertion outcome:
 *   "did the asserted thing happen on the page?". For adversarial-
 *   mode variants where the test passes when the app REJECTS the
 *   input, the variant's `shouldPass: false` flag flips polarity at
 *   aggregation time. THIS IS THE ONLY PLACE polarity is applied —
 *   keep it that way to avoid drift between layers.
 *
 * Logged under scope: [phase4:aggregate]
 */
import { eq, inArray } from 'drizzle-orm';
import { db } from '@/lib/db';
import {
	runBatches,
	runs,
	stepResults,
	testVariants,
	flows,
} from '@flowlens/schema/db';
import {
	type AssertionEval,
	type BehaviorVerdict,
	type FeatureContract,
	type ModeOutcome,
	type TwoAxisReport,
	BehaviorVerdictSchema,
	FeatureContractSchema,
} from '@flowlens/schema';

type VariantMode = 'verify' | 'edge' | 'stress' | 'adversarial' | 'invariant';

const CORRECTNESS_MODES: VariantMode[] = ['verify', 'edge'];
const ROBUSTNESS_MODES: VariantMode[] = ['stress', 'adversarial', 'invariant'];

export interface AggregateInput {
	batchId: string;
}

export interface AggregateOutput {
	twoAxisReport: TwoAxisReport;
	persisted: boolean;
	skippedReason?: string;
}

/**
 * Compute and persist the two-axis verdict for a batch.
 *
 * Safe to call multiple times — recomputes from current row state on
 * each call (idempotent). If the batch has no Phase 4 variants the
 * function still emits a degenerate report (zeros across the board)
 * and writes it; the UI distinguishes "phase 3 batch" (verdict empty)
 * from "phase 4 batch with all-skip" by checking the variant-mode
 * column upstream.
 */
export async function aggregateBatchVerdict(
	input: AggregateInput,
): Promise<AggregateOutput> {
	const startedAt = Date.now();

	const batch = await db.query.runBatches.findFirst({
		where: eq(runBatches.id, input.batchId),
	});
	if (!batch) {
		return {
			twoAxisReport: emptyReport(),
			persisted: false,
			skippedReason: `batch ${input.batchId} not found`,
		};
	}

	const allRuns = await db.query.runs.findMany({
		where: eq(runs.batchId, input.batchId),
	});
	if (allRuns.length === 0) {
		return {
			twoAxisReport: emptyReport(),
			persisted: false,
			skippedReason: 'no runs in batch',
		};
	}

	const variantIds = Array.from(
		new Set(allRuns.map((r) => r.variantId).filter((id): id is string => Boolean(id))),
	);
	const allVariants = variantIds.length
		? await db.query.testVariants.findMany({
				where: inArray(testVariants.id, variantIds),
			})
		: [];

	// Pull AssertionEvals from step_results. We persist them on the LAST
	// step of each run (run-batch-inline.ts does this). One fetch per
	// batch — reasonable since a 12-variant batch is at most ~60 step
	// rows total.
	const runIds = allRuns.map((r) => r.id);
	const allStepResults = runIds.length
		? await db.query.stepResults.findMany({
				where: inArray(stepResults.runId, runIds),
			})
		: [];
	const assertionEvalByRun = new Map<string, AssertionEval>();
	for (const sr of allStepResults) {
		const ae = (sr as { assertionEval?: unknown }).assertionEval;
		if (!ae) continue;
		// Last write wins — step_results is sorted by step_index ASC by
		// query default; the last assertion_eval write goes on the final
		// step. This handles the case where multiple steps somehow
		// carry one (shouldn't happen in Tier 3 but be defensive).
		assertionEvalByRun.set(sr.runId, ae as AssertionEval);
	}

	// Optional context — when the flow has a featureContract, we can
	// look up behavior titles + importance for richer report rows. When
	// absent (Phase 3 flow re-batched), we fall back to behaviorId.
	const flow = await db.query.flows.findFirst({ where: eq(flows.id, batch.flowId) });
	const contract: FeatureContract | null = (() => {
		const raw = (flow as { featureContract?: unknown } | undefined)?.featureContract;
		if (!raw) return null;
		const parsed = FeatureContractSchema.safeParse(raw);
		return parsed.success ? parsed.data : null;
	})();

	// Group variants by behaviorId (or "invariant-<n>" synthetic).
	const byBehavior = new Map<string, BehaviorVerdict>();

	for (const variant of allVariants) {
		const v = variant as typeof variant & {
			mode: VariantMode | null;
			behaviorId: string | null;
			shouldPass: boolean;
		};
		const mode: VariantMode | null = v.mode ?? null;
		if (!mode) continue; // V1 variant — not part of two-axis rollup

		const behaviorId =
			v.behaviorId ??
			(mode === 'invariant' ? `invariant-${variant.id.slice(0, 8)}` : `unknown-${variant.id.slice(0, 8)}`);

		const run = allRuns.find((r) => r.variantId === variant.id);
		if (!run) continue;

		const assertionEval = assertionEvalByRun.get(run.id) ?? null;
		// Apply polarity: shouldPass=true → assertion.passed counts as
		// variant pass; shouldPass=false (adversarial) → assertion.passed
		// false counts as variant pass. When no assertionEval exists
		// (e.g. sidecar didn't emit one — older sidecar or skipped),
		// fall back to run.status.
		const variantPassed = (() => {
			if (assertionEval) {
				const raw = assertionEval.passed;
				return v.shouldPass ? raw : !raw;
			}
			return run.status === 'passed';
		})();

		const behaviorTitle = (() => {
			if (mode === 'invariant') return `Invariant: ${variant.name}`;
			const b = contract?.expectedBehaviors.find((bb) => bb.id === behaviorId);
			return b?.then ?? variant.name;
		})();

		const verdict: BehaviorVerdict = byBehavior.get(behaviorId) ?? {
			behaviorId,
			behaviorTitle,
			status: 'verified',
			modes: [],
			failingVariantIds: [],
		};

		let modeOutcome: ModeOutcome | undefined = verdict.modes.find((m) => m.mode === mode);
		if (!modeOutcome) {
			modeOutcome = { mode, variantsTotal: 0, variantsPassed: 0, variantsFailed: 0 };
			verdict.modes.push(modeOutcome);
		}
		modeOutcome.variantsTotal += 1;
		if (variantPassed) modeOutcome.variantsPassed += 1;
		else modeOutcome.variantsFailed += 1;

		if (!variantPassed) {
			verdict.failingVariantIds.push(variant.id);
		}

		byBehavior.set(behaviorId, verdict);
	}

	// Compute per-behavior status from mode rollups.
	for (const verdict of byBehavior.values()) {
		verdict.status = computeBehaviorStatus(verdict);
		// First failure reason for the report row — pick the most
		// actionable: prefer verify-mode failure (correctness break),
		// fall back to first failure overall.
		if (verdict.failingVariantIds.length > 0 && !verdict.failureSummary) {
			const firstFailingVariantId = verdict.failingVariantIds[0];
			if (firstFailingVariantId) {
				const firstFailingRun = allRuns.find((r) => r.variantId === firstFailingVariantId);
				const ae = firstFailingRun ? assertionEvalByRun.get(firstFailingRun.id) : null;
				verdict.failureSummary =
					ae?.reason ?? firstFailingRun?.summary ?? 'variant did not pass its assertion';
			}
		}
	}

	const verdicts = [...byBehavior.values()];

	// Two-axis rollup. Correctness covers behavior-functional modes
	// (verify + edge); robustness covers cross-cutting modes (stress +
	// adversarial + invariant). A behavior counts as "verified" on an
	// axis iff EVERY variant in the relevant modes passed.
	const correctness = sumAxis(verdicts, CORRECTNESS_MODES);
	const robustness = sumAxis(verdicts, ROBUSTNESS_MODES);

	const twoAxisReport: TwoAxisReport = {
		correctness,
		robustness,
		behaviorVerdicts: verdicts.map((v) => BehaviorVerdictSchema.parse(v)),
		clusterSummary: batch.aiClusterSummary ?? null,
	};

	console.info(
		`[phase4:aggregate] batch=${input.batchId} behaviors=${verdicts.length} ` +
			`correctness=${correctness.verified}/${correctness.total} ` +
			`robustness=${robustness.verified}/${robustness.total} ` +
			`(${Date.now() - startedAt}ms)`,
	);

	// Persist to run_batches.* — additive write, leaves status /
	// finishedAt / aiClusterSummary alone (those are written by
	// run-batch-inline.ts before this aggregator runs).
	await db
		.update(runBatches)
		.set({
			behaviorVerdicts: verdicts,
			correctnessVerifiedCount: correctness.verified,
			correctnessTotalCount: correctness.total,
			robustnessVerifiedCount: robustness.verified,
			robustnessTotalCount: robustness.total,
		})
		.where(eq(runBatches.id, input.batchId));

	return { twoAxisReport, persisted: true };
}

function computeBehaviorStatus(v: BehaviorVerdict): BehaviorVerdict['status'] {
	const totalRun = v.modes.reduce((acc, m) => acc + m.variantsTotal, 0);
	if (totalRun === 0) return 'inconclusive';

	const totalPassed = v.modes.reduce((acc, m) => acc + m.variantsPassed, 0);
	if (totalPassed === totalRun) return 'verified';
	if (totalPassed === 0) return 'failed';

	// Mixed — distinguish "correctness still works, just fragile in
	// stress/adversarial" (partial) from "core flow broken" (failed).
	const correctnessFailed = v.modes
		.filter((m) => CORRECTNESS_MODES.includes(m.mode as VariantMode))
		.some((m) => m.variantsFailed > 0);
	return correctnessFailed ? 'failed' : 'partial';
}

function sumAxis(
	verdicts: BehaviorVerdict[],
	modes: VariantMode[],
): { verified: number; total: number } {
	let verified = 0;
	let total = 0;
	for (const v of verdicts) {
		const relevant = v.modes.filter((m) => modes.includes(m.mode as VariantMode));
		if (relevant.length === 0) continue;
		total += 1;
		if (relevant.every((m) => m.variantsFailed === 0 && m.variantsTotal > 0)) {
			verified += 1;
		}
	}
	return { verified, total };
}

function emptyReport(): TwoAxisReport {
	return {
		correctness: { verified: 0, total: 0 },
		robustness: { verified: 0, total: 0 },
		behaviorVerdicts: [],
		clusterSummary: null,
	};
}
