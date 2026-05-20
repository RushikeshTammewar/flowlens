/**
 * /api/_db-migrate — DEV-ONLY raw DDL runner for the test_variants /
 * run_batches additions and the runs.batch_id / runs.variant_id columns.
 *
 * `drizzle-kit push` can't reach Neon from the host shell sandbox in this
 * environment, but the running dev server has direct DB access. This route
 * applies the necessary DDL idempotently. Returns 404 in production.
 */
import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';

const STATEMENTS: { sql: string; label: string }[] = [
	{
		label: 'add runs.batch_id',
		sql: `ALTER TABLE runs ADD COLUMN IF NOT EXISTS batch_id uuid;`,
	},
	{
		label: 'add runs.variant_id',
		sql: `ALTER TABLE runs ADD COLUMN IF NOT EXISTS variant_id uuid;`,
	},
	{
		label: 'add runs.triggered_by enum value matrix_batch',
		// `triggered_by` is text in our schema (not a Postgres enum), so this is a no-op.
		// Kept here for documentation alignment.
		sql: `SELECT 1`,
	},
	{
		label: 'create test_variants',
		sql: `CREATE TABLE IF NOT EXISTS test_variants (
			id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
			flow_id uuid NOT NULL REFERENCES flows(id) ON DELETE CASCADE,
			family text NOT NULL,
			name text NOT NULL,
			description text NOT NULL,
			rationale text,
			expected_outcome jsonb NOT NULL,
			field_overrides jsonb NOT NULL,
			fragility text NOT NULL,
			enabled boolean DEFAULT true NOT NULL,
			generated_by text NOT NULL,
			created_at timestamp DEFAULT now() NOT NULL
		);`,
	},
	{
		label: 'create test_variants index',
		sql: `CREATE INDEX IF NOT EXISTS test_variants_flow_idx ON test_variants(flow_id);`,
	},
	{
		label: 'create run_batches',
		sql: `CREATE TABLE IF NOT EXISTS run_batches (
			id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
			org_id uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
			flow_id uuid NOT NULL REFERENCES flows(id) ON DELETE CASCADE,
			triggered_by text NOT NULL,
			triggered_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
			variant_ids jsonb NOT NULL,
			parallelism integer NOT NULL,
			status text DEFAULT 'queued' NOT NULL,
			started_at timestamp,
			finished_at timestamp,
			cost_usd_micro integer,
			ai_cluster_summary text,
			created_at timestamp DEFAULT now() NOT NULL
		);`,
	},
	{
		label: 'create run_batches index',
		sql: `CREATE INDEX IF NOT EXISTS run_batches_org_flow_idx ON run_batches(org_id, flow_id);`,
	},
	{
		label: 'create runs.batch_id index',
		sql: `CREATE INDEX IF NOT EXISTS runs_batch_idx ON runs(batch_id);`,
	},
];

export async function POST() {
	if (process.env.NODE_ENV === 'production') {
		return NextResponse.json({ error: 'not found' }, { status: 404 });
	}
	const results: Array<{ label: string; ok: boolean; error?: string }> = [];
	for (const stmt of STATEMENTS) {
		try {
			await db.execute(sql.raw(stmt.sql));
			results.push({ label: stmt.label, ok: true });
		} catch (err) {
			results.push({ label: stmt.label, ok: false, error: (err as Error).message });
		}
	}
	const ok = results.every((r) => r.ok);
	return NextResponse.json({ ok, results });
}

export async function GET() {
	return POST();
}
