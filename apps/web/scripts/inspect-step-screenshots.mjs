import './load-env.mjs';
import pg from 'pg';
const { Pool } = pg;
const cs = process.env.DATABASE_URL;
if (!cs) { console.error('no DATABASE_URL'); process.exit(1); }
const pool = new Pool({ connectionString: cs, max: 2 });
async function q(sql, params=[]) { return (await pool.query(sql, params)).rows; }
const blobBase = process.env.BLOB_PUBLIC_BASE_URL ?? '';
console.log('BLOB_PUBLIC_BASE_URL =', blobBase || '(empty)');

const rows = await q(`
  SELECT sr.run_id, sr.step_index, sr.replay_screenshot_key, sr.status, sr.finished_at, r.batch_id
  FROM step_results sr
  JOIN runs r ON r.id = sr.run_id
  ORDER BY sr.finished_at DESC NULLS LAST
  LIMIT 20`);
console.log('latest 20 step_results:');
let withKey = 0, withoutKey = 0;
for (const r of rows) {
  const has = r.replay_screenshot_key ? '✓' : '∅';
  if (r.replay_screenshot_key) withKey++; else withoutKey++;
  console.log(`  run=${r.run_id.slice(0,8)} step=${r.step_index} status=${r.status}  screenshot=${has} key=${r.replay_screenshot_key ?? '(null)'}`);
}
console.log(`\nsummary: with-key=${withKey} without-key=${withoutKey}`);
await pool.end();
