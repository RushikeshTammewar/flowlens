#!/usr/bin/env node
// P2.1 — cookie vault round-trip
import './load-env.mjs';
import { sealForOrg, openForOrg, deriveOrgKeyPair } from '@flowlens/cookies-vault';
import { randomUUID } from 'node:crypto';

const orgId = randomUUID();
const vaultSecret = process.env.FLOWLENS_VAULT_SECRET ?? '';
if (!vaultSecret || vaultSecret.length < 32) {
	console.error('FAIL: FLOWLENS_VAULT_SECRET missing or too short');
	process.exit(1);
}

const plaintext = JSON.stringify({
	cookies: [
		{ name: 'session', value: 'sentinel-1234', domain: 'example.com', path: '/' },
		{ name: 'csrf', value: 'sentinel-5678', domain: 'example.com', path: '/' },
	],
	storage: { localStorage: { foo: 'bar' }, sessionStorage: {} },
});

const sealed = await sealForOrg({ orgId, vaultSecret, plaintext });
console.log('seal: ciphertext bytes', sealed.ciphertext.length);

const opened = await openForOrg({ orgId, vaultSecret, sealed });
const match = opened === plaintext;
console.log('open: match?', match);

// Wrong-org tamper: should throw or produce garbage
const wrongOrg = randomUUID();
let tamperOk = false;
try {
	await openForOrg({ orgId: wrongOrg, vaultSecret, sealed });
	tamperOk = true; // unexpected: opened with wrong key
} catch {
	tamperOk = false; // expected
}
console.log('open with wrong org succeeded?', tamperOk, '(should be false)');

// Deterministic derivation
const kp1 = await deriveOrgKeyPair({ orgId, vaultSecret });
const kp2 = await deriveOrgKeyPair({ orgId, vaultSecret });
const stable =
	Buffer.compare(kp1.publicKey, kp2.publicKey) === 0 &&
	Buffer.compare(kp1.privateKey, kp2.privateKey) === 0;
console.log('keypair deterministic?', stable);

console.log(match && !tamperOk && stable ? 'P2.1 PASS' : 'P2.1 FAIL');
process.exit(match && !tamperOk && stable ? 0 : 1);
