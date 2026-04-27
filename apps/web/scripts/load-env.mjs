// Helper: load .env.local into process.env (tolerant of `&` etc. in values).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = join(__dirname, '..', '.env.local');

const text = readFileSync(envPath, 'utf8');
for (const raw of text.split('\n')) {
	const line = raw.trim();
	if (!line || line.startsWith('#')) continue;
	const eq = line.indexOf('=');
	if (eq === -1) continue;
	const key = line.slice(0, eq);
	let value = line.slice(eq + 1);
	if (
		(value.startsWith('"') && value.endsWith('"')) ||
		(value.startsWith("'") && value.endsWith("'"))
	) {
		value = value.slice(1, -1);
	}
	if (!process.env[key]) process.env[key] = value;
}
