/**
 * GET /api/flows?siteId=...&status=ready,draft,compiling
 * Lists flows for the calling org, optionally filtered by site or status.
 *
 * Phase 4 / Tier 4 — response also carries an `orgMeta` block exposing the
 * monthly feature cap + consumed counter so the side panel can show
 * "2/3 features used this month" without a separate /api/me call.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { and, eq, inArray, desc } from 'drizzle-orm';
import { db } from '@/lib/db';
import { requireAuthContext, UnauthorizedError } from '@/lib/auth';
import { flows, orgs } from '@flowlens/schema/db';

const VALID_STATUSES = new Set(['draft', 'compiling', 'ready', 'archived'] as const);

export async function GET(req: NextRequest) {
	try {
		const auth = await requireAuthContext();
		const url = new URL(req.url);
		const siteId = url.searchParams.get('siteId');
		const statusParam = url.searchParams.get('status');
		const statuses =
			statusParam
				?.split(',')
				.map((s) => s.trim())
				.filter((s): s is 'draft' | 'compiling' | 'ready' | 'archived' =>
					VALID_STATUSES.has(s as 'draft'),
				) ?? null;

		const conditions = [eq(flows.orgId, auth.org.id)];
		if (siteId) conditions.push(eq(flows.siteId, siteId));
		if (statuses && statuses.length > 0) conditions.push(inArray(flows.status, statuses));

		const [rows, orgRow] = await Promise.all([
			db
				.select()
				.from(flows)
				.where(and(...conditions))
				.orderBy(desc(flows.updatedAt))
				.limit(200),
			db.query.orgs.findFirst({ where: eq(orgs.id, auth.org.id) }),
		]);

		return NextResponse.json({
			flows: rows,
			orgMeta: orgRow
				? {
						plan: orgRow.plan,
						monthlyFeatureCap: orgRow.monthlyFeatureCap,
						monthlyFeaturesConsumed: orgRow.monthlyFeaturesConsumed,
						capacityRemaining: Math.max(
							0,
							(orgRow.monthlyFeatureCap ?? 0) - (orgRow.monthlyFeaturesConsumed ?? 0),
						),
					}
				: null,
		});
	} catch (err) {
		if (err instanceof UnauthorizedError) return NextResponse.json({ error: err.message }, { status: 401 });
		console.error('[GET /api/flows]', err);
		return NextResponse.json({ error: (err as Error).message }, { status: 500 });
	}
}
