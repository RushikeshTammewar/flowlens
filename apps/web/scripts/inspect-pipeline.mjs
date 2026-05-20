#!/usr/bin/env node
/**
 * One-off pipeline diagnostic.
 *
 * Reads the most recent rows in `recordings`, `flows`, `cookie_snapshots`,
 * `runs`, `run_batches` and pretty-prints them so we can answer "did the
 * latest recording actually compile?" without spinning up the dashboard.
 *
 * Usage:
 *   /Users/rtammewar/.nvm/versions/node/v22.22.0/bin/node \
 *     apps/web/scripts/inspect-pipeline.mjs
 */
import './load-env.mjs';
import pg from 'pg';

const { Pool } = pg;

const cs = process.env.DATABASE_URL;
if (!cs) {
	console.error('DATABASE_URL not set in apps/web/.env.local');
	process.exit(1);
}

const pool = new Pool({ connectionString: cs, max: 2 });

function fmtDate(d) {
	if (!d) return '∅';
	return new Date(d).toISOString();
}

function shortId(s) {
	if (!s) return '∅';
	return String(s).slice(0, 8);
}

function trunc(s, n = 80) {
	if (s == null) return '∅';
	const str = typeof s === 'string' ? s : JSON.stringify(s);
	return str.length > n ? str.slice(0, n) + '…' : str;
}

async function q(sql, params = []) {
	const res = await pool.query(sql, params);
	return res.rows;
}

console.log('═══════════════════════════════════════════════════════════════');
console.log(' Flowlens pipeline inspector');
console.log('═══════════════════════════════════════════════════════════════');

// ── Recordings ─────────────────────────────────────────────────────────
console.log('\n▶ recordings (last 5)');
const recs = await q(`
	SELECT
		id,
		flow_id,
		started_at,
		finished_at,
		jsonb_array_length(rrweb_chunks) AS chunk_count,
		(rrweb_chunks->-1->>'ordinal')::int AS last_chunk_ordinal,
		(SELECT COALESCE(SUM((c->>'bytes')::bigint), 0) FROM jsonb_array_elements(rrweb_chunks) AS c) AS total_chunk_bytes,
		action_stream_blob_key
	FROM recordings
	ORDER BY started_at DESC
	LIMIT 5
`);
if (!recs.length) {
	console.log('  (no rows)');
} else {
	for (const r of recs) {
		const status = r.finished_at ? 'finished' : 'in-flight';
		console.log(
			`  ${shortId(r.id)} flow=${shortId(r.flow_id)}  ${status}  ` +
				`started=${fmtDate(r.started_at)}  finished=${fmtDate(r.finished_at)}  ` +
				`chunks=${r.chunk_count}  bytes=${r.total_chunk_bytes}  ` +
				`stream=${r.action_stream_blob_key ? '✓' : '∅'}`,
		);
	}
}

const latestRec = recs[0];

// ── Flows ──────────────────────────────────────────────────────────────
console.log('\n▶ flows (last 5)');
const flowRows = await q(`
	SELECT
		id, status, name, description, source,
		cookie_snapshot_id, parent_flow_id, bu_profile_id,
		jsonb_array_length(steps) AS step_count,
		jsonb_array_length(preconditions) AS pre_count,
		jsonb_array_length(postconditions) AS post_count,
		jsonb_array_length(fragility_hints) AS frag_count,
		intent_report IS NOT NULL AS has_intent_report,
		matrix_gen_cost_usd_micro,
		created_at, updated_at
	FROM flows
	ORDER BY created_at DESC
	LIMIT 5
`);
if (!flowRows.length) {
	console.log('  (no rows)');
} else {
	for (const f of flowRows) {
		console.log(
			`  ${shortId(f.id)}  ${f.status.padEnd(10)} steps=${f.step_count}  ` +
				`pre=${f.pre_count}/post=${f.post_count}/frag=${f.frag_count}  ` +
				`cookie=${f.cookie_snapshot_id ? '✓' : '∅'}  ` +
				`parent=${f.parent_flow_id ? shortId(f.parent_flow_id) : '∅'}  ` +
				`intent=${f.has_intent_report ? '✓' : '∅'}  bu=${f.bu_profile_id ? '✓' : '∅'}`,
		);
		console.log(`    name="${trunc(f.name, 60)}"`);
		if (f.description) console.log(`    desc="${trunc(f.description, 100)}"`);
		console.log(`    created=${fmtDate(f.created_at)}  updated=${fmtDate(f.updated_at)}`);
	}
}

// ── Latest flow steps drill-down ───────────────────────────────────────
const latestFlow = flowRows[0];
if (latestFlow) {
	console.log(`\n▶ latest flow steps  flow=${shortId(latestFlow.id)}`);
	const stepRows = await q(
		`SELECT steps FROM flows WHERE id = $1`,
		[latestFlow.id],
	);
	const steps = stepRows[0]?.steps ?? [];
	if (!Array.isArray(steps) || steps.length === 0) {
		console.log('  (no steps)');
	} else {
		console.log(`  total=${steps.length}`);
		const sample = steps.slice(0, 6);
		for (let i = 0; i < sample.length; i++) {
			const s = sample[i];
			const intent = trunc(s.intent ?? '', 60);
			const expected = trunc(s.expectedOutcome ?? '', 60);
			const sel = s.selectors ?? {};
			const selBits = [];
			if (sel.testid) selBits.push('testid');
			if (sel.css) selBits.push('css');
			if (sel.xpath) selBits.push('xpath');
			if (sel.role) selBits.push('role');
			const sensitive =
				typeof s.isSensitive === 'boolean'
					? s.isSensitive
						? 'SENS'
						: '·'
					: 'unset';
			console.log(
				`  [${i}] ${(s.kind ?? '?').padEnd(10)} target=${trunc(s.target ?? '∅', 30).padEnd(31)} ` +
					`sel=[${selBits.join(',') || '∅'}]  ${sensitive}`,
			);
			console.log(`       intent="${intent}"`);
			console.log(`       expected="${expected}"`);
		}
		if (steps.length > sample.length) {
			console.log(`  … ${steps.length - sample.length} more`);
		}
		// Aggregate diagnostics: how many steps actually got narrated?
		let withIntent = 0,
			withExpected = 0,
			withTestid = 0,
			withCss = 0,
			withXpath = 0,
			withSensitive = 0;
		for (const s of steps) {
			if (s.intent && String(s.intent).trim().length > 0) withIntent++;
			if (s.expectedOutcome && String(s.expectedOutcome).trim().length > 0) withExpected++;
			const sel = s.selectors ?? {};
			if (sel.testid) withTestid++;
			if (sel.css) withCss++;
			if (sel.xpath) withXpath++;
			if (s.isSensitive === true) withSensitive++;
		}
		console.log(
			`  populated: intent=${withIntent}/${steps.length}  ` +
				`expected=${withExpected}/${steps.length}  ` +
				`testid=${withTestid}  css=${withCss}  xpath=${withXpath}  ` +
				`sensitive=${withSensitive}`,
		);
	}
}

// ── Cookie snapshots ───────────────────────────────────────────────────
console.log('\n▶ cookie_snapshots (last 5)');
const snaps = await q(`
	SELECT
		id, site_id, captured_at, origin,
		LENGTH(ciphertext) AS ciphertext_len,
		LENGTH(nonce) AS nonce_len,
		jsonb_array_length(cookie_domains) AS domain_count,
		has_auth_cookie, expires_at_hint,
		state_snapshot_version,
		state_snapshot_meta
	FROM cookie_snapshots
	ORDER BY captured_at DESC
	LIMIT 5
`);
if (!snaps.length) {
	console.log('  (no rows)');
} else {
	for (const s of snaps) {
		console.log(
			`  ${shortId(s.id)} site=${shortId(s.site_id)}  captured=${fmtDate(s.captured_at)}  ` +
				`origin=${trunc(s.origin, 40)}  ct=${s.ciphertext_len}B  nonce=${s.nonce_len}B  ` +
				`domains=${s.domain_count}  auth=${s.has_auth_cookie ? '✓' : '∅'}  ` +
				`v${s.state_snapshot_version}`,
		);
	}
}

// ── Latest recording → flow consistency ────────────────────────────────
if (latestRec) {
	console.log('\n▶ latest recording cross-check');
	const latestFlowForRec = await q(
		`SELECT id, status, jsonb_array_length(steps) AS step_count, cookie_snapshot_id, updated_at
		 FROM flows WHERE id = $1`,
		[latestRec.flow_id],
	);
	const lf = latestFlowForRec[0];
	console.log(`  recording: ${shortId(latestRec.id)}`);
	console.log(`    started=${fmtDate(latestRec.started_at)}`);
	console.log(`    finished=${fmtDate(latestRec.finished_at)}`);
	console.log(
		`    chunks=${latestRec.chunk_count}  stream_blob=${latestRec.action_stream_blob_key ? '✓' : '∅'}`,
	);
	if (lf) {
		console.log(`  flow:      ${shortId(lf.id)}`);
		console.log(`    status=${lf.status}  steps=${lf.step_count}  cookie_snap=${lf.cookie_snapshot_id ? '✓' : '∅'}`);
		console.log(`    updated=${fmtDate(lf.updated_at)}`);
	} else {
		console.log('  flow row missing!');
	}
}

// ── Runs / batches ─────────────────────────────────────────────────────
console.log('\n▶ runs (last 5)');
const runs = await q(`
	SELECT id, flow_id, status, triggered_by, batch_id,
	       started_at, finished_at, duration_ms, error_class
	FROM runs ORDER BY created_at DESC LIMIT 5
`);
if (!runs.length) {
	console.log('  (no rows)');
} else {
	for (const r of runs) {
		console.log(
			`  ${shortId(r.id)} flow=${shortId(r.flow_id)}  ${r.status.padEnd(10)} ` +
				`trig=${r.triggered_by}  batch=${r.batch_id ? shortId(r.batch_id) : '∅'}  ` +
				`started=${fmtDate(r.started_at)}  finished=${fmtDate(r.finished_at)}  ` +
				`err=${r.error_class ?? '∅'}`,
		);
	}
}

console.log('\n▶ run_batches (last 5)');
const batches = await q(`
	SELECT id, flow_id, status, triggered_by,
	       jsonb_array_length(variant_ids) AS variant_count,
	       parallelism, started_at, finished_at, cost_usd_micro
	FROM run_batches ORDER BY created_at DESC LIMIT 5
`);
if (!batches.length) {
	console.log('  (no rows)');
} else {
	for (const b of batches) {
		console.log(
			`  ${shortId(b.id)} flow=${shortId(b.flow_id)}  ${b.status.padEnd(10)} ` +
				`variants=${b.variant_count}  par=${b.parallelism}  ` +
				`started=${fmtDate(b.started_at)}  finished=${fmtDate(b.finished_at)}  ` +
				`cost=${b.cost_usd_micro ?? '∅'}`,
		);
	}
}

console.log('\n═══════════════════════════════════════════════════════════════');
await pool.end();
