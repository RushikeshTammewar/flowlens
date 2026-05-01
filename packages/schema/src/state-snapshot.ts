/**
 * Rich browser-context snapshot (Phase 3.5c — replication upgrade).
 *
 * This is the EVERYTHING-WE-CAN-SEE snapshot of the user's browser context
 * captured at recording start, recording stop, and on cookie-refresh. It's
 * what lets the BU Cloud session look IDENTICAL to the user's real browser:
 * cookies + storage + IndexedDB + UA-CH + viewport + locale + timezone +
 * permissions + observed response headers.
 *
 * Persistence: serialized JSON, sealed via libsodium for the org, stored in
 * `cookie_snapshots.ciphertext` (replacing the old cookies-only payload).
 * The ciphertext blob's plaintext shape is `RichStateSnapshot`.
 *
 * Fault-tolerance contract: every field is optional. The capture pipeline
 * is best-effort — a single missing capability (e.g. user denied IndexedDB
 * access) MUST NEVER fail the recording. Missing fields are simply absent
 * in the persisted snapshot, and the injection layer skips them.
 */
import { z } from 'zod';
import { ChromeCookieSchema, StorageSnapshotSchema } from './cookie';

// ─── IndexedDB capture ───────────────────────────────────────────────────────
//
// Many SPAs (Clerk, Supabase, Firebase, Auth0) store auth tokens or session
// state in IndexedDB instead of cookies. We enumerate `indexedDB.databases()`
// then dump every store via `IDBObjectStore.openCursor()`.
//
// Records are JSON-serialized — we accept that BLOBs / Files inside IDB will
// degrade to a string description. Auth tokens are always JSON-safe so this
// is fine for the auth-replay use case.

export const IdbRecordSchema = z.object({
	key: z.unknown(),
	value: z.unknown(),
});
export type IdbRecord = z.infer<typeof IdbRecordSchema>;

export const IdbStoreSchema = z.object({
	name: z.string(),
	keyPath: z.union([z.string(), z.array(z.string()), z.null()]).optional(),
	autoIncrement: z.boolean().optional(),
	records: z.array(IdbRecordSchema),
	/** When the store had > captureCap entries we capture the first N and flag. */
	truncated: z.boolean().optional(),
});
export type IdbStore = z.infer<typeof IdbStoreSchema>;

export const IdbDatabaseSchema = z.object({
	name: z.string(),
	version: z.number().int().positive(),
	stores: z.array(IdbStoreSchema),
});
export type IdbDatabase = z.infer<typeof IdbDatabaseSchema>;

// ─── Service worker registrations ────────────────────────────────────────────
// We can't clone an SW (permissions + binary), but we record their existence
// so we can WARN at replay-time if the flow may depend on cached SW responses.

export const ServiceWorkerRegistrationSchema = z.object({
	scope: z.string(),
	scriptUrl: z.string().optional(),
	state: z.string().optional(), // active state if observable
});
export type ServiceWorkerRegistration = z.infer<typeof ServiceWorkerRegistrationSchema>;

// ─── User-Agent + Client Hints ───────────────────────────────────────────────

export const UserAgentBrandSchema = z.object({
	brand: z.string(),
	version: z.string(),
});

export const UserAgentClientHintsSchema = z.object({
	brands: z.array(UserAgentBrandSchema).optional(),
	mobile: z.boolean().optional(),
	platform: z.string().optional(),
	platformVersion: z.string().optional(),
	architecture: z.string().optional(),
	model: z.string().optional(),
	bitness: z.string().optional(),
	wow64: z.boolean().optional(),
	fullVersionList: z.array(UserAgentBrandSchema).optional(),
});
export type UserAgentClientHints = z.infer<typeof UserAgentClientHintsSchema>;

// ─── Display + locale + permissions ──────────────────────────────────────────

export const DisplayInfoSchema = z.object({
	width: z.number().int().positive(),
	height: z.number().int().positive(),
	devicePixelRatio: z.number().positive(),
	colorDepth: z.number().int().positive().optional(),
});
export type DisplayInfo = z.infer<typeof DisplayInfoSchema>;

export const LocaleInfoSchema = z.object({
	timezone: z.string().optional(), // e.g. "America/Los_Angeles"
	language: z.string().optional(), // navigator.language
	languages: z.array(z.string()).optional(), // navigator.languages
	numberingSystem: z.string().optional(),
	calendar: z.string().optional(),
});
export type LocaleInfo = z.infer<typeof LocaleInfoSchema>;

export const PermissionStateSchema = z.enum(['granted', 'denied', 'prompt', 'unknown']);
export type PermissionState = z.infer<typeof PermissionStateSchema>;

export const PermissionsInfoSchema = z.object({
	geolocation: PermissionStateSchema.optional(),
	notifications: PermissionStateSchema.optional(),
	clipboardRead: PermissionStateSchema.optional(),
	clipboardWrite: PermissionStateSchema.optional(),
	camera: PermissionStateSchema.optional(),
	microphone: PermissionStateSchema.optional(),
	persistentStorage: PermissionStateSchema.optional(),
});
export type PermissionsInfo = z.infer<typeof PermissionsInfoSchema>;

// ─── Storage quota ───────────────────────────────────────────────────────────

export const StorageQuotaSchema = z.object({
	usage: z.number().int().nonnegative().optional(), // bytes
	quota: z.number().int().nonnegative().optional(), // bytes
});
export type StorageQuota = z.infer<typeof StorageQuotaSchema>;

// ─── Observed response headers ───────────────────────────────────────────────
// CSP/CORS/auth-related headers from the main document. Helps debugging if
// replay starts hitting CSP block errors that the live recording didn't.

export const ObservedResponseHeadersSchema = z.object({
	url: z.string(),
	statusCode: z.number().int().optional(),
	headers: z.record(z.string(), z.string()),
});
export type ObservedResponseHeaders = z.infer<typeof ObservedResponseHeadersSchema>;

// ─── Top-level snapshot ──────────────────────────────────────────────────────

export const RichStateSnapshotSchema = z.object({
	schemaVersion: z.literal(1).default(1),
	capturedAt: z.string().datetime(),
	capturedAtPhase: z.enum(['recording_start', 'recording_stop', 'cookie_refresh']),
	origin: z.string(), // primary origin captured

	// Layer 1: cookies + storage (existing).
	cookies: z.array(ChromeCookieSchema).default([]),
	storage: StorageSnapshotSchema.default({ localStorage: {}, sessionStorage: {} }),

	// Layer 2: IndexedDB.
	indexedDb: z.array(IdbDatabaseSchema).default([]),

	// Layer 3: service worker registrations (warn-only at replay).
	serviceWorkers: z.array(ServiceWorkerRegistrationSchema).default([]),

	// Layer 4: identity emulation.
	userAgent: z.string().optional(),
	userAgentClientHints: UserAgentClientHintsSchema.optional(),
	display: DisplayInfoSchema.optional(),
	locale: LocaleInfoSchema.optional(),
	permissions: PermissionsInfoSchema.optional(),
	storageQuota: StorageQuotaSchema.optional(),

	// Layer 5: response-header diagnostics.
	observedHeaders: z.array(ObservedResponseHeadersSchema).max(50).default([]),

	// Layer 6: per-field capture errors (so we can surface "we tried but failed").
	captureErrors: z.array(
		z.object({
			field: z.string(),
			message: z.string().max(400),
		}),
	).default([]),
});
export type RichStateSnapshot = z.infer<typeof RichStateSnapshotSchema>;

/**
 * Build a minimal snapshot with just cookies + storage (the legacy shape).
 * Lets old callers keep working while we roll out the rich snapshot.
 */
export function legacyToRich(input: {
	origin: string;
	cookies: Array<z.infer<typeof ChromeCookieSchema>>;
	storage: z.infer<typeof StorageSnapshotSchema>;
	capturedAtPhase: RichStateSnapshot['capturedAtPhase'];
}): RichStateSnapshot {
	return {
		schemaVersion: 1,
		capturedAt: new Date().toISOString(),
		capturedAtPhase: input.capturedAtPhase,
		origin: input.origin,
		cookies: input.cookies,
		storage: input.storage,
		indexedDb: [],
		serviceWorkers: [],
		observedHeaders: [],
		captureErrors: [],
	};
}
