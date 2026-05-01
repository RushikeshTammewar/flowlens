/**
 * Inline batch runner — fan out N parallel runs against the local replay
 * worker (or the deployed sidecar), one per test variant.
 *
 * Same pattern as `runCompileInline`: fire-and-forget from the batch-create
 * route, wrapped in `waitUntil` to keep the function alive past response.
 *
 * Why inline (not Vercel Workflow): the WDK `.well-known/workflow/v1/*`
 * routes return 404 on this Vercel project even though the functions are
 * built. Until that's isolated, run the same fan-out pipeline inline. Trade
 * lose durable resume-on-crash; gain a feature that actually runs.
 */
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '@/lib/db';
import {
	flows,
	runs,
	runBatches,
	testVariants,
	stepResults,
	cookieSnapshots,
	sites,
} from '@flowlens/schema/db';
import type { AssertionEval, FlowStep } from '@flowlens/schema';
import { openForOrg } from '@flowlens/cookies-vault';
import { createBuClient } from '@flowlens/bu-cloud-client';
import { emitSseEvent } from '@/lib/sse-bus';
import { MODELS, getLlmClient, hasLlmCredentials } from '@flowlens/llm-config';
import { blobKeys, putBlob } from '@/lib/blob';
import { aggregateBatchVerdict } from '@/lib/aggregate-batch-verdict';
import { isPhase4Enabled } from '@/lib/feature-flags';

const REPLAY_WORKER_URL = process.env.REPLAY_WORKER_URL ?? 'http://127.0.0.1:8000';
const REPLAY_WORKER_BEARER = process.env.REPLAY_WORKER_SHARED_SECRET ?? '';
const MAX_PARALLEL = 5; // BU Cloud free-tier concurrent-session cap

export interface RunBatchInlineInput {
	batchId: string;
	flowId: string;
	orgId: string;
	variantIds: string[];
}

export async function runBatchInline(input: RunBatchInlineInput): Promise<void> {
	const startedAt = Date.now();
	console.info(
		`[batch-inline] batch=${input.batchId} flow=${input.flowId} variants=${input.variantIds.length}`,
	);

	try {
		// Mark batch running.
		await db
			.update(runBatches)
			.set({ status: 'running', startedAt: new Date() })
			.where(eq(runBatches.id, input.batchId));
		await emitSseEvent(`batch:${input.batchId}`, {
			type: 'batch_started',
			batchId: input.batchId,
			parallelism: Math.min(MAX_PARALLEL, input.variantIds.length),
		});

		// Load shared context once: flow + cookies.
		const flow = await db.query.flows.findFirst({ where: eq(flows.id, input.flowId) });
		if (!flow) throw new Error(`flow ${input.flowId} disappeared`);
		const site = await db.query.sites.findFirst({ where: eq(sites.id, flow.siteId) });
		if (!site) throw new Error(`site ${flow.siteId} disappeared`);
		const variants = await db.query.testVariants.findMany({
			where: inArray(testVariants.id, input.variantIds),
		});
		if (variants.length === 0) throw new Error('no variants resolved');

		// Decrypt the cookie snapshot once for the whole batch and reuse it for
		// every variant. Two outputs:
		//   1. `injectableCookies` — the full ChromeCookie[] which the sidecar
		//      pushes into the BU Cloud session via CDP `Storage.setCookies`
		//      BEFORE the first navigation. THIS IS THE AUTH STORY.
		//   2. `sensitiveData` — a {name: value} map fed to browser-use's
		//      Agent for prompt-side credential redaction. Useful when the
		//      Agent needs to type a value the user typed during recording
		//      but we don't want it to appear in LLM prompts.
		type InjectableCookie = {
			name: string;
			value: string;
			domain: string;
			path: string;
			expires: number | null;
			httpOnly: boolean;
			secure: boolean;
			sameSite: 'Strict' | 'Lax' | 'None' | 'unspecified';
		};
		const injectableCookies: InjectableCookie[] = [];
		const sensitiveData: Record<string, string> = {};
		if (flow.cookieSnapshotId && process.env.FLOWLENS_VAULT_SECRET) {
			try {
				const snap = await db.query.cookieSnapshots.findFirst({
					where: eq(cookieSnapshots.id, flow.cookieSnapshotId),
				});
				if (snap) {
					const plaintext = await openForOrg({
						orgId: input.orgId,
						vaultSecret: process.env.FLOWLENS_VAULT_SECRET,
						sealed: { ciphertext: snap.ciphertext, nonce: snap.nonce },
					});
					const parsed = JSON.parse(plaintext) as {
						cookies?: InjectableCookie[];
					};
					for (const c of parsed.cookies ?? []) {
						injectableCookies.push(c);
						sensitiveData[c.name] = c.value;
					}
					console.info(
						`[FLOWLENS:batch-inline] cookies_decrypted snapshotId=${snap.id} count=${injectableCookies.length} domains=${Array.from(new Set(injectableCookies.map((c) => c.domain))).slice(0, 5).join(',')}`,
					);
				} else {
					console.warn('[FLOWLENS:batch-inline] cookieSnapshotId set but row missing');
				}
			} catch (err) {
				console.warn('[FLOWLENS:batch-inline] vault decrypt failed:', (err as Error).message);
			}
		} else {
			console.info(
				`[FLOWLENS:batch-inline] no_cookies cookieSnapshotId=${flow.cookieSnapshotId ?? 'null'} hasVaultSecret=${!!process.env.FLOWLENS_VAULT_SECRET}`,
			);
		}

		// Fan out runs with bounded parallelism.
		const buClient = createBuClient();
		const results: Array<{
			runId: string;
			variantId: string;
			status: string;
			summary: string;
			healthScore: number;
		}> = [];

		const semaphore = new Semaphore(MAX_PARALLEL);
		await Promise.all(
			variants.map((variant) =>
				semaphore.use(async () => {
					const result = await runOneVariant({
						batchId: input.batchId,
						flowId: input.flowId,
						orgId: input.orgId,
						flowName: flow.name,
						siteOrigin: site.origin,
						baseSteps: (flow.steps as FlowStep[]) ?? [],
						buProfileId: flow.buProfileId,
						sensitiveData,
						injectableCookies,
						variant,
						buClient,
					});
					results.push(result);
				}),
			),
		);

		// Aggregate + AI cluster summary.
		const summary = await summarizeBatch({
			flowName: flow.name,
			results,
			variants,
		});

		await db
			.update(runBatches)
			.set({
				status: 'completed',
				finishedAt: new Date(),
				aiClusterSummary: summary.summary,
			})
			.where(eq(runBatches.id, input.batchId));

		// Phase 4 / Tier 3 — two-axis verdict aggregation. Always runs;
		// V1 batches (no Phase 4 variant.mode) get a degenerate empty
		// report (zeros), Phase 4 batches get the full per-behavior
		// rollup persisted to run_batches.behavior_verdicts +
		// correctness/robustness counts. Defensive try/catch — never
		// fail batch completion just because aggregation hiccupped.
		try {
			if (isPhase4Enabled()) {
				const agg = await aggregateBatchVerdict({ batchId: input.batchId });
				console.info(
					`[phase4:aggregate] batch=${input.batchId} ` +
						`persisted=${agg.persisted} ` +
						`correctness=${agg.twoAxisReport.correctness.verified}/${agg.twoAxisReport.correctness.total} ` +
						`robustness=${agg.twoAxisReport.robustness.verified}/${agg.twoAxisReport.robustness.total}`,
				);
			}
		} catch (err) {
			console.warn(
				`[phase4:aggregate] batch=${input.batchId} aggregation failed:`,
				(err as Error).message,
			);
		}

		await emitSseEvent(`batch:${input.batchId}`, {
			type: 'batch_complete',
			batchId: input.batchId,
			passed: results.filter((r) => r.status === 'passed').length,
			failed: results.filter((r) => r.status === 'failed').length,
			errored: results.filter((r) => r.status === 'errored').length,
			summary: summary.summary,
		});

		console.info(
			`[batch-inline] batch=${input.batchId} done in ${Date.now() - startedAt}ms (${results.length} runs)`,
		);
	} catch (err) {
		console.error(`[batch-inline] batch=${input.batchId} FAILED:`, err);
		await db
			.update(runBatches)
			.set({
				status: 'errored',
				finishedAt: new Date(),
				aiClusterSummary: `Batch failed: ${(err as Error).message.slice(0, 400)}`,
			})
			.where(eq(runBatches.id, input.batchId))
			.catch(() => {});
		await emitSseEvent(`batch:${input.batchId}`, {
			type: 'batch_failed',
			batchId: input.batchId,
			error: (err as Error).message,
		}).catch(() => {});
		throw err;
	}
}

interface RunOneVariantInput {
	batchId: string;
	flowId: string;
	orgId: string;
	flowName: string;
	siteOrigin: string;
	baseSteps: FlowStep[];
	buProfileId: string | null;
	sensitiveData: Record<string, string>;
	injectableCookies: Array<{
		name: string;
		value: string;
		domain: string;
		path: string;
		expires: number | null;
		httpOnly: boolean;
		secure: boolean;
		sameSite: 'Strict' | 'Lax' | 'None' | 'unspecified';
	}>;
	variant: typeof testVariants.$inferSelect;
	buClient: ReturnType<typeof createBuClient>;
}

async function runOneVariant(input: RunOneVariantInput): Promise<{
	runId: string;
	variantId: string;
	status: string;
	summary: string;
	healthScore: number;
}> {
	// Apply field overrides to a copy of the flow steps.
	const overrides = input.variant.fieldOverrides;
	const variantSteps: FlowStep[] = input.baseSteps.map((s) => {
		const override = overrides[String(s.index)];
		if (override === undefined) return s;
		return { ...s, recordedValue: override };
	});

	// Insert run row up front so the batch UI can find it.
	const [run] = await db
		.insert(runs)
		.values({
			orgId: input.orgId,
			flowId: input.flowId,
			batchId: input.batchId,
			variantId: input.variant.id,
			triggeredBy: 'matrix_batch',
			status: 'queued',
		})
		.returning();
	if (!run) throw new Error('failed to insert run row');

	let buSessionId: string | null = null;
	try {
		// Create BU session.
		const bu = await input.buClient.createBrowserSession({
			profileId: input.buProfileId ?? undefined,
			keepAlive: true,
		});
		buSessionId = bu.id;
		await db
			.update(runs)
			.set({
				buSessionId: bu.id,
				buCdpUrl: bu.cdpUrl,
				liveUrl: bu.liveUrl,
				status: 'running',
				startedAt: new Date(),
			})
			.where(eq(runs.id, run.id));
		await emitSseEvent(`batch:${input.batchId}`, {
			type: 'variant_started',
			batchId: input.batchId,
			runId: run.id,
			variantId: input.variant.id,
			variantName: input.variant.name,
			liveUrl: bu.liveUrl,
		});

		console.info(
			`[FLOWLENS:batch-inline] variant.spawn runId=${run.id} variant=${input.variant.id} family=${input.variant.family} cookies=${input.injectableCookies.length} buSession=${bu.id}`,
		);

		// Phase 4 / Tier 3 — when this variant carries an assertion +
		// behaviorId + mode, forward them to the sidecar so the assertion
		// engine runs after the step loop terminates. Polarity (shouldPass)
		// is applied later at aggregation time, NOT here. V1 variants (no
		// `mode` column populated) keep the previous payload shape.
		const variantPhase4 = (input.variant as typeof input.variant & {
			mode: 'verify' | 'edge' | 'stress' | 'adversarial' | 'invariant' | null;
			behaviorId: string | null;
			assertion: { spec: { kind: string }; fallbackPrompt: string } | null;
			shouldPass: boolean;
		});
		const phase4Active = Boolean(variantPhase4.mode && variantPhase4.assertion);

		// Call /run-sync. The sidecar buffers all events and returns them
		// as a JSON envelope. This trades streaming progress for delivery
		// guarantees — fetch chunk buffering ate our SSE run_complete
		// events whenever 5 variants raced. The user can still watch each
		// variant via `bu.liveUrl` (BU Cloud's hosted view).
		const syncRes = await fetch(`${REPLAY_WORKER_URL}/run-sync`, {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${REPLAY_WORKER_BEARER}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				runId: run.id,
				flow: {
					id: input.flowId,
					name: input.flowName,
					siteOrigin: input.siteOrigin,
					steps: variantSteps,
				},
				cdpUrl: bu.cdpUrl,
				liveUrl: bu.liveUrl,
				mode: { name: 'hybrid' },
				recordedScreenshotsByIndex: {},
				sensitiveData: input.sensitiveData,
				cookies: input.injectableCookies,
				// Land BU Cloud on the EXACT URL where the user started
				// recording (e.g. /practice-test-table/ on a deep page),
				// NOT just the origin. Using `siteOrigin` lands on the
				// homepage where the recorded selectors don't exist —
				// every variant then fails at step 0 with `no_match`.
				// First-step URL is captured by the recorder from
				// `location.href` and is the highest-fidelity value.
				landingUrl:
					(variantSteps[0] as { url?: string } | undefined)?.url ?? input.siteOrigin,
				// Phase 4 / Tier 3 — null/empty when V1 variant.
				...(phase4Active
					? {
							assertion: variantPhase4.assertion,
							shouldPass: variantPhase4.shouldPass,
							behaviorId: variantPhase4.behaviorId,
							phase4Mode: variantPhase4.mode,
						}
					: {}),
				// state (web storage + fingerprint) — wired here as an
				// empty object until the recorder snapshot pipeline
				// produces these envelopes (Tier 5 follow-up). Sidecar
				// no-ops on empty state.
				state: {},
			}),
			signal: AbortSignal.timeout(360_000),
		});

		if (!syncRes.ok) {
			throw new Error(`sidecar /run-sync returned ${syncRes.status}: ${await syncRes.text()}`);
		}

		const syncBody = (await syncRes.json()) as {
			runId: string;
			events: Array<{ type: string; payload: Record<string, unknown> }>;
		};

		let runStatus: 'passed' | 'failed' | 'errored' = 'errored';
		let runSummary = 'no terminal event from sidecar';
		let healthScore = 0;
		let stepFinishedSeen = 0;
		let lastStepIndex: number | null = null;
		let phase4AssertionEval: AssertionEval | null = null;

		for (const ev of syncBody.events) {
			if (ev.type === 'StepFinishedEvent') {
				stepFinishedSeen++;
				const stepResult = (ev.payload.result ?? {}) as {
					stepIndex: number;
					status: 'passed' | 'failed' | 'flaky' | 'blocked_auth' | 'inconclusive' | 'skipped';
					durationMs: number;
					selectorResolvedVia?: string | null;
					replayScreenshotBlobKey?: string | null;
					replayScreenshotPngB64?: string | null;
					judge?: { verdict: 'pass' | 'fail'; reason: string; confidence: number } | null;
					consoleErrors?: string[];
					networkErrors?: { url: string; status: number }[];
					llmStepsUsed?: number;
					llmCostUsdMicro?: number;
					errorMessage?: string | null;
				};
				stepResult.replayScreenshotBlobKey = await uploadReplayScreenshot(
					run.id,
					stepResult.stepIndex,
					stepResult.replayScreenshotPngB64,
				);
				// Drop the heavy base64 payload before persisting — it's
				// already on Vercel Blob and the DB shouldn't carry it.
				stepResult.replayScreenshotPngB64 = null;
				await persistStepResult(run.id, stepResult);
				lastStepIndex = stepResult.stepIndex;
				await emitSseEvent(`batch:${input.batchId}`, {
					type: 'variant_step',
					batchId: input.batchId,
					runId: run.id,
					variantId: input.variant.id,
					stepIndex: stepResult.stepIndex,
					status: stepResult.status,
				});
			} else if (ev.type === 'RunCompleteEvent') {
				const s = ev.payload.status as string;
				runStatus = s === 'passed' ? 'passed' : s === 'failed' ? 'failed' : 'errored';
				runSummary = (ev.payload.summary as string) ?? '';
				healthScore = (ev.payload.healthScore as number) ?? 0;
				// Phase 4 / Tier 3 — sidecar emits assertionEval when the
				// caller passed an `assertion` payload. Capture it here
				// and persist below on the LAST step row so the
				// aggregator can find it via step_results.assertion_eval.
				const ae = (ev.payload as { assertionEval?: AssertionEval | null }).assertionEval;
				if (ae) phase4AssertionEval = ae;
			} else if (ev.type === 'RunPausedEvent') {
				runStatus = 'errored';
				runSummary = `paused: ${(ev.payload.hint as string) ?? ''}`;
			}
		}
		console.info(
			`[FLOWLENS:batch-inline] sync_replay_done runId=${run.id} stepsSeen=${stepFinishedSeen} runStatus=${runStatus} healthScore=${healthScore}`,
		);

		// Phase 4 / Tier 3 — stamp assertionEval onto the last step's
		// row so the aggregator can find it via step_results.assertion_eval.
		// Falls back to step 0 when the loop produced no steps (variant
		// crashed before step 0 — assertion still carries reason).
		if (phase4AssertionEval) {
			const targetStepIndex = lastStepIndex ?? 0;
			await db
				.update(stepResults)
				.set({ assertionEval: phase4AssertionEval })
				.where(
					and(
						eq(stepResults.runId, run.id),
						eq(stepResults.stepIndex, targetStepIndex),
					),
				)
				.catch((err) => {
					console.warn(
						`[phase4:assertion] persist failed for run=${run.id}:`,
						(err as Error).message,
					);
				});
			console.info(
				`[phase4:assertion] persisted run=${run.id} step=${targetStepIndex} ` +
					`passed=${phase4AssertionEval.passed} kind=${phase4AssertionEval.evaluatedKind} ` +
					`llmFallback=${phase4AssertionEval.llmFallbackUsed}`,
			);
		}

		await db
			.update(runs)
			.set({
				status: runStatus,
				finishedAt: new Date(),
				summary: runSummary,
				healthScore,
			})
			.where(eq(runs.id, run.id));
		await emitSseEvent(`batch:${input.batchId}`, {
			type: 'variant_complete',
			batchId: input.batchId,
			runId: run.id,
			variantId: input.variant.id,
			status: runStatus,
			healthScore,
			summary: runSummary,
		});
		return { runId: run.id, variantId: input.variant.id, status: runStatus, summary: runSummary, healthScore };
	} catch (err) {
		console.error(`[batch-inline] variant=${input.variant.id} FAILED:`, err);
		const message = (err as Error).message ?? String(err);
		await db
			.update(runs)
			.set({
				status: 'errored',
				finishedAt: new Date(),
				summary: `errored: ${message.slice(0, 200)}`,
			})
			.where(eq(runs.id, run.id))
			.catch(() => {});
		await emitSseEvent(`batch:${input.batchId}`, {
			type: 'variant_complete',
			batchId: input.batchId,
			runId: run.id,
			variantId: input.variant.id,
			status: 'errored',
			summary: message,
		}).catch(() => {});
		return { runId: run.id, variantId: input.variant.id, status: 'errored', summary: message, healthScore: 0 };
	} finally {
		if (buSessionId) {
			try {
				await input.buClient.stopBrowserSession(buSessionId);
			} catch (err) {
				console.warn('[batch-inline] stopBrowserSession failed:', (err as Error).message);
			}
		}
	}
}

/**
 * Decode the sidecar's base64 JPEG and upload it to Vercel Blob.
 *
 * Returns the blob key on success, the existing key (if the sidecar already
 * resolved one), or `null` on any failure. Never throws — a screenshot upload
 * failure must NEVER fail the surrounding step. The MatrixReport UI gracefully
 * renders a "no screenshot" placeholder when the key is null.
 *
 * Sidecar emits JPEG (quality=60, ~80KB) under the field still named
 * `replayScreenshotPngB64` for wire-stability. We persist with the matching
 * `image/jpeg` content-type so Vercel Blob serves the right MIME header.
 */
async function uploadReplayScreenshot(
	runId: string,
	stepIndex: number,
	pngB64: string | null | undefined,
): Promise<string | null> {
	if (!pngB64) return null;
	try {
		const bytes = Buffer.from(pngB64, 'base64');
		if (bytes.byteLength === 0) return null;
		const key = blobKeys.replayScreenshot(runId, stepIndex);
		await putBlob(key, bytes, 'image/jpeg');
		return key;
	} catch (err) {
		console.warn(
			`[batch-inline] uploadReplayScreenshot run=${runId} step=${stepIndex} skipped: ${(err as Error).message}`,
		);
		return null;
	}
}

async function persistStepResult(
	runId: string,
	result: {
		stepIndex: number;
		status: 'passed' | 'failed' | 'flaky' | 'blocked_auth' | 'inconclusive' | 'skipped';
		durationMs: number;
		selectorResolvedVia?: string | null;
		replayScreenshotBlobKey?: string | null;
		judge?: { verdict: 'pass' | 'fail'; reason: string; confidence: number } | null;
		consoleErrors?: string[];
		networkErrors?: { url: string; status: number }[];
		llmStepsUsed?: number;
		llmCostUsdMicro?: number;
		errorMessage?: string | null;
	},
): Promise<void> {
	await db
		.insert(stepResults)
		.values({
			runId,
			stepIndex: result.stepIndex,
			status: result.status,
			startedAt: new Date(Date.now() - result.durationMs),
			finishedAt: new Date(),
			durationMs: result.durationMs,
			selectorResolvedVia: (result.selectorResolvedVia ?? null) as
				| 'testid'
				| 'role-name'
				| 'css'
				| 'xpath'
				| 'flowlens-id'
				| 'llm'
				| 'recorded-only'
				| null,
			replayScreenshotKey: result.replayScreenshotBlobKey ?? null,
			judge: result.judge ?? null,
			consoleErrors: result.consoleErrors ?? [],
			networkErrors: result.networkErrors ?? [],
			llmStepsUsed: result.llmStepsUsed ?? 0,
			llmCostUsdMicro: result.llmCostUsdMicro ?? 0,
			errorMessage: result.errorMessage ?? null,
		})
		.catch((err) => {
			console.warn('[batch-inline] persistStepResult skipped:', (err as Error).message);
		});
}

async function summarizeBatch(input: {
	flowName: string;
	results: Array<{ runId: string; variantId: string; status: string; summary: string; healthScore: number }>;
	variants: (typeof testVariants.$inferSelect)[];
}): Promise<{ summary: string }> {
	const creds = hasLlmCredentials();
	if (!creds.configured || input.results.length === 0) {
		const passed = input.results.filter((r) => r.status === 'passed').length;
		return { summary: `${passed}/${input.results.length} variants passed.` };
	}
	try {
		const client = getLlmClient();
		const variantById = new Map(input.variants.map((v) => [v.id, v]));
		const lines = input.results.map((r) => {
			const v = variantById.get(r.variantId);
			return `- ${v?.family ?? '?'} · ${v?.name ?? '?'}: ${r.status} (${r.healthScore})  → ${r.summary.slice(0, 200)}`;
		});
		const userPrompt = `Flow: ${input.flowName}

Per-variant results:
${lines.join('\n')}

Cluster the failures into 1-3 themes. For each theme: 1-line description of what's broken, list the variants that hit it, and a recommended fix. If everything passed, just say "All N variants passed — no failures to cluster". Keep it under 600 characters total.`;

		const response = await client.chat.completions.create({
			model: MODELS.matrixCluster,
			messages: [
				{
					role: 'system',
					content:
						'You are a senior QA engineer reading a batch of test results. Be concise. Cluster failures by root cause.',
				},
				{ role: 'user', content: userPrompt },
			],
			max_completion_tokens: 400,
		});
		return {
			summary:
				response.choices[0]?.message.content?.slice(0, 1200) ??
				`${input.results.filter((r) => r.status === 'passed').length}/${input.results.length} variants passed.`,
		};
	} catch (err) {
		console.warn('[batch-inline] cluster summary failed:', (err as Error).message);
		const passed = input.results.filter((r) => r.status === 'passed').length;
		return { summary: `${passed}/${input.results.length} variants passed (cluster summary unavailable).` };
	}
}

class Semaphore {
	private active = 0;
	private queue: Array<() => void> = [];
	constructor(private readonly max: number) {}
	async use<T>(fn: () => Promise<T>): Promise<T> {
		await this.acquire();
		try {
			return await fn();
		} finally {
			this.release();
		}
	}
	private async acquire() {
		if (this.active < this.max) {
			this.active++;
			return;
		}
		await new Promise<void>((resolve) => this.queue.push(resolve));
		this.active++;
	}
	private release() {
		this.active--;
		const next = this.queue.shift();
		if (next) next();
	}
}
