/**
 * Compile-time config for the extension.
 * Read from import.meta.env in Vite/WXT builds.
 *
 * `demoBearer`: when set at build time, the extension skips the Clerk sign-in
 * flow entirely and uses this bearer for every API call. Production demo
 * builds bake in the matching `FLOWLENS_DEMO_BEARER` value from the Vercel
 * server. Real customer builds leave it empty and force the Clerk flow.
 */
// Stable production aliases. Per-deploy preview URLs (`flowlens-<hash>...`)
// rotate on every push, which would invalidate every shipped extension.
// `flowlens-beta.vercel.app` is a Vercel alias that always tracks the
// latest READY preview of the v3-foundations branch.
const PROD_API_URL = 'https://flowlens-beta.vercel.app';
const PROD_WEB_URL = 'https://flowlens-beta.vercel.app';

export const APP_CONFIG = {
	apiUrl: import.meta.env.VITE_FLOWLENS_API_URL ?? PROD_API_URL,
	clerkPublishableKey: import.meta.env.VITE_CLERK_PUBLISHABLE_KEY ?? '',
	flowlensWebUrl: import.meta.env.VITE_FLOWLENS_WEB_URL ?? PROD_WEB_URL,
	demoBearer: import.meta.env.VITE_FLOWLENS_DEMO_BEARER ?? '',
};

export type AppConfig = typeof APP_CONFIG;
