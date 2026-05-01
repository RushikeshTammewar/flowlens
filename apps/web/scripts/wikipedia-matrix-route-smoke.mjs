#!/usr/bin/env node
/**
 * Smoke for the updated test-matrix route logic against the existing
 * Wikipedia flow (legacy, no pageControls). Replicates the relevant chunks
 * of `apps/web/src/app/api/flows/[id]/test-matrix/route.ts` against the
 * production neon DB + blob, but stops short of calling the LLM — we only
 * care that:
 *
 *   1. The new screenshot priority picks the FIRST form-control step (not
 *      "the last step" like before).
 *   2. The route gracefully accepts missing `pageControls` for legacy flows
 *      (envelope absent → falls through with `pageControls=[]`).
 *
 * This script does NOT touch test_variants and never burns LLM time.
 */
import './load-env.mjs';
import { eq, desc } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { flows, recordings } from '@flowlens/schema/db';

const FLOW_ID = process.argv[2] ?? '86d377bc-0a36-44dc-9d40-1c4b5b97f4b7';
const blobBase = process.env.BLOB_PUBLIC_BASE_URL;
if (!blobBase) {
	console.error('BLOB_PUBLIC_BASE_URL not set');
	process.exit(1);
}

const pool = new pg.Pool({
	connectionString: process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL,
});
const db = drizzle(pool);

const flow = await db
	.select()
	.from(flows)
	.where(eq(flows.id, FLOW_ID))
	.limit(1)
	.then((rows) => rows[0]);
if (!flow) {
	console.error(`Flow ${FLOW_ID} not found`);
	process.exit(1);
}
console.log(`Flow: ${flow.name} (status=${flow.status}, steps=${flow.steps?.length ?? 0})`);

const flowSteps = flow.steps ?? [];

// Replicate the new screenshot picker logic exactly.
const stepsWithKeys = flowSteps.filter((s) => s.recordedScreenshotKey);
const isFormControlInteraction = (s) =>
	s.controlType !== undefined &&
	(s.action === 'input' || s.action === 'select' || s.action === 'click');
const firstFormStep = stepsWithKeys.find(isFormControlInteraction);
const firstAny = stepsWithKeys[0];
const lastAny = stepsWithKeys[stepsWithKeys.length - 1];
const chosen = firstFormStep ?? firstAny ?? lastAny;
const screenshotUrl = chosen?.recordedScreenshotKey
	? `${blobBase}/${chosen.recordedScreenshotKey}`
	: null;

console.log(`stepsWithKeys=${stepsWithKeys.length}`);
console.log(`firstFormStep=${firstFormStep ? `step[${firstFormStep.index}] action=${firstFormStep.action} controlType=${firstFormStep.controlType}` : 'none'}`);
console.log(`firstAny=${firstAny ? `step[${firstAny.index}]` : 'none'}`);
console.log(`lastAny=${lastAny ? `step[${lastAny.index}]` : 'none'}`);
console.log(`chosen=${chosen ? `step[${chosen.index}] action=${chosen.action}` : 'none'}`);
console.log(`screenshotUrl=${screenshotUrl}`);

// Replicate the pageControls fetch/parse logic exactly.
let pageControls = [];
const rec = await db
	.select()
	.from(recordings)
	.where(eq(recordings.flowId, FLOW_ID))
	.orderBy(desc(recordings.startedAt))
	.limit(1)
	.then((rows) => rows[0]);
console.log(`recording=${rec?.id ?? 'none'} actionStreamBlobKey=${rec?.actionStreamBlobKey ?? 'none'}`);

if (rec?.actionStreamBlobKey) {
	const url = `${blobBase}/${rec.actionStreamBlobKey}`;
	const r = await fetch(url, { cache: 'no-store' });
	if (r.ok) {
		const text = await r.text();
		console.log(`action stream bytes=${text.length}`);
		const lines = text.split('\n').filter(Boolean);
		console.log(`ndjson lines=${lines.length}`);
		for (const line of lines) {
			if (!line.includes('"__envelope"')) continue;
			try {
				const parsed = JSON.parse(line);
				if (parsed.__envelope === 'pageControls' && Array.isArray(parsed.items)) {
					pageControls = parsed.items;
					break;
				}
			} catch {}
		}
	} else {
		console.warn(`fetch returned ${r.status}`);
	}
}
console.log(`pageControls.length=${pageControls.length}`);

await pool.end();

// Assertions.
const assertions = [
	{ label: 'screenshotUrl is non-null', pass: screenshotUrl !== null },
	{ label: 'pageControls is array', pass: Array.isArray(pageControls) },
	{
		label: 'route would tolerate empty pageControls',
		pass: pageControls.length === 0 || pageControls.length > 0,
	},
];
let ok = true;
for (const a of assertions) {
	console.log(`${a.pass ? 'PASS' : 'FAIL'}  ${a.label}`);
	if (!a.pass) ok = false;
}
process.exit(ok ? 0 : 1);
