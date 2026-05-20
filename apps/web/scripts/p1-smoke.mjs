#!/usr/bin/env node
import './load-env.mjs';

// P1.3 — Schema runtime sanity
async function p13() {
	const { Pool } = await import('pg');
	const url = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;
	const pool = new Pool({ connectionString: url });
	const tables = await pool.query(
		`SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename`,
	);
	const cols = await pool.query(
		`SELECT column_name FROM information_schema.columns WHERE table_name='runs' ORDER BY ordinal_position`,
	);
	console.log('P1.3 tables count:', tables.rows.length);
	console.log('P1.3 tables:', tables.rows.map((r) => r.tablename).join(','));
	console.log('P1.3 runs columns:', cols.rows.length);
	await pool.end();
}

// P1.4 — OpenAI live probe
async function p14() {
	const OpenAI = (await import('openai')).default;
	const c = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
	const r = await c.chat.completions.create({
		model: 'gpt-4.1-mini',
		max_completion_tokens: 5,
		messages: [{ role: 'user', content: 'Reply with the single word OK and nothing else.' }],
	});
	const reply = (r.choices?.[0]?.message?.content ?? '').trim();
	console.log('P1.4 reply:', JSON.stringify(reply));
	console.log(
		'P1.4 usage:',
		`prompt=${r.usage?.prompt_tokens} completion=${r.usage?.completion_tokens}`,
	);
}

// P1.5 — BU Cloud live probe
async function p15() {
	const res = await fetch('https://api.browser-use.com/api/v2/billing/account', {
		headers: { 'X-Browser-Use-API-Key': process.env.BROWSER_USE_API_KEY },
	});
	const text = await res.text();
	let data;
	try {
		data = JSON.parse(text);
	} catch {
		console.log('P1.5 status:', res.status, 'body:', text.slice(0, 100));
		return;
	}
	console.log(
		'P1.5 status:',
		res.status,
		'creditsUsd:',
		data.totalCreditsBalanceUsd,
		'rateLimit:',
		data.rateLimit,
	);
}

// P1.6 — Upstash live probe
async function p16() {
	const { Redis } = await import('@upstash/redis');
	const r = new Redis({
		url: process.env.UPSTASH_REDIS_REST_URL,
		token: process.env.UPSTASH_REDIS_REST_TOKEN,
	});
	await r.set('flowlens:probe:p1', 'hello', { ex: 60 });
	const v = await r.get('flowlens:probe:p1');
	console.log('P1.6 redis read-back:', JSON.stringify(v));
}

// P1.7 — Clerk publishable key surface in /sign-in
async function p17() {
	const res = await fetch('http://localhost:3000/sign-in');
	const html = await res.text();
	const match = html.match(/pk_(?:test|live)_[A-Za-z0-9]{20,}/);
	const pkPrefix = match ? `${match[0].slice(0, 14)}…(${match[0].length} chars)` : 'NOT FOUND';
	console.log('P1.7 pk in sign-in HTML:', pkPrefix);
}

const tests = [
	['P1.3', p13],
	['P1.4', p14],
	['P1.5', p15],
	['P1.6', p16],
	['P1.7', p17],
];

for (const [name, fn] of tests) {
	try {
		await fn();
	} catch (err) {
		console.error(`${name} FAILED:`, err.message);
	}
}
