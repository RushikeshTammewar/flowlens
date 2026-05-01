/**
 * Typed Flowlens API client used by both the side panel and the service worker.
 * Reads the auth token from chrome.storage.local (key: `flowlens_auth_token`).
 *
 * Errors: every method throws `ApiError` with `{ status, message }` instead of
 * the raw response body — the previous shape dumped Vercel's HTML 404 page
 * straight into the user's side panel, which looked horrid. Power users can
 * still see the body via `err.cause` for debugging.
 */
import { APP_CONFIG } from '../app.config.js';

export class ApiError extends Error {
	readonly status: number;
	readonly path: string;
	readonly cause: string | undefined;
	constructor(status: number, path: string, message: string, body?: string) {
		super(message);
		this.name = 'ApiError';
		this.status = status;
		this.path = path;
		this.cause = body;
	}
}

/**
 * Convert a non-2xx fetch response into a clean ApiError. Reads the body once
 * and tries to parse it as JSON for a useful message; falls back to the HTTP
 * status text. Never propagates raw HTML to the UI.
 */
async function toApiError(res: Response, path: string): Promise<ApiError> {
	let body = '';
	let message = `${res.status} ${res.statusText || 'request failed'}`;
	try {
		body = await res.text();
		if (body) {
			const trimmed = body.trim();
			if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
				try {
					const parsed = JSON.parse(trimmed) as { error?: string; message?: string };
					if (typeof parsed.error === 'string') message = parsed.error;
					else if (typeof parsed.message === 'string') message = parsed.message;
				} catch {
					/* not JSON — keep status-text message */
				}
			} else if (trimmed.startsWith('<')) {
				// HTML error page — don't surface; status text is enough.
			} else if (trimmed.length < 200) {
				message = trimmed;
			}
		}
	} catch {
		/* body read failed; status-text message already set */
	}
	return new ApiError(res.status, path, message, body);
}

export interface StartRecordingRequest {
	siteOrigin: string;
	displayName: string;
	viewport: { w: number; h: number; dpr: number };
	userAgent: string;
}
export interface StartRecordingResponse {
	recordingId: string;
	flowId: string;
	siteId: string;
	uploadKeyPrefix: string;
}

/**
 * Narrowed shape of GET /api/batches/:id used by `MatrixRunning` and
 * `MatrixReport`. Mirrors the server-side enrichment in
 * `apps/web/src/app/api/batches/[id]/route.ts` — keep them in sync.
 */
export interface AssertionEvalView {
	passed: boolean;
	evaluatedKind: string;
	reason: string;
	evidence?: Record<string, unknown>;
	evaluatedAt?: string;
	durationMs?: number;
	llmFallbackUsed?: boolean;
}

export interface BatchStepResult {
	stepIndex: number;
	status: 'passed' | 'failed' | 'flaky' | 'blocked_auth' | 'inconclusive' | 'skipped';
	durationMs: number | null;
	errorMessage: string | null;
	replayScreenshotKey: string | null;
	/** Fully-qualified blob URL when the sidecar uploaded a per-step screenshot. */
	replayScreenshotUrl: string | null;
	/**
	 * Phase 4 / Tier 3 — variant-level assertion verdict. Populated only on
	 * the variant's last step row (the aggregator + report read it from
	 * here). Null for V1 / Phase 3 step rows.
	 */
	assertionEval: AssertionEvalView | null;
}

export type Phase4Mode = 'verify' | 'edge' | 'stress' | 'adversarial' | 'invariant';

export interface BatchVariantRow {
	variant: {
		id: string;
		family: string;
		name: string;
		description: string;
		fragility: string;
		expectedOutcome: { kind: string; criteria?: string; messageContains?: string[] };
		// Phase 4 / Tier 1+ columns (LLD §1.1). Null on legacy V1 variants.
		mode: Phase4Mode | null;
		behaviorId: string | null;
		shouldPass: boolean;
		riskHypothesis: string | null;
		assertion: {
			spec: { kind: string; [k: string]: unknown };
			fallbackPrompt: string;
		} | null;
	};
	run: {
		id: string;
		status: string;
		liveUrl: string | null;
		summary: string | null;
		healthScore: number | null;
		startedAt: string | null;
		finishedAt: string | null;
	} | null;
	stepResults: BatchStepResult[];
}

/**
 * Phase 4 / Tier 4 — `flow.featureContract` shape mirrored for the
 * extension. Source of truth: packages/schema/src/feature-contract.ts.
 * The contract is null on legacy flows compiled before Phase 4 turned
 * on; ContractReview falls back to the description in that case.
 */
export interface FeatureContractView {
	featureName: string;
	inputs: Array<{
		name: string;
		controlType: string;
		domain: 'text' | 'number' | string[];
		constraints: {
			minLength?: number | null;
			maxLength?: number | null;
			min?: number | null;
			max?: number | null;
			pattern?: string | null;
		} | null;
		defaultValue: string | null;
	}>;
	expectedBehaviors: Array<{
		id: string;
		given: string;
		when: string;
		then: string;
		observableOutcome: string;
		importance: 'critical' | 'normal';
	}>;
	invariants: string[];
	synthesizedAt: string | null;
	synthesizedByModel: string | null;
}

export interface FlowWithContractView {
	id: string;
	name: string;
	description: string | null;
	preconditions: string[];
	postconditions: string[];
	fragilityHints: string[];
	status: 'draft' | 'compiling' | 'ready' | 'archived';
	featureContract: FeatureContractView | null;
	cookieSnapshot: {
		cookieCount: number;
		authDetected: boolean;
		origin: string | null;
	} | null;
	steps: Array<{
		index: number;
		action: string;
		intent: string;
		expectedOutcome: string;
		isCritical: boolean;
		recordedScreenshotKey?: string;
		recordedScreenshotUrl?: string;
	}>;
}

export interface BatchFlowView {
	id: string;
	name: string;
	description: string | null;
	preconditions: string[];
	steps: Array<{
		index: number;
		action: string;
		intent: string;
		expectedOutcome: string;
		isCritical: boolean;
	}>;
}

/**
 * Phase 4 / Tier 1 — per-behavior verdict aggregated from
 * variant.assertionEval + variant.shouldPass. Persisted on
 * `run_batches.behavior_verdicts` (LLD §1.1 schema delta).
 */
export interface ModeOutcomeView {
	mode: Phase4Mode;
	variantsTotal: number;
	variantsPassed: number;
	variantsFailed: number;
}

export interface BehaviorVerdictView {
	behaviorId: string;
	behaviorTitle: string;
	status: 'verified' | 'failed' | 'partial' | 'inconclusive';
	modes: ModeOutcomeView[];
	failingVariantIds: string[];
	failureSummary?: string;
}

export interface BatchView {
	batch: {
		id: string;
		flowId: string;
		status: string;
		variantIds: string[];
		startedAt: string | null;
		finishedAt: string | null;
		aiClusterSummary: string | null;
		// Phase 4 / Tier 3 — populated by aggregateBatchVerdict() at batch
		// completion. Null while the batch is still running and on legacy
		// (Phase 3) batches.
		behaviorVerdicts: BehaviorVerdictView[] | null;
		correctnessVerifiedCount: number;
		correctnessTotalCount: number;
		robustnessVerifiedCount: number;
		robustnessTotalCount: number;
	};
	flow: BatchFlowView | null;
	variants: BatchVariantRow[];
	counts: {
		total: number;
		passed: number;
		failed: number;
		errored: number;
		running: number;
		queued: number;
	};
}

async function getToken(): Promise<string | null> {
	// Demo mode: if the build has a baked-in demo bearer, use it for every
	// request. The server matches it via FLOWLENS_DEMO_BEARER and returns the
	// singleton demo {user, org}. Lets users skip the Clerk flow entirely.
	if (APP_CONFIG.demoBearer) {
		return `flowlens-demo-${APP_CONFIG.demoBearer}`;
	}
	const res = await chrome.storage.local.get('flowlens_auth_token');
	const v = res.flowlens_auth_token;
	return typeof v === 'string' && v.length > 0 ? v : null;
}

async function authedFetch(path: string, init?: RequestInit): Promise<Response> {
	const token = await getToken();
	const headers = new Headers(init?.headers);
	headers.set('Content-Type', headers.get('Content-Type') ?? 'application/json');
	if (token) headers.set('Authorization', `Bearer ${token}`);
	return fetch(`${APP_CONFIG.apiUrl}${path}`, { ...init, headers });
}

export const api = {
	async health(): Promise<unknown> {
		const res = await fetch(`${APP_CONFIG.apiUrl}/api/health`);
		return res.json();
	},
	async startRecording(input: StartRecordingRequest): Promise<StartRecordingResponse> {
		const path = '/api/recordings/start';
		const res = await authedFetch(path, { method: 'POST', body: JSON.stringify(input) });
		if (!res.ok) throw await toApiError(res, path);
		return (await res.json()) as StartRecordingResponse;
	},
	async putChunk(input: {
		recordingId: string;
		ordinal: number;
		gzipped?: Uint8Array;
		screenshots?: Array<{ actionIndex: number; pngBase64: string }>;
	}): Promise<{ ordinal: number; bytesStored: number; screenshotsStored: number }> {
		const token = await getToken();
		const fd = new FormData();
		fd.set('ordinal', String(input.ordinal));
		if (input.gzipped) {
			fd.set('rrweb', new Blob([input.gzipped as BlobPart], { type: 'application/octet-stream' }));
		}
		for (const ss of input.screenshots ?? []) {
			const blob = await base64PngToBlob(ss.pngBase64);
			fd.set(`screenshot.${ss.actionIndex}`, blob, `screenshot-${ss.actionIndex}.png`);
		}
		const headers: HeadersInit = {};
		if (token) headers.Authorization = `Bearer ${token}`;
		const path = `/api/recordings/${input.recordingId}/chunks`;
		const res = await fetch(`${APP_CONFIG.apiUrl}${path}`, { method: 'PUT', headers, body: fd });
		if (!res.ok) throw await toApiError(res, path);
		return res.json();
	},
	async finishRecording(input: {
		recordingId: string;
		payload: unknown;
	}): Promise<{ flowId: string; cookieSnapshotId: string }> {
		const path = `/api/recordings/${input.recordingId}/finish`;
		const res = await authedFetch(path, { method: 'POST', body: JSON.stringify(input.payload) });
		if (!res.ok) throw await toApiError(res, path);
		return res.json();
	},
	async getCompileStatus(flowId: string): Promise<{
		flowStatus: 'draft' | 'compiling' | 'ready' | 'archived';
		compile: { stage: string; pct: number; detail?: string; error?: string };
	}> {
		const path = `/api/flows/${flowId}/compile-status`;
		const res = await authedFetch(path);
		if (!res.ok) throw await toApiError(res, path);
		return res.json();
	},
	async getFlow(flowId: string): Promise<{ flow: unknown }> {
		const path = `/api/flows/${flowId}`;
		const res = await authedFetch(path);
		if (!res.ok) throw await toApiError(res, path);
		return res.json();
	},
	/**
	 * Phase 4 / Tier 4 — typed read of /api/flows/:id with the
	 * featureContract surfaced. `ContractReview` and the auto-run path in
	 * `Compiling` use this; the existing `getFlow()` stays for legacy
	 * callers that don't care about the contract.
	 */
	async getFlowWithContract(flowId: string): Promise<{ flow: FlowWithContractView }> {
		const path = `/api/flows/${flowId}`;
		const res = await authedFetch(path);
		if (!res.ok) throw await toApiError(res, path);
		return (await res.json()) as { flow: FlowWithContractView };
	},
	async listFlows(query: { siteId?: string; status?: string }): Promise<{ flows: unknown[] }> {
		const params = new URLSearchParams();
		if (query.siteId) params.set('siteId', query.siteId);
		if (query.status) params.set('status', query.status);
		const qs = params.toString() ? `?${params.toString()}` : '';
		const path = `/api/flows${qs}`;
		const res = await authedFetch(path);
		if (!res.ok) throw await toApiError(res, path);
		return res.json();
	},
	async startRun(flowId: string, mode: 'hybrid' | 'fast' | 'full_llm' = 'hybrid'): Promise<{ runId: string }> {
		const path = `/api/flows/${flowId}/runs`;
		const res = await authedFetch(path, { method: 'POST', body: JSON.stringify({ mode }) });
		if (!res.ok) throw await toApiError(res, path);
		return res.json();
	},
	async getRun(runId: string): Promise<{
		run: {
			id: string;
			liveUrl: string | null;
			status: string;
			summary: string | null;
			healthScore: number | null;
		};
		stepResults: Array<{
			stepIndex: number;
			status: 'passed' | 'failed' | 'flaky' | 'blocked_auth' | 'inconclusive' | 'skipped';
			durationMs: number | null;
			errorMessage: string | null;
		}>;
		flowSteps: Array<{ index: number; action: string; intent: string; isCritical: boolean }>;
	}> {
		const path = `/api/runs/${runId}`;
		const res = await authedFetch(path);
		if (!res.ok) throw await toApiError(res, path);
		return res.json();
	},
	async cancelRun(runId: string): Promise<void> {
		const path = `/api/runs/${runId}/cancel`;
		const res = await authedFetch(path, { method: 'POST' });
		if (!res.ok) throw await toApiError(res, path);
	},
	async listTestMatrix(flowId: string): Promise<{ variants: Array<{ id: string }> }> {
		const path = `/api/flows/${flowId}/test-matrix`;
		const res = await authedFetch(path);
		if (!res.ok) throw await toApiError(res, path);
		return (await res.json()) as { variants: Array<{ id: string }> };
	},
	async generateTestMatrix(
		flowId: string,
		count: 5 | 10 | 20 = 5,
	): Promise<{ variants: Array<{ id: string }>; model: string }> {
		const path = `/api/flows/${flowId}/test-matrix`;
		const res = await authedFetch(path, {
			method: 'POST',
			body: JSON.stringify({ count }),
		});
		if (!res.ok) throw await toApiError(res, path);
		return (await res.json()) as { variants: Array<{ id: string }>; model: string };
	},
	async startBatchRun(
		flowId: string,
		opts: { variantIds?: string[]; parallelism?: number } = {},
	): Promise<{ batchId: string; variantCount: number; status: string }> {
		const path = `/api/flows/${flowId}/runs/batch`;
		const body: Record<string, unknown> = {};
		if (opts.variantIds && opts.variantIds.length > 0) body.variantIds = opts.variantIds;
		if (typeof opts.parallelism === 'number') body.parallelism = opts.parallelism;
		const res = await authedFetch(path, { method: 'POST', body: JSON.stringify(body) });
		if (!res.ok) throw await toApiError(res, path);
		return (await res.json()) as { batchId: string; variantCount: number; status: string };
	},
	/**
	 * Polled by `MatrixRunning` (every ~2.5s) and read once by `MatrixReport`.
	 * Returns the parent flow context, per-variant runs, step results, and
	 * fully-qualified replay-screenshot URLs.
	 */
	async getBatch(batchId: string): Promise<BatchView> {
		const path = `/api/batches/${batchId}`;
		const res = await authedFetch(path);
		if (!res.ok) throw await toApiError(res, path);
		return (await res.json()) as BatchView;
	},
	async refreshCookies(input: {
		siteOrigin: string;
		cookies: unknown[];
		storage: { localStorage: Record<string, string>; sessionStorage: Record<string, string> };
		triggeredByRunId?: string;
	}): Promise<{ cookieSnapshotId: string; buProfileUpdated: boolean; runResumed: boolean }> {
		const path = `/api/cookies/refresh`;
		const res = await authedFetch(path, { method: 'POST', body: JSON.stringify(input) });
		if (!res.ok) throw await toApiError(res, path);
		return res.json();
	},
};

async function base64PngToBlob(b64: string): Promise<Blob> {
	const cleaned = b64.startsWith('data:') ? b64.slice(b64.indexOf(',') + 1) : b64;
	const bin = atob(cleaned);
	const bytes = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
	return new Blob([bytes], { type: 'image/png' });
}
