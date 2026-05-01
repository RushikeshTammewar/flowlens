#!/usr/bin/env tsx
/**
 * Phase 4 / Tier 1 — schema round-trip smoke.
 *
 * Decode → encode → decode each of the new Zod schemas and assert the
 * second decode equals the first. Run via:
 *
 *   pnpm --filter @flowlens/web exec tsx scripts/phase4-tier1-schema-smoke.ts
 *
 * Logged under scope: [phase4:smoke].
 */
import {
	AssertionEvalSchema,
	AssertionSchema,
	BehaviorVerdictSchema,
	FeatureContractSchema,
	TwoAxisReportSchema,
} from '@flowlens/schema';

type Schema = {
	parse: (raw: unknown) => unknown;
};

const cases: Array<{ name: string; schema: Schema; sample: unknown }> = [
	{
		name: 'FeatureContractSchema',
		schema: FeatureContractSchema as unknown as Schema,
		sample: {
			featureName: 'Course Table Filter',
			inputs: [
				{
					name: 'Language',
					controlType: 'radio',
					domain: ['Any', 'Java', 'Python'],
					constraints: null,
					defaultValue: 'Any',
				},
				{
					name: 'Min Enrollments',
					controlType: 'number',
					domain: 'number',
					constraints: {
						min: 0,
						max: 100000,
						minLength: null,
						maxLength: null,
						pattern: null,
					},
					defaultValue: null,
				},
			],
			expectedBehaviors: [
				{
					id: 'behavior-language-narrows',
					given: 'When Language=Java is selected',
					when: 'and other filters are unchecked',
					then: 'the table shows only Java rows',
					observableOutcome: 'DOM table rows have Language=Java',
					importance: 'critical',
				},
			],
			invariants: ['no console errors', 'no 5xx responses'],
			synthesizedAt: '2026-05-01T10:00:00.000Z',
			synthesizedByModel: 'gpt-4.1',
		},
	},
	{
		name: 'AssertionSchema (row_content_match)',
		schema: AssertionSchema as unknown as Schema,
		sample: {
			spec: {
				kind: 'row_content_match',
				rowSelector: 'table tr',
				cellSelector: 'td.lang',
				expectedValue: 'Java',
			},
			fallbackPrompt: 'Every row in the table shows Language=Java.',
		},
	},
	{
		name: 'AssertionEvalSchema',
		schema: AssertionEvalSchema as unknown as Schema,
		sample: {
			passed: true,
			evaluatedKind: 'row_content_match',
			reason: 'all 17 visible rows had td.lang === "Java"',
			evidence: { matchedRowCount: 17 },
			evaluatedAt: '2026-05-01T10:05:00.000Z',
			durationMs: 142,
			llmFallbackUsed: false,
		},
	},
	{
		name: 'BehaviorVerdictSchema',
		schema: BehaviorVerdictSchema as unknown as Schema,
		sample: {
			behaviorId: 'behavior-language-narrows',
			behaviorTitle: 'Language=Java narrows to Java rows',
			status: 'partial',
			modes: [
				{ mode: 'verify', variantsTotal: 2, variantsPassed: 2, variantsFailed: 0 },
				{ mode: 'edge', variantsTotal: 3, variantsPassed: 2, variantsFailed: 1 },
				{ mode: 'stress', variantsTotal: 2, variantsPassed: 2, variantsFailed: 0 },
				{ mode: 'adversarial', variantsTotal: 1, variantsPassed: 0, variantsFailed: 1 },
				{ mode: 'invariant', variantsTotal: 0, variantsPassed: 0, variantsFailed: 0 },
			],
			failingVariantIds: ['v-edge-empty-input', 'v-adversarial-sql'],
			failureSummary: 'edge: empty filter resets table; adversarial: SQL fragment accepted.',
		},
	},
	{
		name: 'TwoAxisReportSchema',
		schema: TwoAxisReportSchema as unknown as Schema,
		sample: {
			correctness: { verified: 9, total: 9 },
			robustness: { verified: 23, total: 27 },
			behaviorVerdicts: [
				{
					behaviorId: 'behavior-foo',
					behaviorTitle: 'foo bars baz',
					status: 'verified',
					modes: [
						{ mode: 'verify', variantsTotal: 1, variantsPassed: 1, variantsFailed: 0 },
					],
					failingVariantIds: [],
				},
			],
			clusterSummary: null,
		},
	},
];

let failures = 0;
for (const c of cases) {
	try {
		const decoded = c.schema.parse(c.sample);
		const reEncoded = JSON.parse(JSON.stringify(decoded));
		const reDecoded = c.schema.parse(reEncoded);
		const stable = JSON.stringify(decoded) === JSON.stringify(reDecoded);
		if (!stable) {
			throw new Error('round-trip not stable: decode→encode→decode produced a different shape');
		}
		console.info(`[phase4:smoke] OK  ${c.name}`);
	} catch (err) {
		failures += 1;
		console.error(`[phase4:smoke] FAIL ${c.name}: ${(err as Error).message}`);
	}
}

if (failures > 0) {
	console.error(`[phase4:smoke] ${failures} schema(s) failed round-trip`);
	process.exit(1);
}
console.info(`[phase4:smoke] all ${cases.length} schemas round-tripped cleanly`);
