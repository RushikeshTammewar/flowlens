# @flowlens/cookies-vault

Per-org encrypted storage + Browser Use Cloud profile sync for cookie + storage snapshots captured by the extension.

## Surface

```ts
import {
	sealForOrg, openForOrg,        // libsodium sealed-box per-org keypair
	syncCookiesToBuProfile,        // ensures a BU Cloud profile exists
	isCookieSnapshotStale,         // pre-run staleness heuristic
	hashAuthDomains,               // capture-side helper
} from '@flowlens/cookies-vault';

// API route POST /api/recordings/:id/finish
const sealed = sealForOrg({
	orgId: org.id,
	vaultSecret: process.env.FLOWLENS_VAULT_SECRET!,
	plaintext: JSON.stringify({ cookies, storage }),
});
await db.insert(cookieSnapshots).values({
	orgId: org.id, siteId, capturedByUserId, origin: siteOrigin,
	ciphertext: sealed.ciphertext, nonce: sealed.nonce,
	cookieDomains: domains, hasAuthCookie,
	expiresAtHint, capturedAt: new Date(),
});

// pre-run check
const { stale, reasons } = isCookieSnapshotStale(snapshot);
if (stale) ui.showRefreshAuthBanner(reasons);
```

## Encryption details

- libsodium sealed boxes (`crypto_box_seal`).
- Per-org keypair derived from `process.env.FLOWLENS_VAULT_SECRET` (master, 64-byte hex) + `orgId` via `crypto_kdf_derive_from_key`. Deterministic — we do not store the keypair.
- Plaintext is the JSON `{ cookies, storage }` blob.
- `nonce` field is reserved for forward compatibility (sealed boxes generate their own ephemeral keys).

## Threat model

| Threat | Coverage |
|---|---|
| DB dump | Useless without `FLOWLENS_VAULT_SECRET` (env-only, never persisted). |
| Compromise of one org | Other orgs unaffected — different KDF subkey. |
| App-server full RCE | Same as any web app: attacker can decrypt while server is running. Mitigation: rotate `FLOWLENS_VAULT_SECRET` periodically; doing so renders all existing snapshots unreadable (re-snap on next user activity). |
| Org deletion | Cascades to `cookie_snapshots` rows; even backup restoration produces unreadable ciphertext post-rotation. |

## What this package does NOT do

- It does NOT capture cookies. That's `chrome.cookies.getAll` in the extension service worker.
- It does NOT decide when to refresh. That's the replay-engine + extension UI based on `isCookieSnapshotStale` + actual auth-wall detection.
- It does NOT push raw cookies to BU Cloud yet. Phase 3 will wire that through `cdp_url` once BU Cloud's profile-cookie-injection API stabilizes.
