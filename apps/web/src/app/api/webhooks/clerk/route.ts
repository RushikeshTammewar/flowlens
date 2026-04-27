/**
 * Clerk webhook handler. Verifies the request via svix and upserts
 * users/orgs in our DB so we don't have to do it lazily on every API call.
 *
 * Required env: CLERK_WEBHOOK_SIGNING_SECRET (from Clerk dashboard → Webhooks).
 * Required Clerk events: user.created, user.updated, organization.created,
 * organization.updated, organization.deleted, user.deleted.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { Webhook } from 'svix';
import { eq } from 'drizzle-orm';
import { db } from '@/lib/db';
import { orgs, users } from '@flowlens/schema/db';

interface ClerkUserEvent {
	type: 'user.created' | 'user.updated' | 'user.deleted';
	data: {
		id: string;
		email_addresses?: Array<{ id: string; email_address: string }>;
		primary_email_address_id?: string;
	};
}
interface ClerkOrgEvent {
	type: 'organization.created' | 'organization.updated' | 'organization.deleted';
	data: { id: string; name?: string; slug?: string };
}
type ClerkEvent = ClerkUserEvent | ClerkOrgEvent;

export async function POST(req: NextRequest) {
	const secret = process.env.CLERK_WEBHOOK_SIGNING_SECRET;
	if (!secret) {
		return NextResponse.json({ error: 'CLERK_WEBHOOK_SIGNING_SECRET not configured' }, { status: 500 });
	}

	const headers: Record<string, string> = {};
	for (const [k, v] of req.headers.entries()) headers[k.toLowerCase()] = v;
	const body = await req.text();

	let evt: ClerkEvent;
	try {
		evt = new Webhook(secret).verify(body, headers) as ClerkEvent;
	} catch (err) {
		return NextResponse.json({ error: 'invalid signature', detail: (err as Error).message }, { status: 401 });
	}

	switch (evt.type) {
		case 'user.created':
		case 'user.updated': {
			const data = evt.data;
			const email =
				data.email_addresses?.find((e) => e.id === data.primary_email_address_id)?.email_address ??
				data.email_addresses?.[0]?.email_address ??
				`${data.id}@unknown`;
			const existing = await db.query.users.findFirst({ where: eq(users.clerkUserId, data.id) });
			if (existing) {
				await db.update(users).set({ email }).where(eq(users.id, existing.id));
			} else {
				await db.insert(users).values({ clerkUserId: data.id, email });
			}
			break;
		}
		case 'user.deleted': {
			await db.delete(users).where(eq(users.clerkUserId, evt.data.id));
			break;
		}
		case 'organization.created':
		case 'organization.updated': {
			const data = evt.data;
			const name = data.name ?? data.slug ?? data.id;
			const existing = await db.query.orgs.findFirst({ where: eq(orgs.clerkOrgId, data.id) });
			if (existing) {
				await db.update(orgs).set({ name }).where(eq(orgs.id, existing.id));
			} else {
				await db.insert(orgs).values({ clerkOrgId: data.id, name });
			}
			break;
		}
		case 'organization.deleted': {
			await db.delete(orgs).where(eq(orgs.clerkOrgId, evt.data.id));
			break;
		}
	}

	return NextResponse.json({ ok: true });
}
