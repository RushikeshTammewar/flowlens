/**
 * GET    /api/flows/:id   — fetch a single flow (org-scoped)
 * DELETE /api/flows/:id   — soft-delete (status = 'archived')
 * PATCH  /api/flows/:id   — limited edits: name, description, steps[].intent/expected/isCritical
 */
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { FlowStepSchema } from '@flowlens/schema';
import { db } from '@/lib/db';
import { requireAuthContext, UnauthorizedError } from '@/lib/auth';
import { flows } from '@flowlens/schema/db';

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
	try {
		const auth = await requireAuthContext();
		const { id } = await ctx.params;
		const flow = await db.query.flows.findFirst({ where: eq(flows.id, id) });
		if (!flow || flow.orgId !== auth.org.id) {
			return NextResponse.json({ error: 'not found' }, { status: 404 });
		}
		return NextResponse.json({ flow });
	} catch (err) {
		if (err instanceof UnauthorizedError) return NextResponse.json({ error: err.message }, { status: 401 });
		console.error('[GET /api/flows/:id]', err);
		return NextResponse.json({ error: (err as Error).message }, { status: 500 });
	}
}

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
	try {
		const auth = await requireAuthContext();
		const { id } = await ctx.params;
		const existing = await db.query.flows.findFirst({ where: eq(flows.id, id) });
		if (!existing || existing.orgId !== auth.org.id) {
			return NextResponse.json({ error: 'not found' }, { status: 404 });
		}
		await db.update(flows).set({ status: 'archived', updatedAt: new Date() }).where(eq(flows.id, id));
		return NextResponse.json({ ok: true });
	} catch (err) {
		if (err instanceof UnauthorizedError) return NextResponse.json({ error: err.message }, { status: 401 });
		console.error('[DELETE /api/flows/:id]', err);
		return NextResponse.json({ error: (err as Error).message }, { status: 500 });
	}
}

const PatchSchema = z.object({
	name: z.string().min(1).max(200).optional(),
	description: z.string().max(400).nullable().optional(),
	steps: z.array(FlowStepSchema).optional(),
});

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
	try {
		const auth = await requireAuthContext();
		const { id } = await ctx.params;
		const existing = await db.query.flows.findFirst({ where: eq(flows.id, id) });
		if (!existing || existing.orgId !== auth.org.id) {
			return NextResponse.json({ error: 'not found' }, { status: 404 });
		}
		const body = PatchSchema.parse(await req.json());
		await db
			.update(flows)
			.set({
				...(body.name !== undefined ? { name: body.name } : {}),
				...(body.description !== undefined ? { description: body.description } : {}),
				...(body.steps !== undefined ? { steps: body.steps } : {}),
				updatedAt: new Date(),
			})
			.where(eq(flows.id, id));
		return NextResponse.json({ ok: true });
	} catch (err) {
		if (err instanceof UnauthorizedError) return NextResponse.json({ error: err.message }, { status: 401 });
		if (err instanceof z.ZodError) return NextResponse.json({ error: 'invalid', issues: err.issues }, { status: 400 });
		console.error('[PATCH /api/flows/:id]', err);
		return NextResponse.json({ error: (err as Error).message }, { status: 500 });
	}
}
