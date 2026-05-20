import { z } from 'zod';

export const ChromeCookieSchema = z.object({
	domain: z.string(),
	name: z.string(),
	value: z.string(),
	expires: z.number().nullable(),
	sameSite: z.enum(['Strict', 'Lax', 'None', 'unspecified']),
	httpOnly: z.boolean(),
	secure: z.boolean(),
	path: z.string(),
});
export type ChromeCookie = z.infer<typeof ChromeCookieSchema>;

export const StorageSnapshotSchema = z.object({
	localStorage: z.record(z.string(), z.string()),
	sessionStorage: z.record(z.string(), z.string()),
});
export type StorageSnapshot = z.infer<typeof StorageSnapshotSchema>;

export const CookieSnapshotSchema = z.object({
	id: z.string().uuid(),
	orgId: z.string().uuid(),
	siteId: z.string().uuid(),
	capturedByUserId: z.string().uuid(),
	capturedAt: z.string().datetime(),
	origin: z.string(),
	cookies: z.array(ChromeCookieSchema),
	storage: StorageSnapshotSchema,
	cookieDomains: z.array(z.string()),
	hasAuthCookie: z.boolean(),
	expiresAtHint: z.string().datetime().nullable(),
});
export type CookieSnapshot = z.infer<typeof CookieSnapshotSchema>;
