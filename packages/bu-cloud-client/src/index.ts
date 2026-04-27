/**
 * Browser Use Cloud v2 typed client.
 *
 * Auth header: `X-Browser-Use-API-Key`.
 * Base URL: `https://api.browser-use.com/api/v2`.
 *
 * Reference: browser-use-source/CLOUD.md (locally checked-out)
 */
import { z } from 'zod';

export const BU_BASE_URL = 'https://api.browser-use.com/api/v2';

// ────────────────────────────────────────────────────────────
// Schemas
// ────────────────────────────────────────────────────────────

export const BuPlanSchema = z.object({
	planName: z.string(),
	subscriptionStatus: z.string().nullable(),
	subscriptionId: z.string().nullable(),
	subscriptionCurrentPeriodEnd: z.string().nullable(),
	subscriptionCanceledAt: z.string().nullable(),
});

export const BuAccountSchema = z.object({
	name: z.string().nullable(),
	monthlyCreditsBalanceUsd: z.number(),
	additionalCreditsBalanceUsd: z.number(),
	totalCreditsBalanceUsd: z.number(),
	rateLimit: z.number().int(),
	planInfo: BuPlanSchema,
	projectId: z.string().uuid(),
});
export type BuAccount = z.infer<typeof BuAccountSchema>;

export const BuProxyCountrySchema = z.enum([
	'us',
	'uk',
	'fr',
	'it',
	'jp',
	'au',
	'de',
	'fi',
	'ca',
	'in',
]);
export type BuProxyCountry = z.infer<typeof BuProxyCountrySchema>;

export const BuBrowserSessionViewSchema = z.object({
	id: z.string().uuid(),
	cdpUrl: z.string().nullable(),
	liveUrl: z.string().nullable(),
	status: z.string(),
	startedAt: z.string().nullable(),
	stoppedAt: z.string().nullable(),
});
export type BuBrowserSessionView = z.infer<typeof BuBrowserSessionViewSchema>;

export const BuCreateBrowserRequestSchema = z.object({
	profileId: z.string().uuid().nullable().optional(),
	proxyCountryCode: BuProxyCountrySchema.nullable().optional(),
	timeout: z.number().int().positive().optional(),
	keepAlive: z.boolean().optional(),
});
export type BuCreateBrowserRequest = z.infer<typeof BuCreateBrowserRequestSchema>;

export const BuTaskCreatedSchema = z.object({
	id: z.string().uuid(),
	sessionId: z.string().uuid(),
});
export type BuTaskCreated = z.infer<typeof BuTaskCreatedSchema>;

// ────────────────────────────────────────────────────────────
// Errors
// ────────────────────────────────────────────────────────────

export class BuCloudError extends Error {
	constructor(
		public readonly status: number,
		public readonly body: unknown,
		message?: string,
	) {
		super(message ?? `BU Cloud error ${status}`);
		this.name = 'BuCloudError';
	}

	get isRateLimited() {
		return this.status === 429;
	}

	get isInsufficientBalance() {
		return this.status === 402;
	}
}

// ────────────────────────────────────────────────────────────
// Client
// ────────────────────────────────────────────────────────────

export interface BuClientOptions {
	apiKey: string;
	baseUrl?: string;
	timeoutMs?: number;
	fetchImpl?: typeof fetch;
}

export class BuCloudClient {
	private readonly apiKey: string;
	private readonly baseUrl: string;
	private readonly timeoutMs: number;
	private readonly fetchImpl: typeof fetch;

	constructor(opts: BuClientOptions) {
		this.apiKey = opts.apiKey;
		this.baseUrl = opts.baseUrl ?? BU_BASE_URL;
		this.timeoutMs = opts.timeoutMs ?? 30_000;
		this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
	}

	private async request<T>(
		path: string,
		init: RequestInit & { schema?: z.ZodType<T> } = {},
	): Promise<T> {
		const ctrl = new AbortController();
		const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);

		try {
			const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
				...init,
				headers: {
					'X-Browser-Use-API-Key': this.apiKey,
					'Content-Type': 'application/json',
					...(init.headers ?? {}),
				},
				signal: ctrl.signal,
			});

			let body: unknown;
			const contentType = res.headers.get('content-type') ?? '';
			if (contentType.includes('application/json')) {
				body = await res.json();
			} else {
				body = await res.text();
			}

			if (!res.ok) {
				throw new BuCloudError(res.status, body);
			}

			return init.schema ? init.schema.parse(body) : (body as T);
		} finally {
			clearTimeout(timer);
		}
	}

	// ─── Billing ───────────────────────────────────────────
	async getAccount(): Promise<BuAccount> {
		return this.request<BuAccount>('/billing/account', {
			method: 'GET',
			schema: BuAccountSchema,
		});
	}

	// ─── Browser sessions ──────────────────────────────────
	async createBrowserSession(req: BuCreateBrowserRequest): Promise<BuBrowserSessionView> {
		return this.request<BuBrowserSessionView>('/browsers', {
			method: 'POST',
			body: JSON.stringify(BuCreateBrowserRequestSchema.parse(req)),
			schema: BuBrowserSessionViewSchema,
		});
	}

	async getBrowserSession(sessionId: string): Promise<BuBrowserSessionView> {
		return this.request<BuBrowserSessionView>(`/browsers/${sessionId}`, {
			method: 'GET',
			schema: BuBrowserSessionViewSchema,
		});
	}

	/**
	 * Stop a hosted browser session.
	 *
	 * BU Cloud uses `/browsers/:id` (not `/sessions/:id`!) for browser-session
	 * lifecycle. The /sessions/:id PATCH path is for task-sessions only and
	 * returns 404 for browser-session IDs — verified empirically against
	 * api.browser-use.com on 2026-04-27 while debugging stuck-session leaks.
	 */
	async stopBrowserSession(sessionId: string): Promise<void> {
		await this.request(`/browsers/${sessionId}`, {
			method: 'PATCH',
			body: JSON.stringify({ action: 'stop' }),
		});
	}

	/**
	 * List browser sessions on this account. Useful for janitorial cleanups
	 * (e.g. `monitorAndCleanupOrphanedBuSessions` in apps/web).
	 */
	async listBrowserSessions(opts: { pageSize?: number; status?: string } = {}): Promise<
		Array<{ id: string; status: string; startedAt: string; finishedAt: string | null }>
	> {
		const params = new URLSearchParams();
		if (opts.pageSize) params.set('pageSize', String(opts.pageSize));
		if (opts.status) params.set('status', opts.status);
		const path = `/browsers${params.size ? `?${params}` : ''}`;
		const res = await this.request<{
			items?: Array<{ id: string; status: string; startedAt: string; finishedAt: string | null }>;
		}>(path, { method: 'GET' });
		return res.items ?? [];
	}

	// ─── Sessions (live / share) ───────────────────────────
	async getSession(sessionId: string): Promise<{ liveUrl: string | null; status: string }> {
		return this.request(`/sessions/${sessionId}`, {
			method: 'GET',
		});
	}

	async createPublicShare(sessionId: string): Promise<{ shareToken: string; shareUrl: string }> {
		return this.request(`/sessions/${sessionId}/public-share`, {
			method: 'POST',
		});
	}

	async deletePublicShare(sessionId: string): Promise<void> {
		await this.request(`/sessions/${sessionId}/public-share`, {
			method: 'DELETE',
		});
	}

	// ─── Profiles ──────────────────────────────────────────
	async createProfile(req: { name: string; description?: string }): Promise<{ id: string; name: string }> {
		return this.request('/profiles', {
			method: 'POST',
			body: JSON.stringify(req),
		});
	}

	async updateProfile(
		profileId: string,
		req: { name?: string; description?: string },
	): Promise<{ id: string }> {
		return this.request(`/profiles/${profileId}`, {
			method: 'PATCH',
			body: JSON.stringify(req),
		});
	}

	async deleteProfile(profileId: string): Promise<void> {
		await this.request(`/profiles/${profileId}`, { method: 'DELETE' });
	}

	// ─── Tasks (hosted agent runs) ─────────────────────────
	async createTask(req: {
		task: string;
		llm?: string;
		startUrl?: string;
		maxSteps?: number;
		structuredOutput?: string;
		sessionId?: string;
		metadata?: Record<string, string>;
		secrets?: Record<string, string>;
		allowedDomains?: string[];
		flashMode?: boolean;
		thinking?: boolean;
		vision?: boolean | 'auto';
	}): Promise<BuTaskCreated> {
		return this.request<BuTaskCreated>('/tasks', {
			method: 'POST',
			body: JSON.stringify(req),
			schema: BuTaskCreatedSchema,
		});
	}

	async getTask(taskId: string): Promise<unknown> {
		return this.request(`/tasks/${taskId}`, { method: 'GET' });
	}

	async stopTask(taskId: string): Promise<void> {
		await this.request(`/tasks/${taskId}`, {
			method: 'PATCH',
			body: JSON.stringify({ action: 'stop' }),
		});
	}
}

// ────────────────────────────────────────────────────────────
// Convenience constructor
// ────────────────────────────────────────────────────────────

export function createBuClient(): BuCloudClient {
	const apiKey = (typeof process !== 'undefined' ? process.env.BROWSER_USE_API_KEY : undefined) ?? '';
	if (!apiKey) {
		throw new Error('BROWSER_USE_API_KEY env var is required');
	}
	return new BuCloudClient({ apiKey });
}
