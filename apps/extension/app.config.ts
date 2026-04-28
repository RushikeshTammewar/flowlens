/**
 * Compile-time config for the extension.
 * Read from import.meta.env in Vite/WXT builds.
 *
 * `demoBearer`: when set at build time, the extension skips the Clerk sign-in
 * flow entirely and uses this bearer for every API call. Production demo
 * builds bake in the matching `FLOWLENS_DEMO_BEARER` value from the Vercel
 * server. Real customer builds leave it empty and force the Clerk flow.
 */
export const APP_CONFIG = {
	apiUrl: import.meta.env.VITE_FLOWLENS_API_URL ?? 'http://localhost:3000',
	clerkPublishableKey: import.meta.env.VITE_CLERK_PUBLISHABLE_KEY ?? '',
	flowlensWebUrl: import.meta.env.VITE_FLOWLENS_WEB_URL ?? 'http://localhost:3000',
	demoBearer: (import.meta.env.VITE_FLOWLENS_DEMO_BEARER as string | undefined) ?? '',
};

export type AppConfig = typeof APP_CONFIG;
