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
import type { IntentReport, VariantTestData } from './intent';
// Phase 4 / Tier 1 — additive jsonb payload typings. Imported as types so
// the runtime drizzle module graph is unchanged.
// Feature flag: FLOWLENS_PHASE4_ENABLED
// Migration item (LLD §19): rows 2, 4, 9 (jsonb columns); row 6 also reads
// AssertionEval into the sidecar contract (Tier 3).
import type { FeatureContract } from './feature-contract';
import type { Assertion, AssertionEval } from './assertion';
import type { BehaviorVerdict } from './behavior-verdict';

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
	// Test-Matrix budget caps (Phase 3.5c). Default $0.50 per matrix-gen call,
	// $2.00 per batch run. Surfaced in the run report and enforced server-side
	// before kicking off the o3 / batch fan-out.
	matrixGenBudgetUsdMicro: integer('matrix_gen_budget_usd_micro').default(500_000).notNull(),
	matrixBatchBudgetUsdMicro: integer('matrix_batch_budget_usd_micro').default(2_000_000).notNull(),
	// Phase 4 / Tier 1 (LLD §19 row 1) — free-tier feature cap. Reuses
	// `monthlyRunsResetAt` above for the rollover timestamp; introduces its
	// own counter so a flow's RUN budget and its FEATURE budget are
	// independently throttled. Default 3 features/month for free orgs.
	monthlyFeatureCap: integer('monthly_feature_cap').default(3).notNull(),
	monthlyFeaturesConsumed: integer('monthly_features_consumed').default(0).notNull(),
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
	// Phase 3.5c: schema version of the encrypted plaintext payload.
	//   0 = legacy `{ cookies, storage }`
	//   1 = `RichStateSnapshot` (cookies + storage + IndexedDB + UA-CH + ...)
	// The injection layer reads this to know how to decode + apply.
	stateSnapshotVersion: integer('state_snapshot_version').default(0).notNull(),
	// Public diagnostics about what the rich snapshot contains, so we can
	// list "captured 4 IndexedDB databases · 1 service worker · UA hints"
	// without decrypting the payload.
	stateSnapshotMeta: jsonb('state_snapshot_meta').$type<{
		idbDatabaseCount?: number;
		idbStoreCount?: number;
		idbRecordCount?: number;
		serviceWorkerCount?: number;
		hasUserAgentClientHints?: boolean;
		hasLocale?: boolean;
		hasPermissions?: boolean;
		captureErrorCount?: number;
		bytes?: number;
	}>(),
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
	// Phase 3.5c: structured IntentReport from o3 reasoning classifier.
	// Drives intent-aware variant generation + variant-aware T3 judging.
	intentReport: jsonb('intent_report').$type<IntentReport>(),
	// Phase 4 / Tier 1 (LLD §19 row 2) — structured FeatureContract that
	// supersedes `description` for the new compile pipeline. NULL on
	// legacy flows; readers fall back to `description` when null.
	featureContract: jsonb('feature_contract').$type<FeatureContract>(),
	// Cumulative LLM cost spent on the matrix pipeline for THIS flow
	// (intent classify + variant gen + per-variant data gen). Enforced
	// against orgs.matrixGenBudgetUsdMicro before each call.
	matrixGenCostUsdMicro: integer('matrix_gen_cost_usd_micro').default(0).notNull(),
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
		// Test-matrix support: when a run is part of a batch, both fields are set.
		// `batchId` references the parent run_batches row; `variantId` references
		// the test_variants row whose field overrides were applied to this run.
		// Plain runs leave both null.
		batchId: uuid('batch_id'),
		variantId: uuid('variant_id'),
		triggeredBy: text('triggered_by', {
			enum: ['user', 'schedule', 'webhook', 'sibling_chain', 'matrix_batch'],
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
		batchIdx: index('runs_batch_idx').on(t.batchId),
	}),
);

// ─── Test Matrix (Phase 3.5b) ──────────────────────────────────────────────
// Per LLD §18.1: o3 generates N adversarial variants per flow; replay fans
// out N runs linked by `runBatchId`; per-variant `expectedOutcome` drives
// the T3 judge. Schema additions below + `runs.batchId/variantId` above.

export interface VariantExpectedOutcome {
	kind: 'success' | 'validation_error' | 'rejection' | 'silent_acceptance_unsafe';
	criteria?: string;
	messageContains?: string[];
}

export const testVariants = pgTable(
	'test_variants',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		flowId: uuid('flow_id')
			.references(() => flows.id, { onDelete: 'cascade' })
			.notNull(),
		family: text('family', {
			enum: [
				'happy_path',
				'boundary',
				'format',
				'encoding',
				'adversarial',
				'locale',
				'state',
				'auth',
			],
		}).notNull(),
		name: text('name').notNull(),
		description: text('description').notNull(),
		rationale: text('rationale'),
		expectedOutcome: jsonb('expected_outcome').$type<VariantExpectedOutcome>().notNull(),
		// Map of recorded-step-index → override value. e.g. { "2": "@@@invalid@@@" }.
		// String map keeps schema simple; richer types (numbers, JSON) can be
		// JSON-encoded here and decoded by the replay path.
		fieldOverrides: jsonb('field_overrides').$type<Record<string, string>>().notNull(),
		fragility: text('fragility', { enum: ['low', 'medium', 'high'] }).notNull(),
		enabled: boolean('enabled').default(true).notNull(),
		generatedBy: text('generated_by').notNull(),
		// Phase 3.5c: o4-mini-generated test data + rationale per overridden
		// field. Variant gen describes "what to test"; this stores "the
		// concrete hostile string we feed in".
		testData: jsonb('test_data').$type<VariantTestData>(),
		// Phase 4 / Tier 1 (LLD §19 row 4) — 4-mode variant metadata. All
		// nullable so legacy variants (generated before the new matrix path
		// shipped) keep working; matrix-gen v2 populates them. `family`
		// above stays for back-compat. `behaviorId` is a soft FK to
		// `flow.featureContract.expectedBehaviors[].id` — no DB constraint
		// because the contract is stored as jsonb. `shouldPass` defaults
		// true so a variant without explicit polarity is treated as a
		// positive (verify) case.
		mode: text('mode', {
			enum: ['verify', 'edge', 'stress', 'adversarial', 'invariant'],
		}),
		behaviorId: text('behavior_id'),
		assertion: jsonb('assertion').$type<Assertion>(),
		shouldPass: boolean('should_pass').default(true).notNull(),
		riskHypothesis: text('risk_hypothesis'),
		createdAt: timestamp('created_at').defaultNow().notNull(),
	},
	(t) => ({
		flowIdx: index('test_variants_flow_idx').on(t.flowId),
	}),
);

export const runBatches = pgTable(
	'run_batches',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		orgId: uuid('org_id')
			.references(() => orgs.id, { onDelete: 'cascade' })
			.notNull(),
		flowId: uuid('flow_id')
			.references(() => flows.id, { onDelete: 'cascade' })
			.notNull(),
		triggeredBy: text('triggered_by', {
			enum: ['user', 'schedule'],
		}).notNull(),
		triggeredByUserId: uuid('triggered_by_user_id').references(() => users.id, {
			onDelete: 'set null',
		}),
		variantIds: jsonb('variant_ids').$type<string[]>().notNull(),
		parallelism: integer('parallelism').notNull(),
		status: text('status', {
			enum: ['queued', 'running', 'completed', 'errored'],
		})
			.default('queued')
			.notNull(),
		startedAt: timestamp('started_at'),
		finishedAt: timestamp('finished_at'),
		costUsdMicro: integer('cost_usd_micro'),
		// Snapshot of the org's matrix budget at batch start, so we can show
		// "spent $0.43 of $2.00 cap" in the UI without a join.
		budgetCapUsdMicro: integer('budget_cap_usd_micro'),
		aiClusterSummary: text('ai_cluster_summary'),
		// Phase 4 / Tier 1 (LLD §19 row 9) — two-axis verdict aggregation.
		// `behaviorVerdicts` is the per-behavior rollup the report renders
		// row-by-row; the four `*_verified_count`/`*_total_count` integers
		// are the headline pill ("Correctness 9/9 · Robustness 23/27").
		// Default 0/null so legacy batches (no contract) still load; the
		// aggregator (Tier 4) populates them at batch completion.
		behaviorVerdicts: jsonb('behavior_verdicts').$type<BehaviorVerdict[]>(),
		correctnessVerifiedCount: integer('correctness_verified_count').default(0).notNull(),
		correctnessTotalCount: integer('correctness_total_count').default(0).notNull(),
		robustnessVerifiedCount: integer('robustness_verified_count').default(0).notNull(),
		robustnessTotalCount: integer('robustness_total_count').default(0).notNull(),
		createdAt: timestamp('created_at').defaultNow().notNull(),
	},
	(t) => ({
		orgFlowIdx: index('run_batches_org_flow_idx').on(t.orgId, t.flowId),
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
		// Phase 3.5c: judge now stores a four-quadrant verdict so we can
		// distinguish security bugs (silent acceptance of bad input) from
		// false-rejections of valid edge cases.
		//   pass.correct_rejection   — bad input correctly refused
		//   pass.correct_acceptance  — valid edge correctly accepted
		//   fail.incorrect_acceptance — bad input was silently accepted (BUG)
		//   fail.incorrect_rejection — valid edge was wrongly refused (BUG)
		//   inconclusive — not enough evidence
		judge: jsonb('judge').$type<{
			verdict: 'pass' | 'fail' | 'inconclusive';
			quadrant?:
				| 'correct_rejection'
				| 'correct_acceptance'
				| 'incorrect_acceptance'
				| 'incorrect_rejection'
				| 'inconclusive';
			reason: string;
			confidence: number;
		}>(),
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
		// Phase 4 / Tier 1 (LLD §19 row 6) — per-step assertion eval. NULL
		// for steps whose variant carries no step-targeted assertion (which
		// is every legacy step). The sidecar (Tier 3) writes this when the
		// assertion engine runs against a single step's CDP capture.
		assertionEval: jsonb('assertion_eval').$type<AssertionEval>(),
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
