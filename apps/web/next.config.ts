import type { NextConfig } from 'next';
import { withWorkflow } from 'workflow/next';

/**
 * Pretty download URLs for the Chrome extension.
 *
 * The actual zip lives on Vercel Blob at the auto-assigned bucket
 * subdomain (klaifiooxmmmqygg.public.blob.vercel-storage.com), which is
 * an awful URL to paste into a YC application or share with a partner.
 * These redirects let us share short, branded URLs:
 *
 *   https://flowlens-beta.vercel.app/extension.zip  ← share this
 *   https://flowlens-beta.vercel.app/download       ← or this
 *   https://flowlens.in/extension.zip               ← when custom domain is live
 *
 * Both 308-redirect to the blob URL. The source of truth (blob path)
 * stays the same, so re-uploading a new build via
 * `apps/web/scripts/upload-extension.mjs` automatically updates what
 * these short URLs serve. No code change required for new releases.
 */
const EXTENSION_ZIP_BLOB_URL =
	'https://klaifiooxmmmqygg.public.blob.vercel-storage.com/extension/flowlens-extension.zip';

const nextConfig: NextConfig = {
	transpilePackages: [
		'@flowlens/schema',
		'@flowlens/bu-cloud-client',
		'@flowlens/cookies-vault',
		'@flowlens/design-tokens',
		'@flowlens/flow-doc',
		'@flowlens/llm-config',
		'@flowlens/replay-engine',
	],
	// libsodium-wrappers-sumo can't be bundled (uses CommonJS dynamic require for
	// the WASM module). Keep it as a runtime dep loaded via Node require.
	serverExternalPackages: ['libsodium-wrappers-sumo'],
	typedRoutes: true,
	async redirects() {
		return [
			{ source: '/extension.zip', destination: EXTENSION_ZIP_BLOB_URL, permanent: true },
			{ source: '/download', destination: EXTENSION_ZIP_BLOB_URL, permanent: true },
			{ source: '/extension', destination: EXTENSION_ZIP_BLOB_URL, permanent: true },
		];
	},
};

// withWorkflow enables the "use workflow" / "use step" directives by adding
// the WDK SWC plugin + bundling rules. Required for `start()` to find the
// compiled workflow handlers at runtime.
export default withWorkflow(nextConfig);
