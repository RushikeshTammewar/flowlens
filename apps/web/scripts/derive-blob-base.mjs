#!/usr/bin/env node
// Uploads a probe blob via @vercel/blob to derive the public-base URL.
// Append the resulting `BLOB_PUBLIC_BASE_URL=...` line to apps/web/.env.local.
import { put } from '@vercel/blob';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = join(__dirname, '..', '.env.local');

// Load .env.local manually (zsh source chokes on `&` in URL params).
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

if (!process.env.BLOB_READ_WRITE_TOKEN) {
	console.error('BLOB_READ_WRITE_TOKEN not found in .env.local');
	process.exit(1);
}

const result = await put('flowlens-probe/_init.txt', 'init', {
	access: 'public',
	addRandomSuffix: false,
	token: process.env.BLOB_READ_WRITE_TOKEN,
});

const u = new URL(result.url);
const base = `${u.protocol}//${u.host}`;
console.log('PROBE_URL:', result.url);
console.log('BLOB_PUBLIC_BASE_URL:', base);
