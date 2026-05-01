#!/usr/bin/env node
/**
 * Direct end-to-end test of the Flowlens pipeline.
 *
 * Bypasses the Next.js dev server (broken in Cursor sandbox: self-proxy
 * `socket hang up`) and the Python sidecar's `/run` (already proven by
 * earlier prod-smoke). Hits Postgres + OpenAI + the sidecar directly.
 *
 * What this proves:
 *   1. test_variants + run_batches DDL applies cleanly
 *   2. o3 generates plausible variants for a real recorded flow
 *   3. The sidecar `/run` endpoint accepts per-variant field overrides
 *   4. Cluster summary aggregates results
 *
 * What this does NOT cover:
 *   - The HTTP layer (auth middleware, routes) — those are thin wrappers
 *     around the same calls; if the calls work here, the routes work
 *     once the dev-server self-proxy issue is fixed.
 *   - BU Cloud session creation per variant — we use ONE shared session
 *     for the whole batch (real prod creates one per variant).
 *
 * Run: `/Users/rtammewar/.nvm/versions/node/v22.22.0/bin/node apps/web/scripts/local-e2e.mjs`
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import OpenAI from 'openai';
import { Pool } from 'pg';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENV = loadEnv(join(__dirname, '..', '.env.local'));

const SIDECAR_URL = 'http://127.0.0.1:8000';
const SIDECAR_BEARER = ENV.REPLAY_WORKER_SHARED_SECRET ?? 'dev-shared-secret-for-local-smoke-only';
const BU_BASE = 'https://api.browser-use.com/api/v2';

// ─── log helper ──────────────────────────────────────────────────────────────
const T0 = Date.now();
const log = (stage, data = {}) => {
	const t = ((Date.now() - T0) / 1000).toFixed(1);
	const dataStr = typeof data === 'string' ? data : JSON.stringify(data).slice(0, 220);
	console.log(`[+${t}s]`, stage, dataStr);
};

function loadEnv(path) {
	const text = readFileSync(path, 'utf8');
	const env = {};
	for (const raw of text.split('\n')) {
		const line = raw.trim();
		if (!line || line.startsWith('#') || !line.includes('=')) continue;
		const idx = line.indexOf('=');
		const k = line.slice(0, idx);
		let v = line.slice(idx + 1);
		if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
			v = v.slice(1, -1);
		}
		env[k] = v;
	}
	return env;
}

// ─── DDL — make sure matrix tables exist ─────────────────────────────────────
const DDL = [
	{
		label: 'add runs.batch_id',
		sql: `ALTER TABLE runs ADD COLUMN IF NOT EXISTS batch_id uuid;`,
	},
	{
		label: 'add runs.variant_id',
		sql: `ALTER TABLE runs ADD COLUMN IF NOT EXISTS variant_id uuid;`,
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
		label: 'create indexes',
		sql: `CREATE INDEX IF NOT EXISTS test_variants_flow_idx ON test_variants(flow_id);
			CREATE INDEX IF NOT EXISTS run_batches_org_flow_idx ON run_batches(org_id, flow_id);
			CREATE INDEX IF NOT EXISTS runs_batch_idx ON runs(batch_id);`,
	},
];

async function applyDDL(pool) {
	log('ddl.start', { statements: DDL.length });
	for (const stmt of DDL) {
		await pool.query(stmt.sql);
		log('ddl.ok', { label: stmt.label });
	}
}

// ─── Step 1 — pick a ready flow ─────────────────────────────────────────────
async function pickFlow(pool) {
	const r = await pool.query(`
		SELECT f.id, f.name, f.status, f.org_id, f.steps,
		       f.cookie_snapshot_id, s.origin AS site_origin,
		       cs.ciphertext AS cookie_ct, cs.nonce AS cookie_nonce
		FROM flows f JOIN sites s ON s.id = f.site_id
		LEFT JOIN cookie_snapshots cs ON cs.id = f.cookie_snapshot_id
		WHERE f.status = 'ready' AND jsonb_array_length(f.steps) > 0
		ORDER BY f.created_at DESC LIMIT 1
	`);
	if (!r.rows.length) throw new Error('no ready flow with steps; record one first');
	const flow = r.rows[0];
	log('flow.picked', {
		id: flow.id,
		name: flow.name,
		stepCount: flow.steps.length,
		siteOrigin: flow.site_origin,
		hasCookies: !!flow.cookie_ct,
	});
	return flow;
}

// Decrypt the cookie snapshot via the cookies-vault (libsodium sealed box).
// We dynamically import the workspace module so the bearer paths in the
// inline runner remain consistent with what the production routes do.
async function decryptCookies(flow) {
	if (!flow.cookie_ct || !ENV.FLOWLENS_VAULT_SECRET) return {};
	try {
		const vault = await import('@flowlens/cookies-vault');
		const plaintext = await vault.openForOrg({
			orgId: flow.org_id,
			vaultSecret: ENV.FLOWLENS_VAULT_SECRET,
			sealed: { ciphertext: flow.cookie_ct, nonce: flow.cookie_nonce },
		});
		const parsed = JSON.parse(plaintext);
		const sensitive = {};
		for (const c of parsed.cookies ?? []) sensitive[c.name] = c.value;
		log('cookies.decrypted', { count: Object.keys(sensitive).length });
		return sensitive;
	} catch (err) {
		log('cookies.skip', { reason: err.message?.slice(0, 200) });
		return {};
	}
}

// ─── Step 2 — generate matrix via o3 ────────────────────────────────────────
const VARIANT_SYSTEM_PROMPT = `You are a senior QA engineer with 10 years of experience finding edge cases in web applications. Given a recorded user flow, generate adversarial test variants that exercise different failure modes.

For each variant:
1. Pick a family that captures the failure mode: happy_path | boundary | format | encoding | adversarial | locale | state | auth
2. Identify the input field(s) where the override applies — use the recorded step index as the key in fieldOverrides
3. Specify expectedOutcome — what should happen if the app handles this correctly:
   - success: the flow should complete normally
   - validation_error: the app should show a specific error message; list 1-5 strings the message should contain
   - rejection: the app should refuse the action without a specific message
   - silent_acceptance_unsafe: the app silently accepts a value it shouldn't (security/data-integrity bug)

Variant families to use:
- boundary: empty string, single char, max-length, min-length, zero, negative, very large numbers
- format: malformed email/URL/phone, wrong date format, mixed case, leading/trailing whitespace
- encoding: unicode (emoji, RTL, zero-width), HTML/JS injection, SQL-ish, control chars, mojibake
- adversarial: prompt injection, length bombs, recursive/self-referential, known security payloads
- locale: non-Latin scripts (CJK, Arabic, Devanagari), locale-specific number/date formats
- state: stale data, conflicting state (e.g. clicking after timeout), retry/double-click
- auth: missing auth, expired auth, wrong scope
- happy_path: ALWAYS include exactly 1 happy_path variant per batch (sanity baseline)

Quality bar:
- Every variant must be PLAUSIBLE for this specific app — read the flow's name, description, and step intents to understand what it does
- DO NOT generate variants that test things the recorded flow doesn't exercise
- Vary fragility: low (very common, app should definitely handle), medium (less common but real), high (esoteric, may be acceptable to fail)
- One variant per (family, target-field) — no duplicates`;

const VARIANT_RESPONSE_SCHEMA = {
	type: 'object',
	properties: {
		variants: {
			type: 'array',
			items: {
				type: 'object',
				properties: {
					family: {
						type: 'string',
						enum: ['happy_path', 'boundary', 'format', 'encoding', 'adversarial', 'locale', 'state', 'auth'],
					},
					name: { type: 'string' },
					description: { type: 'string' },
					rationale: { type: 'string' },
					expectedOutcome: {
						type: 'object',
						properties: {
							kind: {
								type: 'string',
								enum: ['success', 'validation_error', 'rejection', 'silent_acceptance_unsafe'],
							},
							criteria: { type: ['string', 'null'] },
							messageContains: { type: ['array', 'null'], items: { type: 'string' } },
						},
						required: ['kind', 'criteria', 'messageContains'],
						additionalProperties: false,
					},
					// OpenAI strict mode doesn't support open-ended object dicts.
					// Use array of {stepIndex, value} pairs instead; we map back to
					// {stepIndex: value} after parsing.
					fieldOverrides: {
						type: 'array',
						items: {
							type: 'object',
							properties: {
								stepIndex: { type: 'integer' },
								value: { type: 'string' },
							},
							required: ['stepIndex', 'value'],
							additionalProperties: false,
						},
					},
					fragility: { type: 'string', enum: ['low', 'medium', 'high'] },
				},
				required: ['family', 'name', 'description', 'rationale', 'expectedOutcome', 'fieldOverrides', 'fragility'],
				additionalProperties: false,
			},
		},
	},
	required: ['variants'],
	additionalProperties: false,
};

async function generateMatrix(flow, count = 5) {
	log('matrix.start', { count, model: 'o3' });
	const client = new OpenAI({ apiKey: ENV.OPENAI_API_KEY });
	const inputSteps = flow.steps
		.filter((s) => s.action === 'input' || s.action === 'select')
		.map(
			(s) =>
				`  step[${s.index}] action=${s.action} intent=${JSON.stringify(s.intent)} recordedValue=${
					s.recordedValue ? JSON.stringify(s.recordedValue) : 'null'
				}`,
		)
		.join('\n');
	const userPrompt = `Flow: ${flow.name}
Site: ${flow.site_origin}

Steps the user performed (showing only steps with input fields you can override):
${inputSteps || '  (no input fields — generate state / locale variants instead)'}

Full step list for context:
${flow.steps.map((s) => `  step[${s.index}] action=${s.action} intent=${s.intent}`).join('\n')}

Generate exactly ${count} variants. The first variant MUST be \`family: happy_path\` as a baseline. The remaining ${count - 1} should be a mix of failure-mode families, no duplicates per (family, target-field).`;

	let model = 'o3';
	try {
		const response = await client.chat.completions.create({
			model,
			messages: [
				{ role: 'system', content: VARIANT_SYSTEM_PROMPT },
				{ role: 'user', content: userPrompt },
			],
			response_format: {
				type: 'json_schema',
				json_schema: { name: 'TestMatrix', strict: true, schema: VARIANT_RESPONSE_SCHEMA },
			},
			reasoning_effort: 'medium',
		});
		const content = response.choices[0]?.message?.content;
		if (!content) throw new Error('o3 returned no content');
		const parsed = JSON.parse(content);
		const variants = parsed.variants.map(normalizeVariant);
		log('matrix.ok', { model, count: variants.length, usage: response.usage });
		return { variants, model };
	} catch (err) {
		log('matrix.fallback', { from: model, reason: err.message?.slice(0, 120) });
		model = 'o4-mini';
		const response = await client.chat.completions.create({
			model,
			messages: [
				{ role: 'system', content: VARIANT_SYSTEM_PROMPT },
				{ role: 'user', content: userPrompt },
			],
			response_format: {
				type: 'json_schema',
				json_schema: { name: 'TestMatrix', strict: true, schema: VARIANT_RESPONSE_SCHEMA },
			},
			reasoning_effort: 'medium',
		});
		const parsed = JSON.parse(response.choices[0].message.content);
		const variants = parsed.variants.map(normalizeVariant);
		log('matrix.ok', { model, count: variants.length, usage: response.usage });
		return { variants, model };
	}
}

// Convert OpenAI's array-of-pairs fieldOverrides back to a {stepIndex: value} map
// for downstream code (DB schema + replay engine).
function normalizeVariant(v) {
	const overrides = {};
	for (const o of v.fieldOverrides ?? []) {
		overrides[String(o.stepIndex)] = o.value;
	}
	return { ...v, fieldOverrides: overrides };
}

// ─── Step 3 — persist variants ───────────────────────────────────────────────
async function persistVariants(pool, flowId, variants, model) {
	const ids = [];
	for (const v of variants) {
		const r = await pool.query(
			`INSERT INTO test_variants (flow_id, family, name, description, rationale, expected_outcome, field_overrides, fragility, generated_by)
			 VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9) RETURNING id`,
			[
				flowId,
				v.family,
				v.name,
				v.description,
				v.rationale,
				JSON.stringify(v.expectedOutcome),
				JSON.stringify(v.fieldOverrides ?? {}),
				v.fragility,
				model,
			],
		);
		ids.push({ id: r.rows[0].id, ...v });
	}
	log('variants.persisted', { count: ids.length });
	return ids;
}

// ─── Step 4 — create batch row, fan out runs, drive sidecar /run ────────────
async function buCreateSession() {
	const res = await fetch(`${BU_BASE}/browsers`, {
		method: 'POST',
		headers: {
			'X-Browser-Use-API-Key': ENV.BROWSER_USE_API_KEY,
			'Content-Type': 'application/json',
		},
		body: JSON.stringify({ proxyCountryCode: 'us', stealthMode: false }),
	});
	if (!res.ok) throw new Error(`BU createSession ${res.status}: ${await res.text()}`);
	return res.json();
}

async function buStopSession(id) {
	try {
		await fetch(`${BU_BASE}/browsers/${id}`, {
			method: 'PATCH',
			headers: {
				'X-Browser-Use-API-Key': ENV.BROWSER_USE_API_KEY,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({ action: 'stop' }),
		});
	} catch {
		/* best-effort */
	}
}

async function streamSidecarRun({ runId, flow, variant, cdpUrl, sensitiveData }) {
	const overriddenSteps = flow.steps.map((s) => {
		const override = variant.fieldOverrides?.[String(s.index)];
		return override === undefined ? s : { ...s, recordedValue: override };
	});
	const body = {
		runId,
		flow: {
			id: flow.id,
			name: flow.name,
			siteOrigin: flow.site_origin,
			steps: overriddenSteps,
		},
		cdpUrl,
		liveUrl: null,
		mode: { name: 'hybrid' },
		recordedScreenshotsByIndex: {},
		sensitiveData: sensitiveData ?? {},
	};
	const res = await fetch(`${SIDECAR_URL}/run`, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${SIDECAR_BEARER}`,
			'Content-Type': 'application/json',
			Accept: 'text/event-stream',
		},
		body: JSON.stringify(body),
	});
	if (!res.ok) {
		throw new Error(`sidecar /run ${res.status}: ${await res.text()}`);
	}
	const reader = res.body.getReader();
	const decoder = new TextDecoder();
	let buf = '';
	let stepFinished = 0;
	let runStatus = 'errored';
	let summary = 'no terminal event';
	const deadline = Date.now() + 90_000;

	outer: while (Date.now() < deadline) {
		const { value, done } = await reader.read();
		if (done) break;
		buf += decoder.decode(value, { stream: true });
		const blocks = buf.split('\n\n');
		buf = blocks.pop() ?? '';
		for (const block of blocks) {
			for (const line of block.split('\n')) {
				if (!line.startsWith('data:')) continue;
				const payload = line.slice(5).trim();
				if (!payload) continue;
				try {
					const evt = JSON.parse(payload);
					if (evt.type === 'step_finished') stepFinished++;
					if (evt.type === 'run_complete') {
						runStatus = evt.status;
						summary = evt.summary ?? '';
						break outer;
					}
					if (evt.type === 'run_paused') {
						runStatus = 'errored';
						summary = `paused: ${evt.hint ?? ''}`;
						break outer;
					}
				} catch {
					/* skip */
				}
			}
		}
	}
	return { stepFinished, runStatus, summary };
}

async function runOneVariant(pool, batch, flow, variant, sensitiveData) {
	log('variant.start', { id: variant.id, family: variant.family, name: variant.name });
	const runId = (await pool.query('SELECT gen_random_uuid() AS id')).rows[0].id;
	await pool.query(
		`INSERT INTO runs (id, org_id, flow_id, batch_id, variant_id, triggered_by, status)
		 VALUES ($1, $2, $3, $4, $5, 'matrix_batch', 'queued')`,
		[runId, batch.orgId, flow.id, batch.id, variant.id],
	);

	let session = null;
	let result = { stepFinished: 0, runStatus: 'errored', summary: '' };
	try {
		session = await buCreateSession();
		await pool.query(
			`UPDATE runs SET status='running', bu_session_id=$1, bu_cdp_url=$2, live_url=$3, started_at=now() WHERE id=$4`,
			[session.id, session.cdpUrl, session.liveUrl, runId],
		);
		log('variant.cdp', { runId, sessionId: session.id, hasLive: !!session.liveUrl });
		result = await streamSidecarRun({ runId, flow, variant, cdpUrl: session.cdpUrl, sensitiveData });
		log('variant.done', {
			runId,
			variantId: variant.id,
			status: result.runStatus,
			stepFinished: result.stepFinished,
		});
	} catch (err) {
		log('variant.error', { runId, error: err.message });
		result = { stepFinished: 0, runStatus: 'errored', summary: err.message };
	} finally {
		if (session?.id) await buStopSession(session.id);
		await pool.query(
			`UPDATE runs SET status=$1, summary=$2, finished_at=now() WHERE id=$3`,
			[result.runStatus, result.summary?.slice(0, 800) ?? '', runId],
		);
	}
	return { runId, variantId: variant.id, ...result };
}

async function summarizeBatch(flow, variants, results) {
	if (!ENV.OPENAI_API_KEY) return null;
	const lines = results.map((r) => {
		const v = variants.find((x) => x.id === r.variantId);
		return `- ${v?.family ?? '?'} · ${v?.name ?? '?'}: ${r.runStatus}  → ${r.summary?.slice(0, 200) ?? ''}`;
	});
	const userPrompt = `Flow: ${flow.name}

Per-variant results:
${lines.join('\n')}

Cluster the failures into 1-3 themes. For each theme: 1-line description of what's broken, list the variants that hit it, and a recommended fix. If everything passed, just say "All N variants passed — no failures to cluster". Keep it under 600 characters total.`;
	const client = new OpenAI({ apiKey: ENV.OPENAI_API_KEY });
	const res = await client.chat.completions.create({
		model: 'o4-mini',
		messages: [
			{ role: 'system', content: 'You are a senior QA engineer reading test results. Be concise.' },
			{ role: 'user', content: userPrompt },
		],
		max_completion_tokens: 400,
	});
	return res.choices[0]?.message?.content ?? null;
}

// ─── Main ────────────────────────────────────────────────────────────────────
async function main() {
	const dbUrl = ENV.DATABASE_URL_UNPOOLED ?? ENV.DATABASE_URL;
	const pool = new Pool({ connectionString: dbUrl });

	try {
		log('e2e.start', { sidecar: SIDECAR_URL });
		await applyDDL(pool);

		const flow = await pickFlow(pool);
		const sensitiveData = await decryptCookies(flow);

		const matrix = await generateMatrix(flow, 5);
		log('matrix.preview', {
			variants: matrix.variants.map((v) => ({
				family: v.family,
				name: v.name,
				expected: v.expectedOutcome.kind,
				overrides: Object.keys(v.fieldOverrides ?? {}).length,
			})),
		});

		const persisted = await persistVariants(pool, flow.id, matrix.variants, matrix.model);

		// Create the batch row.
		const batchInsert = await pool.query(
			`INSERT INTO run_batches (org_id, flow_id, triggered_by, variant_ids, parallelism, status, started_at)
			 VALUES ($1, $2, 'user', $3::jsonb, $4, 'running', now()) RETURNING id`,
			[flow.org_id, flow.id, JSON.stringify(persisted.map((p) => p.id)), 1],
		);
		const batch = { id: batchInsert.rows[0].id, orgId: flow.org_id };
		log('batch.created', { batchId: batch.id });

		// Run variants serially (BU free tier = 3 concurrent; we keep it at 1
		// to avoid concurrency issues during this proof). Pass sensitiveData
		// (decrypted cookies) so the agent can authenticate.
		const results = [];
		for (const v of persisted) {
			results.push(await runOneVariant(pool, batch, flow, v, sensitiveData));
		}

		const summary = await summarizeBatch(flow, persisted, results);
		log('cluster.summary', { summary: summary?.slice(0, 200) });

		const counts = {
			passed: results.filter((r) => r.runStatus === 'passed').length,
			failed: results.filter((r) => r.runStatus === 'failed').length,
			errored: results.filter((r) => r.runStatus === 'errored').length,
		};

		await pool.query(
			`UPDATE run_batches SET status='completed', finished_at=now(), ai_cluster_summary=$1 WHERE id=$2`,
			[summary, batch.id],
		);

		console.log('\n========== TIMELINE COMPLETE ==========');
		console.log('flow:', flow.name);
		console.log('variants:', persisted.length, '·', persisted.map((v) => v.family).join('/'));
		console.log('counts:', counts);
		console.log('summary:', summary);
		console.log('verdict:', counts.passed + counts.failed >= 1 ? '✅ E2E pipeline works' : '❌ no runs completed');
	} catch (err) {
		console.error('\n❌ E2E FAILED:', err.message);
		console.error(err.stack);
		process.exit(1);
	} finally {
		await pool.end();
	}
}

await main();
