/**
 * Type-only declaration for `import.meta.env` in WXT/Vite builds.
 * WXT injects these at compile time. Only Flowlens-specific vars listed.
 */
interface ImportMetaEnv {
	readonly VITE_FLOWLENS_API_URL?: string;
	readonly VITE_FLOWLENS_WEB_URL?: string;
	readonly VITE_CLERK_PUBLISHABLE_KEY?: string;
	/** Compiled-in bearer for demo-mode auth bypass. Production demo builds set this; real-customer builds leave it empty to force the Clerk flow. */
	readonly VITE_FLOWLENS_DEMO_BEARER?: string;
	readonly DEV: boolean;
	readonly PROD: boolean;
	readonly MODE: string;
}

interface ImportMeta {
	readonly env: ImportMetaEnv;
}
