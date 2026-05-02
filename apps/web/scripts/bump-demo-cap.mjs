#!/usr/bin/env node
/**
 * One-shot: bump the demo org's monthlyFeatureCap so the closed-beta
 * demo bearer can record more than 3 features without hitting the
 * Phase 4 free-tier gate.
 *
 *   pnpm --filter @flowlens/web exec tsx scripts/bump-demo-cap.mjs
 */
import './load-env.mjs';
import { db } from '../src/lib/db.ts';
import { orgs } from '@flowlens/schema/db';
import { eq } from 'drizzle-orm';

async function main() {
	const demo = await db.query.orgs.findFirst({
		where: eq(orgs.clerkOrgId, 'demo:flowlens-public-org'),
	});
	if (!demo) {
		console.error('demo org row not found');
		process.exit(1);
	}
	await db
		.update(orgs)
		.set({ monthlyFeatureCap: 999, monthlyFeaturesConsumed: 0 })
		.where(eq(orgs.id, demo.id));
	console.log(
		`[demo-cap] org=${demo.id} cap=999 consumed=0 (was cap=${demo.monthlyFeatureCap} consumed=${demo.monthlyFeaturesConsumed})`,
	);
}

main()
	.then(() => process.exit(0))
	.catch((err) => {
		console.error(err);
		process.exit(1);
	});
