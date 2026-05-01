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

const flow = await pool.query(`
  SELECT f.id, f.name, f.status, f.created_at, jsonb_array_length(f.steps) AS n,
         r.id AS recording_id, r.action_stream_blob_key
  FROM flows f
  LEFT JOIN recordings r ON r.flow_id = f.id
  WHERE f.status = 'ready'
  ORDER BY f.created_at DESC LIMIT 1
`);
console.log('Latest ready flow:', flow.rows[0]);

const flowId = flow.rows[0].id;
const recordingId = flow.rows[0].recording_id;

const steps = await pool.query(
  `SELECT jsonb_array_elements(steps) AS s FROM flows WHERE id=$1`,
  [flowId],
);
console.log('\nSteps:');
for (const r of steps.rows) {
  const s = r.s;
  console.log(`  [${s.index}] action=${s.action} recordedScreenshotKey="${s.recordedScreenshotKey || ''}" intent="${(s.intent||'').slice(0,80)}"`);
}

console.log('\nProbing blob URLs for recording', recordingId);
const base = env.BLOB_PUBLIC_BASE_URL;
const tries = ['webp', 'png'];
for (let i = 0; i < flow.rows[0].n; i++) {
  for (const ext of tries) {
    const url = `${base}/recordings/${recordingId}/screenshots/${i}.${ext}`;
    const r = await fetch(url, { method: 'HEAD' });
    if (r.status === 200) {
      console.log(`  step ${i}: 200 ${ext} (${r.headers.get('content-length')} bytes)`);
      break;
    }
    if (ext === tries[tries.length - 1]) {
      console.log(`  step ${i}: NOT FOUND (last try ${ext} → ${r.status})`);
    }
  }
}

// Also try padded 4-digit naming convention
console.log('\nProbing 4-digit padded variant (NNNN.webp):');
for (let i = 0; i < Math.min(3, flow.rows[0].n); i++) {
  const url = `${base}/recordings/${recordingId}/screenshots/${String(i).padStart(4, '0')}.webp`;
  const r = await fetch(url, { method: 'HEAD' });
  console.log(`  step ${i}: ${r.status} ${url}`);
}

await pool.end();
