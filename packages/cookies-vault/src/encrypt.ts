/**
 * libsodium-wrappers-sumo sealed boxes for cookie + storage payloads.
 *
 * Per-org keypair, deterministically derived from a master `vaultSecret`
 * (held in `process.env.FLOWLENS_VAULT_SECRET`) and the org's UUID via HKDF.
 * The org's public key is stored alongside the cookie snapshots; the private
 * key is regenerated on demand server-side.
 *
 * Threat model:
 *   - DB dump alone is useless without `vaultSecret`.
 *   - Org deletion permanently invalidates the org's secrets (we delete the
 *     row and the keypair derivation is irreversible without the master key).
 *   - Compromise of one org doesn't compromise others.
 *
 * Encrypts the JSON payload `{ cookies, storage }` so the entire blob is
 * sealed in one box.
 */
// libsodium-wrappers-sumo's ESM build (dist/modules-sumo-esm/libsodium-wrappers.mjs)
// has a packaging bug: it does `import e from "./libsodium-sumo.mjs"` but that
// sibling file is missing — only the CJS variant ships the WASM payload.
// We bypass via `createRequire` to load the working CJS build at runtime.
// Defer the import to the first call so Next 16's build-time page-data
// collection doesn't trip on it. The server runtime caches the module after
// first use.
import { createRequire } from 'node:module';

type Sodium = typeof import('libsodium-wrappers-sumo');
let _sodium: Sodium | null = null;
async function getSodium(): Promise<Sodium> {
	if (_sodium) return _sodium;
	const requireFn = createRequire(import.meta.url);
	const mod = requireFn('libsodium-wrappers-sumo') as { default?: Sodium } & Sodium;
	const s: Sodium = mod.default ?? mod;
	await s.ready;
	_sodium = s;
	return s;
}

export interface SealedPayload {
	ciphertext: string; // base64
	nonce: string;      // base64; sealed boxes don't actually need a nonce, kept for forward-compat
}

export async function deriveOrgKeyPair(input: {
	orgId: string;
	vaultSecret: string;
}): Promise<{ publicKey: Uint8Array; privateKey: Uint8Array }> {
	if (!input.vaultSecret || input.vaultSecret.length < 32) {
		throw new Error('FLOWLENS_VAULT_SECRET must be at least 32 chars (64-byte hex).');
	}
	const sodium = await getSodium();
	const masterBytes = sodium.from_hex(input.vaultSecret.slice(0, 64));
	const subkeyId = orgIdToSubkeyId(input.orgId);
	// libsodium expects subkey_id as a BigInt (uint64). The TS types are looser
	// (string | number) but the runtime is strict.
	const seed = sodium.crypto_kdf_derive_from_key(
		32,
		subkeyId as unknown as number,
		'flowlens',
		masterBytes,
	);
	return sodium.crypto_box_seed_keypair(seed);
}

export async function sealForOrg(input: {
	orgId: string;
	vaultSecret: string;
	plaintext: string;
}): Promise<SealedPayload> {
	const sodium = await getSodium();
	const { publicKey } = await deriveOrgKeyPair(input);
	const ciphertext = sodium.crypto_box_seal(input.plaintext, publicKey);
	return {
		ciphertext: sodium.to_base64(ciphertext),
		nonce: '',
	};
}

export async function openForOrg(input: {
	orgId: string;
	vaultSecret: string;
	sealed: SealedPayload;
}): Promise<string> {
	const sodium = await getSodium();
	const { publicKey, privateKey } = await deriveOrgKeyPair(input);
	const ciphertext = sodium.from_base64(input.sealed.ciphertext);
	const plaintextBytes = sodium.crypto_box_seal_open(ciphertext, publicKey, privateKey);
	return sodium.to_string(plaintextBytes);
}

/**
 * Squash a UUID into a uint64 BigInt subkey id. We take the high 64 bits of
 * the UUID — guarantees the same input always yields the same output without
 * needing to track a counter. libsodium's `crypto_kdf_derive_from_key` expects
 * a BigInt (uint64) for `subkey_id`; passing a Number throws at runtime.
 */
function orgIdToSubkeyId(orgId: string): bigint {
	const hex = orgId.replace(/-/g, '').slice(0, 16);
	if (hex.length !== 16) throw new Error('orgId must be a UUID');
	let acc = 0n;
	for (let i = 0; i < hex.length; i++) {
		const ch = hex[i];
		if (ch === undefined) throw new Error('unreachable');
		const v = parseInt(ch, 16);
		if (Number.isNaN(v)) throw new Error('orgId must be hex');
		acc = (acc << 4n) | BigInt(v);
	}
	return acc;
}
