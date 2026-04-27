/**
 * Heuristics for "is this cookie snapshot still good?". The replay engine
 * calls this before launching a run; if `stale === true` we surface a
 * "refresh auth" banner in the extension.
 */
import type { CookieSnapshot, ChromeCookie } from '@flowlens/schema';

export interface StalenessCheck {
	stale: boolean;
	reasons: string[];
}

const STALE_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const NEAR_EXPIRY_MS = 24 * 60 * 60 * 1000; // 24 hours

export function isCookieSnapshotStale(snapshot: CookieSnapshot, now = Date.now()): StalenessCheck {
	const reasons: string[] = [];
	const captured = Date.parse(snapshot.capturedAt);
	if (Number.isFinite(captured) && now - captured > STALE_AGE_MS) {
		reasons.push('capturedAt > 30 days ago');
	}
	if (snapshot.expiresAtHint) {
		const exp = Date.parse(snapshot.expiresAtHint);
		if (Number.isFinite(exp) && exp - now < NEAR_EXPIRY_MS) {
			reasons.push('earliest cookie expires within 24h');
		}
	}
	if (!snapshot.hasAuthCookie) {
		reasons.push('no auth-shaped cookie present');
	}
	return { stale: reasons.length > 0, reasons };
}

export function earliestCookieExpiry(cookies: ChromeCookie[]): Date | null {
	let earliest: number | null = null;
	for (const c of cookies) {
		if (c.expires === null) continue;
		const expMs = c.expires * 1000;
		if (earliest === null || expMs < earliest) earliest = expMs;
	}
	return earliest === null ? null : new Date(earliest);
}

export function hasAuthCookieHeuristic(cookies: ChromeCookie[]): boolean {
	const re = /\b(session|sess|sid|auth|jwt|token|access[-_]token|refresh[-_]token|csrftoken)\b/i;
	return cookies.some((c) => re.test(c.name));
}
