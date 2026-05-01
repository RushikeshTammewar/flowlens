#!/usr/bin/env node
/**
 * Phase 4 / Tier 3 — pure-logic smoke for the two-axis aggregator.
 *
 * The aggregator hits the DB; this smoke exercises the polarity +
 * rollup math directly by wrapping it. Locks the contract:
 *
 *   - verify mode: assertion.passed=true → variant pass (correctness++)
 *   - adversarial mode (shouldPass=false): assertion.passed=false →
 *     variant pass (robustness++)
 *   - mixed behavior with one verify fail → behavior status = 'failed'
 *   - all-pass on a behavior across modes → 'verified'
 *   - per-behavior status rollup matches the documented LLD §6.5 table
 *
 * No DB writes. Run after touching aggregate-batch-verdict.ts.
 *
 * Logged under scope: [phase4:tier3-smoke].
 */

import { strict as assert } from 'node:assert';

// We import the pure helper functions only — the DB-talking entry
// point isn't exercised here. To keep the import surface clean we
// duplicate the polarity logic locally; if the aggregator's polarity
// rule ever changes, this smoke must be updated to match.
//
// Note this is INTENTIONALLY a contract test — it documents the
// expected behavior, not the implementation.

function applyPolarity(rawAssertionPassed, shouldPass) {
	return shouldPass ? rawAssertionPassed : !rawAssertionPassed;
}

function rollupVerdict(modes) {
	const totalRun = modes.reduce((acc, m) => acc + m.variantsTotal, 0);
	if (totalRun === 0) return 'inconclusive';
	const totalPassed = modes.reduce((acc, m) => acc + m.variantsPassed, 0);
	if (totalPassed === totalRun) return 'verified';
	if (totalPassed === 0) return 'failed';
	const correctnessFailed = modes
		.filter((m) => m.mode === 'verify' || m.mode === 'edge')
		.some((m) => m.variantsFailed > 0);
	return correctnessFailed ? 'failed' : 'partial';
}

function log(msg) {
	console.log(`[phase4:tier3-smoke] ${msg}`);
}

// CASE 1 — adversarial polarity flip
{
	// shouldPass=false (adversarial); assertion didn't pass on the
	// page (input got rejected) → variant counts as PASSED.
	const variantPassed = applyPolarity(false, false);
	assert.equal(variantPassed, true, 'adversarial polarity should flip false→true');
	const variantFailed = applyPolarity(true, false);
	assert.equal(variantFailed, false, 'adversarial accepting input should fail');
	log('CASE 1 ok — adversarial polarity flip');
}

// CASE 2 — verify variant on healthy app
{
	const variantPassed = applyPolarity(true, true);
	assert.equal(variantPassed, true);
	const variantFailed = applyPolarity(false, true);
	assert.equal(variantFailed, false);
	log('CASE 2 ok — verify polarity straight-through');
}

// CASE 3 — behavior fully verified across modes
{
	const status = rollupVerdict([
		{ mode: 'verify', variantsTotal: 1, variantsPassed: 1, variantsFailed: 0 },
		{ mode: 'edge', variantsTotal: 2, variantsPassed: 2, variantsFailed: 0 },
		{ mode: 'stress', variantsTotal: 1, variantsPassed: 1, variantsFailed: 0 },
	]);
	assert.equal(status, 'verified');
	log('CASE 3 ok — all-pass behavior → verified');
}

// CASE 4 — verify failure flips status to 'failed'
{
	const status = rollupVerdict([
		{ mode: 'verify', variantsTotal: 1, variantsPassed: 0, variantsFailed: 1 },
		{ mode: 'edge', variantsTotal: 2, variantsPassed: 2, variantsFailed: 0 },
		{ mode: 'stress', variantsTotal: 1, variantsPassed: 1, variantsFailed: 0 },
	]);
	assert.equal(status, 'failed', 'verify failure must mark behavior failed');
	log('CASE 4 ok — verify failure → failed');
}

// CASE 5 — robustness break only → 'partial'
{
	const status = rollupVerdict([
		{ mode: 'verify', variantsTotal: 1, variantsPassed: 1, variantsFailed: 0 },
		{ mode: 'edge', variantsTotal: 1, variantsPassed: 1, variantsFailed: 0 },
		{ mode: 'adversarial', variantsTotal: 2, variantsPassed: 1, variantsFailed: 1 },
	]);
	assert.equal(status, 'partial', 'robustness break should NOT cascade to failed');
	log('CASE 5 ok — robustness break → partial');
}

// CASE 6 — total failure → 'failed'
{
	const status = rollupVerdict([
		{ mode: 'verify', variantsTotal: 1, variantsPassed: 0, variantsFailed: 1 },
		{ mode: 'edge', variantsTotal: 1, variantsPassed: 0, variantsFailed: 1 },
	]);
	assert.equal(status, 'failed');
	log('CASE 6 ok — total failure → failed');
}

// CASE 7 — empty mode list → inconclusive
{
	const status = rollupVerdict([]);
	assert.equal(status, 'inconclusive');
	log('CASE 7 ok — empty modes → inconclusive');
}

log('PASS — all 7 cases ok');
