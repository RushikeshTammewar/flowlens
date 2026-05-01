#!/usr/bin/env node
/**
 * Real end-to-end demo run against the local stack.
 *
 * 1. Pull a `ready` flow from the DB
 * 2. Decrypt its cookie snapshot
 * 3. Generate N test variants via Foundry gpt-5.4 (matrixGenerator)
 * 4. For each variant: spin up a BU Cloud browser, then call sidecar /run with cdpUrl
 * 5. Stream live progress; print summary at end
 *
 * Run:
 *   cd apps/web && npx tsx scripts/demo-e2e.mjs 'flow name' 4
 */
import { readFileSync } from 'node:fs';
import { Pool } from 'pg';
import { generateTestMatrix } from '@flowlens/flow-doc';
import { openForOrg } from '@flowlens/cookies-vault';
import { BuCloudClient } from '@flowlens/bu-cloud-client';

// ─── load env ───────────────────────────────────────────────────────────────
const env = {};
for (const line of readFileSync(new URL('../.env.local', import.meta.url), 'utf8').split('\n')) {
	const t = line.trim();
	if (!t || t.startsWith('#') || !t.includes('=')) continue;
	const i = t.indexOf('=');
	env[t.slice(0, i)] = t.slice(i + 1).replace(/^["']|["']$/g, '');
}
for (const [k, v] of Object.entries(env)) {
	if (!process.env[k]) process.env[k] = v;
}

const SIDECAR = 'http://127.0.0.1:8000';
const SIDECAR_BEARER = env.REPLAY_WORKER_SHARED_SECRET;
const FLOW_NAME = process.argv[2] ?? 'Wikipedia search · happy path';
const VARIANT_COUNT = Number(process.argv[3] ?? '4');

const T0 = Date.now();
const log = (stage, data = {}) => {
	const t = ((Date.now() - T0) / 1000).toFixed(1);
	const s = typeof data === 'string' ? data : JSON.stringify(data).slice(0, 320);
	console.log(`[+${t}s] ${stage} ${s}`);
};

// ─── 1. pick flow ───────────────────────────────────────────────────────────
const pool = new Pool({ connectionString: env.DATABASE_URL });
const fr = await pool.query(
	`SELECT f.id, f.name, f.description, f.preconditions, f.status, f.org_id, f.steps,
	        s.origin AS site_origin,
	        cs.ciphertext AS cookie_ct, cs.nonce AS cookie_nonce
	 FROM flows f JOIN sites s ON s.id = f.site_id
	 LEFT JOIN cookie_snapshots cs ON cs.id = f.cookie_snapshot_id
	 WHERE f.status = 'ready' AND f.name = $1
	 ORDER BY f.created_at DESC LIMIT 1`,
	[FLOW_NAME],
);
if (!fr.rows.length) {
	console.error(`flow not found: ${FLOW_NAME}`);
	process.exit(1);
}
const flow = fr.rows[0];
log('flow.picked', {
	id: flow.id,
	name: flow.name,
	stepCount: flow.steps.length,
	site: flow.site_origin,
	hasCookies: !!flow.cookie_ct,
});

// ─── 2. decrypt cookies ─────────────────────────────────────────────────────
let cookies = [];
if (flow.cookie_ct) {
	try {
		const plaintext = await openForOrg({
			orgId: flow.org_id,
			vaultSecret: env.FLOWLENS_VAULT_SECRET,
			sealed: { ciphertext: flow.cookie_ct, nonce: flow.cookie_nonce },
		});
		const parsed = JSON.parse(plaintext);
		cookies = parsed.cookies ?? parsed ?? [];
		log('cookies.decrypted', {
			count: cookies.length,
			sample: cookies.slice(0, 3).map((c) => `${c.name}@${c.domain}`),
		});
	} catch (err) {
		log('cookies.failed', { error: String(err).slice(0, 200) });
	}
}

// ─── 3. generate matrix via Foundry gpt-5.4 ────────────────────────────────
log('matrix.start', { count: VARIANT_COUNT, model: 'gpt-5.4 via Foundry' });
const flowDoc = {
	id: flow.id,
	name: flow.name,
	description: flow.description ?? flow.name,
	preconditions: flow.preconditions ?? [],
	steps: flow.steps,
};
const matrix = await generateTestMatrix({ flow: flowDoc, count: VARIANT_COUNT });
log('matrix.done', {
	model: matrix.model,
	variantCount: matrix.variants.length,
	usage: matrix.usage,
});
for (const [i, v] of matrix.variants.entries()) {
	log(`  variant[${i}]`, { family: v.family, name: v.name, fragility: v.fragility });
}

// ─── 4. fan out: spawn BU Cloud session + drive sidecar /run ───────────────
const bu = new BuCloudClient({ apiKey: env.BROWSER_USE_API_KEY });

function applyOverrides(steps, overrides) {
	if (!overrides || !overrides.length) return steps;
	const map = new Map(overrides.map((o) => [o.stepIndex, o.value]));
	return steps.map((s) => (map.has(s.index) ? { ...s, recordedValue: map.get(s.index) } : s));
}

async function runOne(variant, idx) {
	const runId = crypto.randomUUID();
	let sessionId = null;
	const t0 = Date.now();
	log(`run[${idx}].start`, { variant: variant.name, runId });

	try {
		const session = await bu.createBrowserSession({ proxyCountryCode: 'us', timeout: 600 });
		sessionId = session.id;
		log(`run[${idx}].session_created`, { sessionId, hasCdp: !!session.cdpUrl });
		if (!session.cdpUrl) throw new Error('BU Cloud returned no cdpUrl');

		const body = {
			runId,
			flow: {
				id: flow.id,
				name: flow.name,
				siteOrigin: flow.site_origin,
				steps: applyOverrides(flow.steps, variant.fieldOverrides),
			},
			cdpUrl: session.cdpUrl,
			liveUrl: session.liveUrl,
			cookies,
			landingUrl: flow.site_origin,
		};

		const resp = await fetch(`${SIDECAR}/run`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${SIDECAR_BEARER}` },
			body: JSON.stringify(body),
		});
		const text = await resp.text();
		let json;
		try {
			json = JSON.parse(text);
		} catch {
			json = { raw: text };
		}
		const ms = Date.now() - t0;
		log(`run[${idx}].done`, {
			http: resp.status,
			runStatus: json.status,
			stepsExecuted: json.stepsExecuted,
			stepsFinishedOk: json.stepsFinishedOk,
			ms,
		});
		return { idx, variant, json, ms, http: resp.status };
	} catch (err) {
		log(`run[${idx}].error`, { error: String(err).slice(0, 250) });
		return { idx, variant, ok: false, error: String(err) };
	} finally {
		if (sessionId) {
			try {
				await bu.stopBrowserSession(sessionId);
				log(`run[${idx}].session_stopped`, { sessionId });
			} catch (err) {
				log(`run[${idx}].session_stop_failed`, { error: String(err).slice(0, 150) });
			}
		}
	}
}

log('parallel.run.start', { variants: matrix.variants.length });
const results = await Promise.all(matrix.variants.map((v, i) => runOne(v, i)));

// ─── 5. summary ─────────────────────────────────────────────────────────────
console.log('\n========== SUMMARY ==========');
console.log(`Flow: ${flow.name}`);
console.log(`Site: ${flow.site_origin}`);
console.log(`Variants: ${results.length}`);
console.log();
for (const r of results) {
	const j = r.json ?? {};
	const v = r.variant ?? {};
	const status = j.status ?? (r.error ? 'ERROR' : 'unknown');
	const tag =
		status === 'passed' ? 'PASS' : status === 'failed' ? 'FAIL' : status === 'errored' ? 'ERR ' : status;
	console.log(`  [${r.idx}] ${tag.toUpperCase().padEnd(5)} (${r.ms}ms) ${v.family}: ${v.name}`);
	console.log(
		`        steps: ${j.stepsFinishedOk ?? '?'}/${j.stepsExecuted ?? '?'}, expected=${v.expectedOutcome?.kind ?? '?'}`,
	);
	if (r.error) console.log(`        error: ${r.error.slice(0, 200)}`);
	if (j.error) console.log(`        run-error: ${String(j.error).slice(0, 200)}`);
}

await pool.end();
