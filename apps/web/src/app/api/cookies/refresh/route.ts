/**
 * POST /api/cookies/refresh — accept fresh cookies from the extension after
 * the user has re-authenticated on the site. Encrypt + persist + push to the
 * BU Cloud profile + signal any paused-auth workflow waiting on this flow.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { eq, and } from 'drizzle-orm';
import {
	ChromeCookieSchema,
	StorageSnapshotSchema,
} from '@flowlens/schema';
import { sealForOrg, hashAuthDomains, earliestCookieExpiry, syncCookiesToBuProfile } from '@flowlens/cookies-vault';
import { createBuClient } from '@flowlens/bu-cloud-client';
import { resumeHook } from 'workflow/api';
import { db } from '@/lib/db';
import { requireAuthContext, UnauthorizedError } from '@/lib/auth';
import { cookieSnapshots, sites, flows, runs } from '@flowlens/schema/db';
import { emitSseEvent } from '@/lib/sse-bus';

const RefreshRequestSchema = z.object({
	siteOrigin: z.string().url(),
	cookies: z.array(ChromeCookieSchema),
	storage: StorageSnapshotSchema,
	triggeredByRunId: z.string().uuid().optional(),
});

export async function POST(req: NextRequest) {
	try {
		const auth = await requireAuthContext();
		const body = RefreshRequestSchema.parse(await req.json());

		const site = await db.query.sites.findFirst({
			where: and(eq(sites.orgId, auth.org.id), eq(sites.origin, body.siteOrigin)),
		});
		if (!site) return NextResponse.json({ error: 'site not found in your org' }, { status: 404 });

		const vaultSecret = process.env.FLOWLENS_VAULT_SECRET;
		if (!vaultSecret) {
			return NextResponse.json({ error: 'FLOWLENS_VAULT_SECRET not configured' }, { status: 500 });
		}
		const sealed = await sealForOrg({
			orgId: auth.org.id,
			vaultSecret,
			plaintext: JSON.stringify({ cookies: body.cookies, storage: body.storage }),
		});
		const { domains, hasAuthCookie } = hashAuthDomains(body.cookies);
		const earliest = earliestCookieExpiry(body.cookies);
		const [snap] = await db
			.insert(cookieSnapshots)
			.values({
				orgId: auth.org.id,
				siteId: site.id,
				capturedByUserId: auth.user.id,
				origin: body.siteOrigin,
				ciphertext: sealed.ciphertext,
				nonce: sealed.nonce,
				cookieDomains: domains,
				hasAuthCookie,
				...(earliest ? { expiresAtHint: earliest } : {}),
			})
			.returning();
		if (!snap) throw new Error('failed to persist cookie snapshot');

		// Mark older snapshots for this site as superseded.
		await db
			.update(cookieSnapshots)
			.set({ supersededAt: new Date() })
			.where(and(eq(cookieSnapshots.siteId, site.id), eq(cookieSnapshots.supersededAt, null as never)));

		// Push cookies to BU profile.
		let buProfileUpdated = false;
		if (process.env.BROWSER_USE_API_KEY && body.triggeredByRunId) {
			const run = await db.query.runs.findFirst({ where: eq(runs.id, body.triggeredByRunId) });
			if (run) {
				const flow = await db.query.flows.findFirst({ where: eq(flows.id, run.flowId) });
				if (flow) {
					try {
						const bu = createBuClient();
						const sync = await syncCookiesToBuProfile({
							bu,
							flowId: flow.id,
							siteOrigin: body.siteOrigin,
							existingProfileId: flow.buProfileId,
						});
						buProfileUpdated = true;
						if (!flow.buProfileId) {
							await db
								.update(flows)
								.set({ buProfileId: sync.profileId })
								.where(eq(flows.id, flow.id));
						}
					} catch (err) {
						console.warn('[cookies/refresh] BU profile sync failed', err);
					}
				}
			}
		}

		// Signal any paused-auth workflow waiting on this run.
		let runResumed = false;
		if (body.triggeredByRunId) {
			const run = await db.query.runs.findFirst({ where: eq(runs.id, body.triggeredByRunId) });
			if (run?.status === 'paused_auth') {
				// resumeHook fires the deterministic-token hook the workflow created
				// at `run:${runId}:auth-refreshed`. The workflow then proceeds with
				// the post-refresh branch (re-queue + emit run_resumed). We don't
				// flip the DB status or emit SSE here — the workflow owns both,
				// keeping state transitions in one place.
				try {
					await resumeHook(`run:${run.id}:auth-refreshed`, { refreshed: true });
					runResumed = true;
				} catch (err) {
					// Hook may have already timed out (>24h) or been disposed.
					// Fall back to the Phase 3 status flip so the user gets feedback.
					console.warn('[cookies/refresh] resumeHook failed', err);
					await db.update(runs).set({ status: 'queued' }).where(eq(runs.id, run.id));
					await emitSseEvent(`run:${run.id}`, { type: 'run_resumed', runId: run.id });
				}
			}
		}

		return NextResponse.json({
			cookieSnapshotId: snap.id,
			buProfileUpdated,
			runResumed,
		});
	} catch (err) {
		if (err instanceof UnauthorizedError) {
			return NextResponse.json({ error: err.message }, { status: 401 });
		}
		if (err instanceof z.ZodError) {
			return NextResponse.json({ error: 'invalid', issues: err.issues }, { status: 400 });
		}
		console.error('[POST /api/cookies/refresh]', err);
		return NextResponse.json({ error: (err as Error).message }, { status: 500 });
	}
}
