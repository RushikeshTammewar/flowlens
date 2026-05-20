import { readFileSync } from 'node:fs';
import { Pool } from 'pg';

const env = {};
for (const line of readFileSync(new URL('../.env.local', import.meta.url), 'utf8').split('\n')) {
  const t = line.trim();
  if (!t || t.startsWith('#') || !t.includes('=')) continue;
  const i = t.indexOf('=');
  env[t.slice(0,i)] = t.slice(i+1).replace(/^["']|["']$/g, '');
}

const pool = new Pool({ connectionString: env.DATABASE_URL });
const r = await pool.query(`
  SELECT f.id, f.name, f.status, f.org_id, jsonb_array_length(f.steps) AS n_steps,
         s.origin AS site_origin, f.cookie_snapshot_id
  FROM flows f JOIN sites s ON s.id = f.site_id
  ORDER BY f.created_at DESC LIMIT 10
`);
console.log('Flows in DB (' + r.rows.length + '):');
for (const row of r.rows) {
  console.log(` - [${row.status}] ${row.name} (${row.n_steps} steps, ${row.site_origin}) cookies=${row.cookie_snapshot_id?'yes':'no'} id=${row.id}`);
}
await pool.end();
