/**
 * Server-side auth helpers. Reads the Clerk session from the current request,
 * upserts the corresponding org + user rows in our DB on first hit, and
 * returns the normalized `{ user, org }` for use in route handlers.
 *
 * On every request we DO NOT hit Clerk's API — the middleware already
 * verified the JWT and `auth()` reads it from the request context. The DB
 * upsert is idempotent and effectively free after the first call per user.
 */
import { auth, currentUser } from '@clerk/nextjs/server';
import { eq } from 'drizzle-orm';
import { db } from './db';
import { orgs, users } from '@flowlens/schema/db';

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
 */
export async function requireAuthContext(): Promise<AuthContext> {
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
