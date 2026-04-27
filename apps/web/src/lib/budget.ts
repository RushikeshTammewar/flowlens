/**
 * Per-org monthly run budget enforcement + BU Cloud account circuit breaker.
 *
 * Called before starting any run. Throws `BudgetExceededError` if the org has
 * blown through its monthly cap, or `CircuitOpenError` if the BU Cloud
 * platform balance is below 10%.
 */
import { eq } from 'drizzle-orm';
import { createBuClient } from '@flowlens/bu-cloud-client';
import { db } from './db';
import { orgs } from '@flowlens/schema/db';

export class BudgetExceededError extends Error {
	constructor(public readonly orgId: string, public readonly consumed: number, public readonly cap: number) {
		super(`monthly run budget exhausted: ${consumed} / ${cap} microdollars`);
		this.name = 'BudgetExceededError';
	}
}

export class CircuitOpenError extends Error {
	constructor(public readonly remaining: number) {
		super(`BU Cloud account at <10%% credit balance ($${remaining.toFixed(2)} remaining)`);
		this.name = 'CircuitOpenError';
	}
}

const UPPER_GUARDRAIL_USD_MICRO_PER_RUN = 140_000; // $0.14 — see HLD §11

/**
 * Reserve budget for an upcoming run. Atomically checks + increments.
 * Caller is responsible for refunding via `refundBudget` if the run errors out.
 */
export async function reserveRunBudget(orgId: string): Promise<{ reserved: number }> {
	const org = await db.query.orgs.findFirst({ where: eq(orgs.id, orgId) });
	if (!org) throw new Error(`org ${orgId} not found`);

	if (org.monthlyRunsConsumedUsdMicro + UPPER_GUARDRAIL_USD_MICRO_PER_RUN > org.monthlyRunBudgetUsdMicro) {
		throw new BudgetExceededError(orgId, org.monthlyRunsConsumedUsdMicro, org.monthlyRunBudgetUsdMicro);
	}

	await db
		.update(orgs)
		.set({
			monthlyRunsConsumedUsdMicro: org.monthlyRunsConsumedUsdMicro + UPPER_GUARDRAIL_USD_MICRO_PER_RUN,
		})
		.where(eq(orgs.id, orgId));

	return { reserved: UPPER_GUARDRAIL_USD_MICRO_PER_RUN };
}

/** After a run ends, refund the difference between the reservation and actual spend. */
export async function refundBudget(orgId: string, actualUsdMicro: number, reserved: number): Promise<void> {
	const refund = Math.max(0, reserved - actualUsdMicro);
	if (refund === 0) return;
	const org = await db.query.orgs.findFirst({ where: eq(orgs.id, orgId) });
	if (!org) return;
	await db
		.update(orgs)
		.set({ monthlyRunsConsumedUsdMicro: Math.max(0, org.monthlyRunsConsumedUsdMicro - refund) })
		.where(eq(orgs.id, orgId));
}

/**
 * BU Cloud circuit breaker. Polled hourly by a separate cron; the result is
 * cached in-memory for cheap per-request checks.
 */
let _lastCircuitCheck: { at: number; remaining: number } | null = null;
const CIRCUIT_CHECK_TTL_MS = 5 * 60 * 1000;

export async function assertBuCloudCircuit(): Promise<void> {
	const now = Date.now();
	if (_lastCircuitCheck && now - _lastCircuitCheck.at < CIRCUIT_CHECK_TTL_MS) {
		if (_lastCircuitCheck.remaining < 0.1) {
			throw new CircuitOpenError(_lastCircuitCheck.remaining);
		}
		return;
	}
	if (!process.env.BROWSER_USE_API_KEY) {
		_lastCircuitCheck = { at: now, remaining: 1.0 };
		return;
	}
	try {
		const bu = createBuClient();
		const account = await bu.getAccount();
		_lastCircuitCheck = { at: now, remaining: account.totalCreditsBalanceUsd };
		// We treat the absolute balance as the circuit signal. Tune as we learn.
		if (account.totalCreditsBalanceUsd < 1.0) {
			throw new CircuitOpenError(account.totalCreditsBalanceUsd);
		}
	} catch (err) {
		if (err instanceof CircuitOpenError) throw err;
		// Treat probe failure as open to avoid orphan runs we can't bill.
		_lastCircuitCheck = { at: now, remaining: 0 };
		throw new CircuitOpenError(0);
	}
}
