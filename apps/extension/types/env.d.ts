/**
 * Type-only declaration for `import.meta.env` in WXT/Vite builds.
 * WXT injects these at compile time. Only Flowlens-specific vars listed.
 */
interface ImportMetaEnv {
	readonly VITE_FLOWLENS_API_URL?: string;
	readonly VITE_FLOWLENS_WEB_URL?: string;
	readonly VITE_CLERK_PUBLISHABLE_KEY?: string;
	readonly DEV: boolean;
	readonly PROD: boolean;
	readonly MODE: string;
}

interface ImportMeta {
	readonly env: ImportMetaEnv;
}
