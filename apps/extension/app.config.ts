/**
 * Compile-time config for the extension.
 * Read from import.meta.env in Vite/WXT builds.
 */
export const APP_CONFIG = {
	apiUrl: import.meta.env.VITE_FLOWLENS_API_URL ?? 'http://localhost:3000',
	clerkPublishableKey: import.meta.env.VITE_CLERK_PUBLISHABLE_KEY ?? '',
	flowlensWebUrl: import.meta.env.VITE_FLOWLENS_WEB_URL ?? 'http://localhost:3000',
};

export type AppConfig = typeof APP_CONFIG;
