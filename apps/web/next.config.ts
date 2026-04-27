import type { NextConfig } from 'next';
import { withWorkflow } from 'workflow/next';

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
};

// withWorkflow enables the "use workflow" / "use step" directives by adding
// the WDK SWC plugin + bundling rules. Required for `start()` to find the
// compiled workflow handlers at runtime.
export default withWorkflow(nextConfig);
