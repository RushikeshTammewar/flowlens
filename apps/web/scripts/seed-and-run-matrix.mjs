#!/usr/bin/env node
/**
 * Demo orchestrator: seed a Wikipedia search flow with a populated, encrypted
 * cookie snapshot, generate a Test Matrix via o3, and kick off a parallel batch
 * run that exercises the full pipeline:
 *
 *   1. /api/flows/:id/test-matrix     → o3 generates 5 variants
 *   2. /api/flows/:id/runs/batch      → fan out 5 BU Cloud sessions in parallel,
 *                                       each gets the cookies injected via CDP
 *   3. /api/batches/:id (poll)        → watch progress, dump final summary
 *
 * Why Wikipedia:
 *   The Gmail recording in the DB has an empty cookies array (proven by direct
 *   decrypt: `{"cookies":[],"storage":...}`). Re-recording requires the user.
 *   Wikipedia is open + non-hostile to BU Cloud, so the matrix can actually
 *   reach `step_finished` events and prove the WHOLE pipeline works.
 *
 * The cookie snapshot we seed is synthetic but real-shape (`WMF-Last-Access`,
 * `GeoIP`, `enwikiSession`) so the CDP `Storage.setCookies` injection has
 * actual data to push into BU Cloud and the worker logs `cookies.injected`
 * with a non-zero count.
 *
 * Env: reads `apps/web/.env.local` directly. No Clerk required — uses the
 * demo bearer.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadEnv(path) {
	const text = readFileSync(path, 'utf8');
	const env = {};
	for (const raw of text.split('\n')) {
		const line = raw.trim();
		if (!line || line.startsWith('#') || !line.includes('=')) continue;
		const idx = line.indexOf('=');
		env[line.slice(0, idx)] = line.slice(idx + 1);
	}
	return env;
}

const ENV = loadEnv(join(__dirname, '..', '.env.local'));
const WEB = process.env.WEB_BASE_URL ?? 'http://127.0.0.1:3000';
const BEARER = `flowlens-demo-${ENV.FLOWLENS_DEMO_BEARER}`;

const T0 = Date.now();
const log = (stage, data = {}) => {
	const t = ((Date.now() - T0) / 1000).toFixed(1);
	const dataStr = typeof data === 'string' ? data : JSON.stringify(data).slice(0, 400);
	console.log(`[+${t}s] [SEED] ${stage}`, dataStr);
};

async function http(path, init = {}) {
	const headers = {
		Authorization: `Bearer ${BEARER}`,
		'Content-Type': 'application/json',
		...(init.headers ?? {}),
	};
	const res = await fetch(`${WEB}${path}`, { ...init, headers });
	const text = await res.text();
	let body;
	try {
		body = JSON.parse(text);
	} catch {
		body = text;
	}
	if (!res.ok) {
		throw new Error(`HTTP ${res.status} ${path}: ${typeof body === 'string' ? body : JSON.stringify(body).slice(0, 400)}`);
	}
	return body;
}

// ─── 1. Seed flow + cookie snapshot directly in the DB ─────────────────────────
async function seedFlow(pool) {
	// Pick the demo org + user (already provisioned).
	const u = await pool.query(`
		SELECT u.id user_id, o.id org_id
		FROM users u JOIN orgs o ON o.id = u.default_org_id
		WHERE u.clerk_user_id = 'demo:flowlens-public'
		LIMIT 1
	`);
	if (!u.rows.length) throw new Error('demo user not provisioned — open the extension once');
	const { user_id, org_id } = u.rows[0];
	log('seed.principals', { user_id, org_id });

	// Upsert site.
	const SITE_ORIGIN = 'https://en.wikipedia.org';
	let s = await pool.query(`SELECT id FROM sites WHERE org_id=$1 AND origin=$2`, [org_id, SITE_ORIGIN]);
	let site_id;
	if (s.rows.length) {
		site_id = s.rows[0].id;
	} else {
		const r = await pool.query(
			`INSERT INTO sites (org_id, origin, display_name) VALUES ($1, $2, 'Wikipedia') RETURNING id`,
			[org_id, SITE_ORIGIN],
		);
		site_id = r.rows[0].id;
	}
	log('seed.site', { site_id, origin: SITE_ORIGIN });

	// Build a populated cookie payload, encrypt with the org's vault key,
	// and persist as a snapshot. The cookies are SYNTHETIC but real-shape;
	// they prove the CDP injection works because the worker can read them
	// back via `Storage.getCookies` after injection.
	const NOW_S = Math.floor(Date.now() / 1000);
	const FUTURE_S = NOW_S + 60 * 60 * 24 * 30;
	const cookies = [
		{ domain: '.wikipedia.org', name: 'WMF-Last-Access', value: '01-Jan-2026', path: '/', expires: FUTURE_S, sameSite: 'Lax', httpOnly: true, secure: true },
		{ domain: '.wikipedia.org', name: 'GeoIP', value: 'US:CA:San_Francisco:37.77:-122.41:v4', path: '/', expires: FUTURE_S, sameSite: 'None', httpOnly: false, secure: true },
		{ domain: '.wikipedia.org', name: 'NetworkProbeLimit', value: '0.001', path: '/', expires: FUTURE_S, sameSite: 'Lax', httpOnly: false, secure: true },
		{ domain: 'en.wikipedia.org', name: 'enwikiel-session', value: 'flowlens-demo-' + Math.random().toString(36).slice(2, 14), path: '/', expires: null, sameSite: 'Lax', httpOnly: true, secure: true },
		{ domain: 'en.wikipedia.org', name: 'enwikiUserID', value: '99999999', path: '/', expires: FUTURE_S, sameSite: 'Lax', httpOnly: true, secure: true },
		{ domain: 'en.wikipedia.org', name: 'WMF-DPR', value: '2', path: '/', expires: FUTURE_S, sameSite: 'Lax', httpOnly: false, secure: true },
	];
	const storage = {
		localStorage: {
			'mw-prefs': '{"cookieconsent":"yes","skin":"vector-2022"}',
			'flowlens-marker': 'planted-by-seed-' + Date.now(),
		},
		sessionStorage: { 'mw-test-session': 'true' },
	};
	const payload = JSON.stringify({ cookies, storage });

	const vault = await import('@flowlens/cookies-vault');
	const sealed = await vault.sealForOrg({
		orgId: org_id,
		vaultSecret: ENV.FLOWLENS_VAULT_SECRET,
		plaintext: payload,
	});
	const domains = Array.from(new Set(cookies.map((c) => c.domain)));
	const earliestExp = cookies.reduce((acc, c) => (c.expires && (acc === null || c.expires * 1000 < acc) ? c.expires * 1000 : acc), null);

	// Mark prior snapshots for this site as superseded so the flow uses the new one.
	await pool.query(`UPDATE cookie_snapshots SET superseded_at = now() WHERE site_id = $1 AND superseded_at IS NULL`, [site_id]);

	const snapRes = await pool.query(
		`INSERT INTO cookie_snapshots
		 (org_id, site_id, captured_by_user_id, origin, ciphertext, nonce, cookie_domains, has_auth_cookie, expires_at_hint)
		 VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9) RETURNING id`,
		[org_id, site_id, user_id, SITE_ORIGIN, sealed.ciphertext, sealed.nonce, JSON.stringify(domains), true, earliestExp ? new Date(earliestExp) : null],
	);
	const snapshot_id = snapRes.rows[0].id;
	log('seed.snapshot', { snapshot_id, ciphertext_len: sealed.ciphertext.length, cookie_count: cookies.length });

	// Build the flow. Steps are designed to be robust + non-trivial:
	//   0. navigate to https://en.wikipedia.org/wiki/Main_Page
	//   1. click the Search input ([name="search"])
	//   2. input a query
	//   3. press Enter (keypress)
	//   4. assert: results page contains query (judge will validate)
	const flowName = 'Wikipedia search · happy path';
	const description = 'Search for an article on en.wikipedia.org and verify the search results page loads.';
	const steps = [
		{
			index: 0,
			action: 'navigate',
			intent: 'Open the Wikipedia main page',
			expectedOutcome: 'The Main Page renders with a search box visible.',
			isCritical: true,
			selectors: { css: 'body', accessibleName: 'Main Page' },
			recordedValue: '',
			isSensitive: false,
			recordedScreenshotKey: '',
			url: 'https://en.wikipedia.org/wiki/Main_Page',
		},
		{
			index: 1,
			action: 'click',
			intent: 'Focus the search input',
			expectedOutcome: 'The search input is focused.',
			isCritical: false,
			selectors: { css: 'input[name="search"]', testid: 'searchInput', role: 'searchbox', accessibleName: 'Search Wikipedia' },
			recordedValue: '',
			isSensitive: false,
			recordedScreenshotKey: '',
		},
		{
			index: 2,
			action: 'input',
			intent: 'Type the search query into the search box',
			expectedOutcome: 'The query appears in the search box and an autocomplete list shows matching articles.',
			isCritical: true,
			selectors: { css: 'input[name="search"]', testid: 'searchInput', role: 'searchbox', accessibleName: 'Search Wikipedia' },
			recordedValue: 'Browser Use',
			isSensitive: false,
			recordedScreenshotKey: '',
		},
		{
			index: 3,
			action: 'keypress',
			intent: 'Press Enter to submit the search',
			expectedOutcome: 'Browser navigates to /wiki/Special:Search?search=… or the article page.',
			isCritical: true,
			selectors: { css: 'input[name="search"]', testid: 'searchInput' },
			recordedValue: 'Enter',
			isSensitive: false,
			recordedScreenshotKey: '',
		},
	];

	const flowRes = await pool.query(
		`INSERT INTO flows (org_id, site_id, created_by_user_id, name, description, source, preconditions, steps, cookie_snapshot_id, status)
		 VALUES ($1, $2, $3, $4, $5, 'manual', $6::jsonb, $7::jsonb, $8, 'ready')
		 RETURNING id`,
		[
			org_id,
			site_id,
			user_id,
			flowName,
			description,
			JSON.stringify(['User has Chrome/Chromium with the listed Wikipedia cookies set']),
			JSON.stringify(steps),
			snapshot_id,
		],
	);
	const flow_id = flowRes.rows[0].id;
	log('seed.flow', { flow_id, name: flowName, step_count: steps.length });

	return { org_id, user_id, site_id, snapshot_id, flow_id };
}

// ─── 2. Generate matrix + run batch via HTTP ───────────────────────────────────
async function runMatrix(flow_id) {
	log('matrix.gen.start', { flow_id });
	const matrix = await http(`/api/flows/${flow_id}/test-matrix`, {
		method: 'POST',
		body: JSON.stringify({ count: 5, regenerate: true }),
	});
	log('matrix.gen.ok', {
		model: matrix.model,
		usage: matrix.usage,
		variants: matrix.variants.map((v) => ({
			id: v.id.slice(0, 8),
			family: v.family,
			name: v.name,
			fragility: v.fragility,
			overrides: Object.keys(v.fieldOverrides ?? {}),
		})),
	});

	log('batch.create.start', { flow_id });
	const batch = await http(`/api/flows/${flow_id}/runs/batch`, {
		method: 'POST',
		body: JSON.stringify({ parallelism: 5 }),
	});
	log('batch.create.ok', batch);

	return { matrixModel: matrix.model, variants: matrix.variants, batchId: batch.batchId };
}

// ─── 3. Poll batch until done ──────────────────────────────────────────────────
async function pollBatch(batchId, deadlineMs = 10 * 60_000) {
	const start = Date.now();
	let lastStatusKey = '';
	for (;;) {
		const elapsed = Date.now() - start;
		if (elapsed > deadlineMs) {
			log('batch.poll.timeout', { elapsedMs: elapsed });
			return null;
		}
		const body = await http(`/api/batches/${batchId}`, { method: 'GET' });
		const counts = body.counts ?? {};
		const stepCounts = (body.variants ?? []).map((v) => (v.stepResults ?? []).length);
		const stepCountsTotal = stepCounts.reduce((a, b) => a + b, 0);
		const key = `${body.batch?.status}|${JSON.stringify(counts)}|${stepCountsTotal}`;
		if (key !== lastStatusKey) {
			lastStatusKey = key;
			log('batch.poll', {
				batchStatus: body.batch?.status,
				counts,
				stepFinishedPerVariant: stepCounts,
				stepFinishedTotal: stepCountsTotal,
			});
		}
		if (body.batch?.status === 'completed' || body.batch?.status === 'errored') return body;
		await new Promise((r) => setTimeout(r, 5_000));
	}
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
	console.log('[SEED] starting · web=', WEB);
	const { Pool } = await import('pg');
	const pool = new Pool({ connectionString: ENV.DATABASE_URL_UNPOOLED ?? ENV.DATABASE_URL });
	let seeded;
	try {
		seeded = await seedFlow(pool);
	} finally {
		await pool.end();
	}

	const { matrixModel, variants, batchId } = await runMatrix(seeded.flow_id);

	const final = await pollBatch(batchId);

	console.log('\n========== FINAL ==========');
	console.log('flow_id:', seeded.flow_id);
	console.log('snapshot_id:', seeded.snapshot_id);
	console.log('batch_id:', batchId);
	console.log('matrix_model:', matrixModel);
	console.log('variant_summary:', variants.map((v) => `${v.family}·${v.name}`).join(' | '));
	if (!final) {
		console.log('VERDICT: ❌ batch did not finish in time');
		process.exit(2);
	}
	const counts = final.counts ?? {};
	console.log('counts:', counts);
	console.log('cluster_summary:', final.batch?.aiClusterSummary);
	console.log('per_variant:');
	const variantViews = final.variants ?? [];
	for (const v of variantViews) {
		const stepCount = (v.stepResults ?? []).length;
		const stepStatuses = (v.stepResults ?? []).map((s) => `${s.stepIndex}:${s.status}`).join(',');
		console.log(
			`  · ${v.variant.family.padEnd(11)} ${v.variant.name.slice(0, 50).padEnd(50)} status=${v.run?.status ?? '<no run>'} health=${v.run?.healthScore ?? '-'} steps=${stepCount} [${stepStatuses}]`,
		);
	}
	const stepFinishedTotal = variantViews.reduce((acc, v) => acc + (v.stepResults ?? []).length, 0);
	console.log('total_step_finished_events:', stepFinishedTotal);
	const variantsThatExecutedSteps = variantViews.filter((v) => (v.stepResults ?? []).length > 0).length;
	console.log(
		`VERDICT: ${variantsThatExecutedSteps >= 3 ? '✅' : '❌'} ${variantsThatExecutedSteps}/${variantViews.length} variants executed real steps on a session`,
	);
}

main().catch((err) => {
	console.error('\n❌ SEED FAILED:', err.message);
	console.error(err.stack);
	process.exit(1);
});
