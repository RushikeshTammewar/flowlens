import { readFileSync } from 'node:fs';
import { Pool } from 'pg';

const env = {};
for (const line of readFileSync(new URL('../.env.local', import.meta.url), 'utf8').split('\n')) {
  const t = line.trim();
  if (!t || t.startsWith('#') || !t.includes('=')) continue;
  const i = t.indexOf('=');
  env[t.slice(0,i)] = t.slice(i+1).replace(/^["']|["']$/g,'');
}

const pool = new Pool({ connectionString: env.DATABASE_URL });

const flow = await pool.query(
  `SELECT id, name, status, jsonb_array_length(steps) AS n FROM flows WHERE id='482c9eac-3536-40fe-a506-cb224e6c9b7a'`
);
console.log('Flow:', flow.rows[0]);

const steps = await pool.query(
  `SELECT jsonb_array_elements(steps) AS s FROM flows WHERE id='482c9eac-3536-40fe-a506-cb224e6c9b7a'`
);
console.log('\nSteps:');
for (const r of steps.rows) {
  const s = r.s;
  console.log(`[${s.index}] action=${s.action} intent=${(s.intent||'').slice(0,80)}`);
  console.log(`    selectors: testid=${s.selectors?.testid||'-'} css=${(s.selectors?.css||'-').slice(0,60)} xpath=${(s.selectors?.xpath||'-').slice(0,60)} role=${s.selectors?.role||'-'} name=${(s.selectors?.accessibleName||'-').slice(0,40)}`);
  console.log(`    recordedValue=${(s.recordedValue||'').slice(0,40)} url=${s.url||'-'}`);
}

const run = await pool.query(
  `SELECT id, flow_id, status, started_at, ended_at, error_message FROM runs WHERE id='0526e18a-acfb-4ecc-9da2-a2f483de0648'`
);
console.log('\nRun:', run.rows[0] ?? 'no row found in DB');

await pool.end();
