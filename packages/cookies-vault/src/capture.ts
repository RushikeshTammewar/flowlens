/**
 * Capture-side helpers for the extension. Pure functions only — the actual
 * `chrome.cookies.getAll` call lives in the extension service worker because
 * we don't want this package to depend on `@types/chrome`.
 */
import type { ChromeCookie } from '@flowlens/schema';

export type CookieRecord = ChromeCookie;

const AUTH_NAME_RE = /\b(session|sess|sid|auth|jwt|token|access[-_]token|refresh[-_]token|csrftoken)\b/i;

/**
 * Returns the unique set of cookie domains observed in the snapshot, plus a
 * boolean flag for whether any cookie name looks auth-shaped.
 */
export function hashAuthDomains(cookies: CookieRecord[]): {
	domains: string[];
	hasAuthCookie: boolean;
} {
	const seen = new Set<string>();
	let hasAuthCookie = false;
	for (const c of cookies) {
		seen.add(c.domain);
		if (AUTH_NAME_RE.test(c.name)) hasAuthCookie = true;
	}
	return { domains: Array.from(seen), hasAuthCookie };
}
