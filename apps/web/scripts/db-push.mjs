#!/usr/bin/env node
// Loads .env.local (tolerant of special chars in values, unlike zsh `source`)
// then runs `drizzle-kit push` with auto-yes piped to stdin.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = join(__dirname, '..', '.env.local');

const text = readFileSync(envPath, 'utf8');
const env = { ...process.env };
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
	env[key] = value;
}

console.log(
	'[db-push] env loaded:',
	Object.keys(env).filter((k) => k.startsWith('DATABASE_URL') || k === 'POSTGRES_URL').join(', '),
);

// Resolve drizzle-kit via pnpm to handle nested node_modules.
const child = spawn('/Users/rtammewar/indeed/.pnpm/pnpm', ['exec', 'drizzle-kit', 'push'], {
	env,
	stdio: ['pipe', 'inherit', 'inherit'],
	shell: false,
	cwd: join(__dirname, '..'),
});

// Auto-confirm any "execute all statements?" prompt.
let answered = false;
const pumpYes = setInterval(() => {
	if (answered) return;
	try {
		child.stdin.write('y\n');
	} catch {
		// stream closed
	}
}, 1500);
setTimeout(() => {
	answered = true;
	clearInterval(pumpYes);
	try {
		child.stdin.end();
	} catch {
		// already closed
	}
}, 30_000);

child.on('exit', (code) => {
	clearInterval(pumpYes);
	process.exit(code ?? 1);
});
