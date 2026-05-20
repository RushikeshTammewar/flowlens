/**
 * POST /api/recordings/start
 *
 * Creates a draft Flow + Recording for the authenticated org and returns
 * the IDs the extension needs to start uploading chunks.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { eq, and } from 'drizzle-orm';
import { db } from '@/lib/db';
import { requireAuthContext, UnauthorizedError } from '@/lib/auth';
import { sites, flows, recordings, orgs } from '@flowlens/schema/db';
import { isPhase4Enabled } from '@/lib/feature-flags';

const StartRequestSchema = z.object({
	siteOrigin: z.string().url(),
	displayName: z.string().min(1).max(200),
	viewport: z.object({
		w: z.number().int().positive(),
		h: z.number().int().positive(),
		dpr: z.number().positive(),
	}),
	userAgent: z.string().max(500),
});

export async function POST(req: NextRequest) {
	try {
		const ctx = await requireAuthContext();
		const json = (await req.json()) as unknown;
		const body = StartRequestSchema.parse(json);

		// Phase 4 / Tier 4 — free-tier feature cap. Each successfully
		// COMPILED flow counts as one feature toward `monthlyFeatureCap`.
		// We pre-check at recording start so the user gets a clean 402
		// before they invest in the recording (rather than after compile,
		// which would feel like a bait-and-switch). The actual increment
		// happens in compile-inline.ts on successful compile.
		//
		// Pro / team plans bypass the gate (cap is informational, not
		// enforced). Free orgs get 3 features/month by default (see
		// orgs.monthlyFeatureCap). Reset is monthly via the existing
		// monthlyRunsResetAt timestamp on the orgs row.
		if (isPhase4Enabled() && ctx.org.plan === 'free') {
			const orgRow = await db.query.orgs.findFirst({
				where: eq(orgs.id, ctx.org.id),
			});
			if (orgRow) {
				const cap = orgRow.monthlyFeatureCap ?? 3;
				const used = orgRow.monthlyFeaturesConsumed ?? 0;
				if (used >= cap) {
					console.warn(
						`[phase4:free-tier] recording.start blocked org=${ctx.org.id} used=${used} cap=${cap}`,
					);
					return NextResponse.json(
						{
							error: 'feature cap reached',
							code: 'free_tier_feature_cap',
							used,
							cap,
							message: `Free plan allows ${cap} features per month. Upgrade to add more.`,
						},
						{ status: 402 },
					);
				}
			}
		}

		// Ensure site row exists for this org+origin.
		const existingSite = await db.query.sites.findFirst({
			where: and(eq(sites.orgId, ctx.org.id), eq(sites.origin, body.siteOrigin)),
		});
		const siteRow = existingSite
			? existingSite
			: await db
					.insert(sites)
					.values({
						orgId: ctx.org.id,
						origin: body.siteOrigin,
						displayName: hostFromOrigin(body.siteOrigin),
					})
					.returning()
					.then((rows) => rows[0]);
		if (!siteRow) throw new Error('Failed to upsert site');

		const [flowRow] = await db
			.insert(flows)
			.values({
				orgId: ctx.org.id,
				siteId: siteRow.id,
				createdByUserId: ctx.user.id,
				name: body.displayName,
				source: 'recorded',
				steps: [],
				status: 'draft',
			})
			.returning();
		if (!flowRow) throw new Error('Failed to insert flow');

		const [recordingRow] = await db
			.insert(recordings)
			.values({
				flowId: flowRow.id,
				viewport: body.viewport,
				userAgent: body.userAgent,
			})
			.returning();
		if (!recordingRow) throw new Error('Failed to insert recording');

		return NextResponse.json({
			recordingId: recordingRow.id,
			flowId: flowRow.id,
			siteId: siteRow.id,
			uploadKeyPrefix: `recordings/${recordingRow.id}`,
		});
	} catch (err) {
		if (err instanceof UnauthorizedError) return NextResponse.json({ error: err.message }, { status: 401 });
		if (err instanceof z.ZodError) return NextResponse.json({ error: 'invalid request', issues: err.issues }, { status: 400 });
		console.error('[POST /api/recordings/start]', err);
		return NextResponse.json({ error: (err as Error).message }, { status: 500 });
	}
}

function hostFromOrigin(origin: string): string {
	try {
		return new URL(origin).host;
	} catch {
		return origin;
	}
}
