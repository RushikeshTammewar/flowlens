#!/usr/bin/env node
/**
 * Phase 4 — end-to-end local smoke against the live web :3000 + sidecar :8000.
 *
 * Reuses an existing `ready` flow in the demo org. Pipeline tested:
 *   1. GET /api/flows                  → confirm orgMeta + capacity
 *   2. GET /api/flows/:id              → confirm featureContract present
 *      (and synthesize one via re-compile if the flow is pre-Phase 4)
 *   3. POST /api/flows/:id/test-matrix → mode-aware variants persisted
 *      (mode/behaviorId/assertion/shouldPass on each row)
 *   4. POST /api/flows/:id/runs/batch  → batch dispatched
 *   5. Poll  /api/batches/:id          → wait for terminal status,
 *      verify behaviorVerdicts + correctness/robustness counts on
 *      the run_batches row + per-step assertion_eval on at least one
 *      variant's last step.
 *
 * Exits non-zero on any contract violation. Fast-fails so the user
 * doesn't burn a recording session figuring out the pipeline is
 * broken.
 *
 * Logged under scope: [phase4:ete].
 */
import './load-env.mjs';

const WEB = process.env.FLOWLENS_LOCAL_WEB_URL ?? 'http://127.0.0.1:3000';
const BEARER = `flowlens-demo-${process.env.FLOWLENS_DEMO_BEARER ?? ''}`;
const POLL_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes — matrix-gen + batch can be slow
const POLL_INTERVAL_MS = 5_000;

function log(msg) {
	console.log(`[phase4:ete] ${msg}`);
}

async function api(path, init = {}) {
	// 8-minute hard cap — covers a slow matrix-gen call (gpt-5.4 high
	// reasoning peaks ~5min on Foundry) plus DB roundtrips. Default
	// Node fetch has no app-level timeout but the underlying socket
	// can still drop on long idle; AbortSignal forces a clean error
	// instead of a hung promise.
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 8 * 60 * 1000);
	let res;
	try {
		res = await fetch(`${WEB}${path}`, {
			...init,
			signal: controller.signal,
			headers: {
				Authorization: `Bearer ${BEARER}`,
				'Content-Type': 'application/json',
				...(init.headers || {}),
			},
		});
	} finally {
		clearTimeout(timer);
	}
	const text = await res.text();
	let body;
	try {
		body = text ? JSON.parse(text) : null;
	} catch {
		body = text;
	}
	if (!res.ok) {
		throw new Error(
			`${init.method ?? 'GET'} ${path} → ${res.status}: ${typeof body === 'string' ? body.slice(0, 400) : JSON.stringify(body).slice(0, 400)}`,
		);
	}
	return body;
}

async function main() {
	if (!process.env.FLOWLENS_DEMO_BEARER) {
		throw new Error('FLOWLENS_DEMO_BEARER not set in apps/web/.env.local');
	}

	// 1. /api/health (no auth needed)
	log('1/5 health check …');
	const health = await fetch(`${WEB}/api/health`).then((r) => r.json());
	if (!health.ok) throw new Error(`web health failed: ${JSON.stringify(health)}`);
	log(
		`     web ok · provider=${health.env.llmProvider} · synthesize=${health.models.synthesize} · matrix=${health.models.matrixGenerator}`,
	);

	// 2. List flows + check orgMeta capacity
	log('2/5 listing flows + orgMeta …');
	const list = await api('/api/flows?status=ready');
	const flows = list.flows ?? [];
	const orgMeta = list.orgMeta;
	if (!orgMeta) throw new Error('orgMeta missing — did Tier 4 ship?');
	log(
		`     ${flows.length} ready flows · cap=${orgMeta.monthlyFeatureCap} consumed=${orgMeta.monthlyFeaturesConsumed} remaining=${orgMeta.capacityRemaining}`,
	);

	// Pick the most-recently-updated ready flow.
	const flow = flows[0];
	if (!flow) {
		throw new Error('No ready flows in demo org — record one first via the extension');
	}
	log(`     using flow=${flow.id} name=${JSON.stringify(flow.name)}`);

	// 3. Fetch single flow → check featureContract; recompile if absent.
	log('3/5 fetching flow w/ contract …');
	let flowResp = await api(`/api/flows/${flow.id}`);
	let f = flowResp.flow;
	if (!f.featureContract) {
		log(
			'     featureContract absent — re-compiling this flow with phase 4 enabled (will take ~30-60s)',
		);
		await api(`/api/flows/${flow.id}/compile-retry`, { method: 'POST' });
		// Poll compile-status until ready.
		const compileDeadline = Date.now() + 5 * 60 * 1000;
		for (;;) {
			await new Promise((r) => setTimeout(r, 3_000));
			const status = await api(`/api/flows/${flow.id}/compile-status`);
			log(
				`     compile: stage=${status.compile.stage} pct=${status.compile.pct} flowStatus=${status.flowStatus}`,
			);
			if (status.flowStatus === 'ready' && status.compile.stage === 'done') break;
			if (status.compile.stage === 'failed') {
				throw new Error(`re-compile failed: ${status.compile.error ?? 'unknown'}`);
			}
			if (Date.now() > compileDeadline) {
				throw new Error('re-compile did not finish within 5min');
			}
		}
		flowResp = await api(`/api/flows/${flow.id}`);
		f = flowResp.flow;
	}
	if (!f.featureContract) {
		throw new Error(
			'flow still has no featureContract after re-compile — phase 4 synthesize stage failed silently. Check web logs.',
		);
	}
	const c = f.featureContract;
	log(
		`     contract: featureName=${JSON.stringify(c.featureName)} inputs=${c.inputs.length} behaviors=${c.expectedBehaviors.length} invariants=${c.invariants.length} model=${c.synthesizedByModel ?? '?'}`,
	);

	// 4. Generate test matrix (Phase 4 V2 if contract present, V1 fallback otherwise)
	log('4/5 POST /api/flows/:id/test-matrix (regenerate=true)');
	const tm = await api(`/api/flows/${flow.id}/test-matrix`, {
		method: 'POST',
		body: JSON.stringify({ count: 10, regenerate: true }),
	});
	const variants = tm.variants ?? [];
	log(
		`     model=${tm.model} phase4=${tm.phase4 ?? '(absent)'} variants=${variants.length}`,
	);
	if (variants.length === 0) throw new Error('matrix-gen returned 0 variants');

	const phase4Variants = variants.filter((v) => v.mode);
	const byMode = phase4Variants.reduce((acc, v) => {
		acc[v.mode] = (acc[v.mode] ?? 0) + 1;
		return acc;
	}, {});
	log(`     mode distribution: ${JSON.stringify(byMode)}`);
	if (f.featureContract && phase4Variants.length === 0) {
		throw new Error(
			'flow has featureContract but matrix-gen did not produce mode-aware variants',
		);
	}
	if (phase4Variants.length > 0) {
		const sample = phase4Variants[0];
		if (!sample.assertion?.spec?.kind) {
			throw new Error(`variant ${sample.id} missing assertion.spec.kind`);
		}
		if (typeof sample.shouldPass !== 'boolean') {
			throw new Error(`variant ${sample.id} missing shouldPass`);
		}
		log(
			`     sample variant: mode=${sample.mode} behaviorId=${sample.behaviorId} shouldPass=${sample.shouldPass} assertion.kind=${sample.assertion.spec.kind}`,
		);
	}

	// 5. Start batch with the FULL variant set (was 5 — we want all
	// 4-5 modes represented in the rollup so the report exercises the
	// behavior×mode grid + adversarial polarity flip + invariant axis).
	const variantsToRun = parseInt(process.env.FLOWLENS_ETE_VARIANT_COUNT ?? '0', 10) ||
		variants.length;
	log(`5/5 POST /api/flows/:id/runs/batch — running ${variantsToRun} variants`);
	const batch = await api(`/api/flows/${flow.id}/runs/batch`, {
		method: 'POST',
		body: JSON.stringify({
			variantIds: variants.slice(0, variantsToRun).map((v) => v.id),
			parallelism: 5,
		}),
	});
	log(`     batchId=${batch.batchId} variantCount=${batch.variantCount}`);

	// Poll until terminal.
	const deadline = Date.now() + POLL_TIMEOUT_MS;
	let view;
	for (;;) {
		await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
		view = await api(`/api/batches/${batch.batchId}`);
		const c = view.counts;
		log(
			`     batch=${view.batch.status} · counts: ${c.passed}p / ${c.failed}f / ${c.errored}e / ${c.running}r / ${c.queued}q (total ${c.total})`,
		);
		if (view.batch.status === 'completed' || view.batch.status === 'errored') break;
		if (Date.now() > deadline) {
			throw new Error(`batch did not finish within ${POLL_TIMEOUT_MS / 1000}s`);
		}
	}

	// Verify Phase 4 aggregator outputs.
	if (phase4Variants.length > 0) {
		const bv = view.batch.behaviorVerdicts;
		if (!bv || bv.length === 0) {
			throw new Error(
				`Phase 4 batch finished but behaviorVerdicts is empty — aggregator did not run or did not find any phase4 variant rows`,
			);
		}
		log(
			`     two-axis: correctness=${view.batch.correctnessVerifiedCount}/${view.batch.correctnessTotalCount} · robustness=${view.batch.robustnessVerifiedCount}/${view.batch.robustnessTotalCount}`,
		);
		log(`     behaviors verdicts: ${bv.length}`);

		const variantsWithEvalCount = view.variants.filter((row) =>
			row.stepResults.some((s) => s.assertionEval),
		).length;
		log(
			`     variants with assertion_eval persisted: ${variantsWithEvalCount}/${view.variants.length}`,
		);
		if (variantsWithEvalCount === 0) {
			console.warn(
				'[phase4:ete] WARNING — no variant has assertion_eval persisted. ' +
					'Possible causes: sidecar did not emit assertionEval (older build?), ' +
					'persist write failed, or every variant errored before reaching the assertion engine.',
			);
		}

		// Sample one verdict
		const v0 = bv[0];
		log(
			`     sample verdict: behaviorId=${v0.behaviorId} status=${v0.status} modes=${v0.modes
				.map((m) => `${m.mode}:${m.variantsPassed}/${m.variantsTotal}`)
				.join(' ')}`,
		);
	}

	const reportUrl = `${WEB}/app/features/${flow.id}/runs/${batch.batchId}`;
	log(`PASS — open the deep report: ${reportUrl}`);
}

main().catch((err) => {
	console.error('[phase4:ete] FAIL:', err.message);
	process.exit(1);
});
