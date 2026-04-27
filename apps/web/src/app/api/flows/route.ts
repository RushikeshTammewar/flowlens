/**
 * GET /api/flows?siteId=...&status=ready,draft,compiling
 * Lists flows for the calling org, optionally filtered by site or status.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { and, eq, inArray, desc } from 'drizzle-orm';
import { db } from '@/lib/db';
import { requireAuthContext, UnauthorizedError } from '@/lib/auth';
import { flows } from '@flowlens/schema/db';

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

		const rows = await db
			.select()
			.from(flows)
			.where(and(...conditions))
			.orderBy(desc(flows.updatedAt))
			.limit(200);
		return NextResponse.json({ flows: rows });
	} catch (err) {
		if (err instanceof UnauthorizedError) return NextResponse.json({ error: err.message }, { status: 401 });
		console.error('[GET /api/flows]', err);
		return NextResponse.json({ error: (err as Error).message }, { status: 500 });
	}
}
