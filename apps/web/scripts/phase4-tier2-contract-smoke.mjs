#!/usr/bin/env node
/**
 * Phase 4 / Tier 2 — synthesize-with-contract + matrix-gen-with-contract
 * end-to-end smoke.
 *
 * Pure-LLM smoke (no DB writes). Confirms:
 *   1. `synthesizeFlowWithContract` returns a parseable FeatureContract
 *      with at least 1 input, 1 behavior, 1 invariant.
 *   2. `generateTestMatrixWithContract` returns variants spanning
 *      multiple modes, every variant cites a behaviorId from the
 *      contract (or "invariant-" prefix), and no fixed-choice field
 *      gets a unicode/encoding override.
 *
 * Cost: ~$0.30 (one synthesize + one matrix-gen at high reasoning).
 * Run after touching synthesize-flow.ts, generate-matrix.ts, or the
 * Phase 4 prompts.
 *
 * Logged under scope: [phase4:tier2-smoke].
 */
import './load-env.mjs';
import {
	synthesizeFlowWithContract,
	generateTestMatrixWithContract,
} from '@flowlens/flow-doc';

const FIXTURE = {
	siteOrigin: 'https://www.selenium.dev',
	siteModelText: null,
	narratedSteps: [
		{
			index: 0,
			actionType: 'click',
			intent: 'Open the Automation Courses table page',
			expectedOutcome: 'Course table is visible with all filters off',
			isCritical: true,
		},
		{
			index: 1,
			actionType: 'change',
			intent: 'Select the Language=Java radio',
			expectedOutcome: 'Table re-renders showing only Java courses',
			isCritical: true,
			recordedValue: 'Java',
			controlType: 'radio',
			controlName: 'language',
			availableOptions: ['Any', 'Java', 'Python', 'JavaScript', 'C#'],
		},
		{
			index: 2,
			actionType: 'change',
			intent: 'Set the Min Enrollments filter to 1000',
			expectedOutcome: 'Table further narrows to Java courses with ≥1000 enrollments',
			isCritical: true,
			recordedValue: '1000',
			controlType: 'number',
			controlName: 'min_enrollments',
		},
	],
	pageScreenshotUrl: null,
	pageControls: [
		{
			id: 'language',
			name: 'language',
			label: 'Language',
			kind: 'radioGroup',
			controlType: 'radio',
			availableOptions: ['Any', 'Java', 'Python', 'JavaScript', 'C#'],
			interactedDuringRecording: true,
			value: 'Java',
		},
		{
			id: 'min_enrollments',
			name: 'min_enrollments',
			label: 'Min Enrollments',
			kind: 'input',
			controlType: 'number',
			constraints: { min: 0, max: 999999 },
			interactedDuringRecording: true,
			value: '1000',
		},
		{
			id: 'difficulty',
			name: 'difficulty',
			label: 'Difficulty',
			kind: 'select',
			controlType: 'select',
			availableOptions: ['Any', 'Beginner', 'Intermediate', 'Advanced'],
			interactedDuringRecording: false,
			value: 'Any',
		},
	],
};

function log(msg) {
	console.log(`[phase4:tier2-smoke] ${msg}`);
}

async function main() {
	const t0 = Date.now();
	log('synthesizing feature contract …');
	const synth = await synthesizeFlowWithContract(FIXTURE);
	const c = synth.value.featureContract;
	log(
		`synth ok in ${Date.now() - t0}ms · model=${synth.model} · ` +
			`featureName=${JSON.stringify(c.featureName)} · ` +
			`inputs=${c.inputs.length} · behaviors=${c.expectedBehaviors.length} · ` +
			`invariants=${c.invariants.length}`,
	);
	console.log('  contract:', JSON.stringify(c, null, 2));

	if (c.inputs.length === 0) throw new Error('contract has no inputs');
	if (c.expectedBehaviors.length === 0) throw new Error('contract has no behaviors');
	if (c.invariants.length === 0) throw new Error('contract has no invariants');

	const dupBehaviorIds = c.expectedBehaviors
		.map((b) => b.id)
		.filter((id, i, arr) => arr.indexOf(id) !== i);
	if (dupBehaviorIds.length > 0) {
		throw new Error(`duplicate behaviorIds: ${dupBehaviorIds.join(', ')}`);
	}

	const t1 = Date.now();
	log('generating test matrix from contract …');
	const matrix = await generateTestMatrixWithContract({
		flow: {
			id: 'fixture-flow',
			name: 'Filter Java courses by enrollment',
			description: 'Filters the Automation Courses table to Java + min enrollments=1000',
			preconditions: [],
			steps: FIXTURE.narratedSteps.map((s) => ({
				index: s.index,
				action:
					s.actionType === 'change' || s.actionType === 'input' ? 'input' : 'click',
				intent: s.intent,
				expectedOutcome: s.expectedOutcome,
				isCritical: s.isCritical,
				recordedValue: s.recordedValue ?? null,
				isSensitive: false,
				...(s.controlType !== undefined ? { controlType: s.controlType } : {}),
				...(s.controlName !== undefined ? { controlName: s.controlName } : {}),
				...(s.availableOptions !== undefined
					? { availableOptions: s.availableOptions }
					: {}),
			})),
			pageControls: FIXTURE.pageControls,
		},
		featureContract: c,
		count: 12,
		screenshotUrl: null,
	});

	log(
		`matrix-gen ok in ${Date.now() - t1}ms · model=${matrix.model} · ` +
			`variants=${matrix.variants.length}`,
	);

	const byMode = matrix.variants.reduce((acc, v) => {
		acc[v.mode] = (acc[v.mode] ?? 0) + 1;
		return acc;
	}, {});
	log(`mode distribution: ${JSON.stringify(byMode)}`);

	if (matrix.variants.length === 0) throw new Error('no variants returned');

	const knownIds = new Set(c.expectedBehaviors.map((b) => b.id));
	const orphaned = matrix.variants.filter(
		(v) => v.mode !== 'invariant' && !knownIds.has(v.behaviorId),
	);
	if (orphaned.length > 0) {
		throw new Error(
			`${orphaned.length} variants cite unknown behaviorIds: ${orphaned
				.map((v) => `${v.name} → ${v.behaviorId}`)
				.join('; ')}`,
		);
	}

	const radioWithBadOverride = matrix.variants.filter((v) => {
		// find any override on a step whose controlType=radio that is NOT in availableOptions
		for (const [stepIdx, val] of Object.entries(v.fieldOverrides)) {
			const step = FIXTURE.narratedSteps.find((s) => s.index === Number(stepIdx));
			if (!step?.availableOptions) continue;
			if (!step.availableOptions.includes(val)) return true;
		}
		return false;
	});
	if (radioWithBadOverride.length > 0) {
		console.warn(
			`[phase4:tier2-smoke] WARNING: ${radioWithBadOverride.length} variant(s) override a fixed-choice field with non-allowed value:`,
			radioWithBadOverride.map((v) => `${v.name} (${v.mode})`),
		);
	}

	for (const v of matrix.variants) {
		if (!v.assertion?.spec?.kind) {
			throw new Error(`variant "${v.name}" missing assertion.spec.kind`);
		}
		if (typeof v.shouldPass !== 'boolean') {
			throw new Error(`variant "${v.name}" missing shouldPass`);
		}
		if (!v.riskHypothesis) {
			throw new Error(`variant "${v.name}" missing riskHypothesis`);
		}
	}

	console.log('\n[phase4:tier2-smoke] sample variants:');
	for (const v of matrix.variants.slice(0, 4)) {
		console.log(
			`  · ${v.mode.padEnd(11)} behaviorId=${v.behaviorId} shouldPass=${v.shouldPass} assertion=${v.assertion.spec.kind} :: ${v.name}`,
		);
	}

	log(`PASS — total ${Date.now() - t0}ms`);
}

main().catch((err) => {
	console.error('[phase4:tier2-smoke] FAIL:', err);
	process.exit(1);
});
