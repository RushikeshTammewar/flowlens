/**
 * Server-side auth helpers. Reads the Clerk session from the current request,
 * upserts the corresponding org + user rows in our DB on first hit, and
 * returns the normalized `{ user, org }` for use in route handlers.
 *
 * On every request we DO NOT hit Clerk's API — the middleware already
 * verified the JWT and `auth()` reads it from the request context. The DB
 * upsert is idempotent and effectively free after the first call per user.
 *
 * # Demo mode
 *
 * If `FLOWLENS_DEMO_MODE=true` AND the request carries
 * `Authorization: Bearer flowlens-demo-${FLOWLENS_DEMO_BEARER}`, we bypass
 * Clerk entirely and return a stable `{ user, org }` for a singleton demo
 * org. This is gated by an env var that ships ONLY when we want public
 * zero-friction beta access; production-with-real-customers leaves it off.
 */
import { auth, currentUser } from '@clerk/nextjs/server';
import { eq } from 'drizzle-orm';
import { headers } from 'next/headers';
import { db } from './db';
import { orgs, users } from '@flowlens/schema/db';

const DEMO_CLERK_USER_ID = 'demo:flowlens-public';
const DEMO_CLERK_ORG_ID = 'demo:flowlens-public-org';
const DEMO_EMAIL = 'demo@flowlens.local';

export interface AuthContext {
	user: { id: string; email: string; clerkUserId: string };
	org: { id: string; clerkOrgId: string; plan: 'free' | 'pro' | 'team' };
}

export class UnauthorizedError extends Error {
	constructor(reason: string) {
		super(`Unauthorized: ${reason}`);
		this.name = 'UnauthorizedError';
	}
}

/**
 * Resolve the Clerk session into a `{ user, org }` pair. Idempotently upserts
 * org + user rows. If Clerk has no `orgId` (i.e. the user has no active org),
 * we lazily provision a personal org named `${email}'s workspace`.
 *
 * If demo mode is enabled and the request carries the demo bearer, returns
 * the singleton demo `{ user, org }` instead.
 */
export async function requireAuthContext(): Promise<AuthContext> {
	// Demo-mode bypass — env-gated, opt-in, ships zero-friction beta access.
	const demoCtx = await tryDemoBypass();
	if (demoCtx) return demoCtx;

	const sess = await auth();
	const clerkUserId = sess.userId;
	if (!clerkUserId) throw new UnauthorizedError('no Clerk user session');

	const cu = await currentUser();
	const primaryEmail =
		cu?.emailAddresses.find((e) => e.id === cu.primaryEmailAddressId)?.emailAddress ??
		cu?.emailAddresses[0]?.emailAddress ??
		`${clerkUserId}@unknown`;

	let clerkOrgId = sess.orgId;

	const orgRow = clerkOrgId
		? await ensureOrg({ clerkOrgId, name: sess.orgSlug ?? clerkOrgId })
		: await ensurePersonalOrg({ clerkUserId, email: primaryEmail });

	clerkOrgId = orgRow.clerkOrgId;

	const userRow = await ensureUser({
		clerkUserId,
		email: primaryEmail,
		defaultOrgId: orgRow.id,
	});

	return {
		user: { id: userRow.id, email: userRow.email, clerkUserId },
		org: { id: orgRow.id, clerkOrgId: orgRow.clerkOrgId, plan: orgRow.plan },
	};
}

/**
 * Demo-mode bypass: matches `Authorization: Bearer flowlens-demo-${FLOWLENS_DEMO_BEARER}`
 * against the env-configured token, lazy-upserts a singleton demo user+org,
 * and returns the AuthContext. Returns `null` if demo mode is off, the bearer
 * is absent, or the bearer doesn't match.
 *
 * Token shape: `flowlens-demo-<random-hex>` — the `flowlens-demo-` prefix is
 * a tag to distinguish demo bearers from Clerk JWTs in logs and from
 * `REPLAY_WORKER_SHARED_SECRET` (which never has this prefix).
 */
async function tryDemoBypass(): Promise<AuthContext | null> {
	if (process.env.FLOWLENS_DEMO_MODE !== 'true') return null;
	const expected = process.env.FLOWLENS_DEMO_BEARER;
	if (!expected) return null;

	const hdrs = await headers();
	const authHeader = hdrs.get('authorization') ?? hdrs.get('Authorization');
	if (!authHeader || !authHeader.toLowerCase().startsWith('bearer ')) return null;
	const presented = authHeader.slice(7).trim();
	const expectedFull = `flowlens-demo-${expected}`;
	// Constant-time-ish comparison.
	if (presented.length !== expectedFull.length) return null;
	let diff = 0;
	for (let i = 0; i < presented.length; i++) {
		diff |= presented.charCodeAt(i) ^ expectedFull.charCodeAt(i);
	}
	if (diff !== 0) return null;

	const orgRow = await ensureOrg({
		clerkOrgId: DEMO_CLERK_ORG_ID,
		name: 'Flowlens demo workspace',
	});
	const userRow = await ensureUser({
		clerkUserId: DEMO_CLERK_USER_ID,
		email: DEMO_EMAIL,
		defaultOrgId: orgRow.id,
	});
	return {
		user: { id: userRow.id, email: userRow.email, clerkUserId: DEMO_CLERK_USER_ID },
		org: { id: orgRow.id, clerkOrgId: orgRow.clerkOrgId, plan: orgRow.plan },
	};
}

async function ensureOrg(input: { clerkOrgId: string; name: string }) {
	const existing = await db.query.orgs.findFirst({ where: eq(orgs.clerkOrgId, input.clerkOrgId) });
	if (existing) return existing;
	const [created] = await db
		.insert(orgs)
		.values({ clerkOrgId: input.clerkOrgId, name: input.name })
		.returning();
	if (!created) throw new Error('Failed to insert org');
	return created;
}

async function ensurePersonalOrg(input: { clerkUserId: string; email: string }) {
	const personalClerkOrgId = `personal:${input.clerkUserId}`;
	const existing = await db.query.orgs.findFirst({
		where: eq(orgs.clerkOrgId, personalClerkOrgId),
	});
	if (existing) return existing;
	const [created] = await db
		.insert(orgs)
		.values({
			clerkOrgId: personalClerkOrgId,
			name: `${input.email}'s workspace`,
		})
		.returning();
	if (!created) throw new Error('Failed to insert personal org');
	return created;
}

async function ensureUser(input: { clerkUserId: string; email: string; defaultOrgId: string }) {
	const existing = await db.query.users.findFirst({ where: eq(users.clerkUserId, input.clerkUserId) });
	if (existing) {
		if (existing.defaultOrgId !== input.defaultOrgId) {
			await db.update(users).set({ defaultOrgId: input.defaultOrgId }).where(eq(users.id, existing.id));
			return { ...existing, defaultOrgId: input.defaultOrgId };
		}
		return existing;
	}
	const [created] = await db
		.insert(users)
		.values({
			clerkUserId: input.clerkUserId,
			email: input.email,
			defaultOrgId: input.defaultOrgId,
		})
		.returning();
	if (!created) throw new Error('Failed to insert user');
	return created;
}
