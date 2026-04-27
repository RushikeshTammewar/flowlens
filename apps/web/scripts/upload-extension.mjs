import { put } from '@vercel/blob';
import { readFileSync } from 'node:fs';

// Manual env load — dotenv may not be installed
const envText = readFileSync('.env.local', 'utf8');
for (const line of envText.split('\n')) {
	const m = line.match(/^([A-Z_][A-Z_0-9]*)=(.*)$/);
	if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}

const buf = readFileSync('/tmp/flowlens-extension.zip');
const r = await put('extension/flowlens-extension.zip', buf, {
	access: 'public',
	addRandomSuffix: false,
	contentType: 'application/zip',
	token: process.env.BLOB_READ_WRITE_TOKEN,
});
console.log(r.url);
