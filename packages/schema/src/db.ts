import {
	pgTable,
	text,
	integer,
	timestamp,
	jsonb,
	boolean,
	uuid,
	index,
} from 'drizzle-orm/pg-core';
import type { FlowStep } from './flow';
import type { ChromeCookie, StorageSnapshot } from './cookie';

export const orgs = pgTable('orgs', {
	id: uuid('id').primaryKey().defaultRandom(),
	clerkOrgId: text('clerk_org_id').unique().notNull(),
	name: text('name').notNull(),
	plan: text('plan', { enum: ['free', 'pro', 'team'] })
		.default('free')
		.notNull(),
	monthlyRunBudgetUsdMicro: integer('monthly_run_budget_usd_micro').default(20_000_000).notNull(),
	monthlyRunsConsumedUsdMicro: integer('monthly_runs_consumed_usd_micro').default(0).notNull(),
	monthlyRunsResetAt: timestamp('monthly_runs_reset_at').defaultNow().notNull(),
	createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const users = pgTable('users', {
	id: uuid('id').primaryKey().defaultRandom(),
	clerkUserId: text('clerk_user_id').unique().notNull(),
	email: text('email').notNull(),
	defaultOrgId: uuid('default_org_id').references(() => orgs.id, { onDelete: 'set null' }),
	createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const sites = pgTable(
	'sites',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		orgId: uuid('org_id')
			.references(() => orgs.id, { onDelete: 'cascade' })
			.notNull(),
		origin: text('origin').notNull(),
		displayName: text('display_name').notNull(),
		faviconUrl: text('favicon_url'),
		siteModel: jsonb('site_model'),
		siteModelStaleAfter: timestamp('site_model_stale_after'),
		createdAt: timestamp('created_at').defaultNow().notNull(),
	},
	(t) => ({
		orgOriginIdx: index('sites_org_origin_idx').on(t.orgId, t.origin),
	}),
);

export const cookieSnapshots = pgTable('cookie_snapshots', {
	id: uuid('id').primaryKey().defaultRandom(),
	orgId: uuid('org_id')
		.references(() => orgs.id, { onDelete: 'cascade' })
		.notNull(),
	siteId: uuid('site_id')
		.references(() => sites.id, { onDelete: 'cascade' })
		.notNull(),
	capturedByUserId: uuid('captured_by_user_id')
		.references(() => users.id, { onDelete: 'set null' })
		.notNull(),
	capturedAt: timestamp('captured_at').defaultNow().notNull(),
	origin: text('origin').notNull(),
	ciphertext: text('ciphertext').notNull(),
	nonce: text('nonce').notNull(),
	cookieDomains: jsonb('cookie_domains').$type<string[]>().notNull(),
	hasAuthCookie: boolean('has_auth_cookie').notNull(),
	expiresAtHint: timestamp('expires_at_hint'),
	supersededAt: timestamp('superseded_at'),
});

export const flows = pgTable('flows', {
	id: uuid('id').primaryKey().defaultRandom(),
	orgId: uuid('org_id')
		.references(() => orgs.id, { onDelete: 'cascade' })
		.notNull(),
	siteId: uuid('site_id')
		.references(() => sites.id, { onDelete: 'cascade' })
		.notNull(),
	createdByUserId: uuid('created_by_user_id')
		.references(() => users.id, { onDelete: 'set null' })
		.notNull(),
	name: text('name').notNull(),
	description: text('description'),
	source: text('source', { enum: ['recorded', 'ai_suggested', 'manual'] }).notNull(),
	preconditions: jsonb('preconditions').$type<string[]>().default([]).notNull(),
	postconditions: jsonb('postconditions').$type<string[]>().default([]).notNull(),
	fragilityHints: jsonb('fragility_hints').$type<string[]>().default([]).notNull(),
	steps: jsonb('steps').$type<FlowStep[]>().default([]).notNull(),
	rrwebBlobKey: text('rrweb_blob_key'),
	cookieSnapshotId: uuid('cookie_snapshot_id').references(() => cookieSnapshots.id, {
		onDelete: 'set null',
	}),
	buProfileId: text('bu_profile_id'),
	parentFlowId: uuid('parent_flow_id'),
	status: text('status', { enum: ['draft', 'compiling', 'ready', 'archived'] })
		.default('draft')
		.notNull(),
	createdAt: timestamp('created_at').defaultNow().notNull(),
	updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const recordings = pgTable('recordings', {
	id: uuid('id').primaryKey().defaultRandom(),
	flowId: uuid('flow_id')
		.references(() => flows.id, { onDelete: 'cascade' })
		.notNull(),
	startedAt: timestamp('started_at').defaultNow().notNull(),
	finishedAt: timestamp('finished_at'),
	rrwebChunks: jsonb('rrweb_chunks')
		.$type<{ blobKey: string; bytes: number; ordinal: number }[]>()
		.default([])
		.notNull(),
	actionStreamBlobKey: text('action_stream_blob_key'),
	viewport: jsonb('viewport').$type<{ w: number; h: number; dpr: number }>(),
	userAgent: text('user_agent'),
});

export const runs = pgTable(
	'runs',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		orgId: uuid('org_id')
			.references(() => orgs.id, { onDelete: 'cascade' })
			.notNull(),
		flowId: uuid('flow_id')
			.references(() => flows.id, { onDelete: 'cascade' })
			.notNull(),
		triggeredBy: text('triggered_by', {
			enum: ['user', 'schedule', 'webhook', 'sibling_chain'],
		}).notNull(),
		triggeredByUserId: uuid('triggered_by_user_id').references(() => users.id, {
			onDelete: 'set null',
		}),
		status: text('status', {
			enum: [
				'queued',
				'running',
				'paused_auth',
				'paused_user',
				'passed',
				'failed',
				'errored',
				'canceled',
			],
		})
			.default('queued')
			.notNull(),
		buSessionId: text('bu_session_id'),
		buCdpUrl: text('bu_cdp_url'),
		liveUrl: text('live_url'),
		publicShareToken: text('public_share_token'),
		startedAt: timestamp('started_at'),
		finishedAt: timestamp('finished_at'),
		durationMs: integer('duration_ms'),
		costUsdMicro: integer('cost_usd_micro'),
		workflowRunId: text('workflow_run_id'),
		healthScore: integer('health_score'),
		summary: text('summary'),
		errorClass: text('error_class', { enum: ['app_bug', 'flaky', 'env', 'auth'] }),
		cookieSnapshotId: uuid('cookie_snapshot_id').references(() => cookieSnapshots.id, {
			onDelete: 'set null',
		}),
		createdAt: timestamp('created_at').defaultNow().notNull(),
	},
	(t) => ({
		orgFlowIdx: index('runs_org_flow_idx').on(t.orgId, t.flowId),
		statusIdx: index('runs_status_idx').on(t.status),
	}),
);

export const stepResults = pgTable(
	'step_results',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		runId: uuid('run_id')
			.references(() => runs.id, { onDelete: 'cascade' })
			.notNull(),
		stepIndex: integer('step_index').notNull(),
		status: text('status', {
			enum: ['passed', 'failed', 'flaky', 'blocked_auth', 'inconclusive', 'skipped'],
		}).notNull(),
		startedAt: timestamp('started_at').notNull(),
		finishedAt: timestamp('finished_at'),
		durationMs: integer('duration_ms'),
		selectorResolvedVia: text('selector_resolved_via', {
			enum: ['testid', 'role-name', 'css', 'xpath', 'flowlens-id', 'llm', 'recorded-only'],
		}),
		replayScreenshotKey: text('replay_screenshot_key'),
		judge: jsonb('judge').$type<{ verdict: 'pass' | 'fail'; reason: string; confidence: number }>(),
		visualDiff: jsonb('visual_diff').$type<{
			score: number;
			threshold: number;
			passed: boolean;
			overlayKey: string;
		}>(),
		consoleErrors: jsonb('console_errors').$type<string[]>().default([]).notNull(),
		networkErrors: jsonb('network_errors')
			.$type<{ url: string; status: number }[]>()
			.default([])
			.notNull(),
		llmStepsUsed: integer('llm_steps_used').default(0).notNull(),
		llmCostUsdMicro: integer('llm_cost_usd_micro').default(0).notNull(),
		errorMessage: text('error_message'),
	},
	(t) => ({
		runStepIdx: index('step_results_run_step_idx').on(t.runId, t.stepIndex),
	}),
);

export const flowSchedules = pgTable('flow_schedules', {
	id: uuid('id').primaryKey().defaultRandom(),
	flowId: uuid('flow_id')
		.references(() => flows.id, { onDelete: 'cascade' })
		.notNull(),
	cron: text('cron').notNull(),
	enabled: boolean('enabled').default(true).notNull(),
	lastRunAt: timestamp('last_run_at'),
	nextRunAt: timestamp('next_run_at'),
});

export const notificationChannels = pgTable('notification_channels', {
	id: uuid('id').primaryKey().defaultRandom(),
	orgId: uuid('org_id')
		.references(() => orgs.id, { onDelete: 'cascade' })
		.notNull(),
	kind: text('kind', { enum: ['email', 'slack', 'webhook'] }).notNull(),
	config: jsonb('config').notNull(),
	failureOnly: boolean('failure_only').default(true).notNull(),
});
