#!/usr/bin/env node
/**
 * Phase 4 / Tier 1 — Neon column verification.
 *
 * Queries `information_schema.columns` for each of the 13 additive
 * columns introduced in this tier and prints a one-row-per-column
 * report. Exits non-zero if any column is missing.
 *
 * Run with:
 *   node apps/web/scripts/phase4-tier1-verify-columns.mjs
 *
 * Logged under scope: [phase4:verify].
 */
import './load-env.mjs';

const EXPECTED = [
	{ table: 'orgs', column: 'monthly_feature_cap', type: 'integer' },
	{ table: 'orgs', column: 'monthly_features_consumed', type: 'integer' },
	{ table: 'flows', column: 'feature_contract', type: 'jsonb' },
	{ table: 'test_variants', column: 'mode', type: 'text' },
	{ table: 'test_variants', column: 'behavior_id', type: 'text' },
	{ table: 'test_variants', column: 'assertion', type: 'jsonb' },
	{ table: 'test_variants', column: 'should_pass', type: 'boolean' },
	{ table: 'test_variants', column: 'risk_hypothesis', type: 'text' },
	{ table: 'run_batches', column: 'behavior_verdicts', type: 'jsonb' },
	{ table: 'run_batches', column: 'correctness_verified_count', type: 'integer' },
	{ table: 'run_batches', column: 'correctness_total_count', type: 'integer' },
	{ table: 'run_batches', column: 'robustness_verified_count', type: 'integer' },
	{ table: 'run_batches', column: 'robustness_total_count', type: 'integer' },
	{ table: 'step_results', column: 'assertion_eval', type: 'jsonb' },
];

const { Pool } = await import('pg');
const url = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;
if (!url) {
	console.error('[phase4:verify] DATABASE_URL{,_UNPOOLED} is not set');
	process.exit(1);
}
const pool = new Pool({ connectionString: url });

const tables = [...new Set(EXPECTED.map((c) => c.table))];
const { rows } = await pool.query(
	`SELECT table_name, column_name, data_type, is_nullable, column_default
	 FROM information_schema.columns
	 WHERE table_schema = 'public' AND table_name = ANY($1::text[])
	 ORDER BY table_name, ordinal_position`,
	[tables],
);

const seen = new Map(rows.map((r) => [`${r.table_name}.${r.column_name}`, r]));

let missing = 0;
let mistyped = 0;
console.log('[phase4:verify] expected columns:');
for (const want of EXPECTED) {
	const key = `${want.table}.${want.column}`;
	const got = seen.get(key);
	if (!got) {
		console.error(`  MISSING  ${key}`);
		missing += 1;
		continue;
	}
	const typeOk = got.data_type === want.type;
	if (!typeOk) mistyped += 1;
	console.log(
		`  ${typeOk ? 'OK     ' : 'TYPE!  '} ${key}  type=${got.data_type}  nullable=${got.is_nullable}  default=${got.column_default ?? 'NULL'}`,
	);
}

await pool.end();

if (missing > 0 || mistyped > 0) {
	console.error(`[phase4:verify] ${missing} missing, ${mistyped} mistyped`);
	process.exit(1);
}
console.log(`[phase4:verify] all ${EXPECTED.length} columns present`);
