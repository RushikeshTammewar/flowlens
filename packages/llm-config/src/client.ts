/**
 * Provider-agnostic LLM client factory.
 *
 * Returns an `OpenAI`-shaped client (the Azure variant extends OpenAI) so
 * every existing call site that uses `client.chat.completions.create({...})`
 * or `client.chat.completions.parse({...})` (with `zodResponseFormat`)
 * continues to work unchanged. Routing decision happens at construction time
 * based on `LLM_PROVIDER`.
 *
 * Why AzureOpenAI (from the openai npm package) and not @azure-rest/ai-inference?
 *   - Drop-in `OpenAI` interface: zero call-site churn, full Zod parse helper
 *     support, identical streaming/usage shape.
 *   - Speaks the Azure OpenAI wire protocol
 *     (`/openai/deployments/<deployment>/chat/completions`) which is what
 *     Foundry's GPT/o-series deployments expose.
 *   - We still install `@azure-rest/ai-inference` + `@azure/identity` so the
 *     few non-OpenAI Foundry models (DeepSeek-R1, Phi, Llama via Marketplace)
 *     can be reached via a separate path if/when we wire them up. For now
 *     every stage in MODEL_TABLE maps to a GPT/o-series deployment, so the
 *     OpenAI-compatible path covers 100% of traffic.
 */
import OpenAI, { AzureOpenAI } from 'openai';
import { getProvider } from './provider.ts';

declare global {
	// Cached singletons to avoid reconstructing on every call site, while
	// still letting tests reset them.
	// eslint-disable-next-line no-var
	var __flowlensLlmClient: OpenAI | undefined;
	// eslint-disable-next-line no-var
	var __flowlensLlmClientProvider: 'openai' | 'azure' | undefined;
}

const DEFAULT_AZURE_API_VERSION = '2024-12-01-preview';

/**
 * `https://flowlens-foundry.services.ai.azure.com/api/projects/Flowlens` is
 * the Foundry PROJECT (control-plane) endpoint. Inference (data-plane) for
 * Azure OpenAI deployments lives at the resource root
 * `https://flowlens-foundry.services.ai.azure.com/openai/deployments/...`.
 * Strip the `/api/projects/<name>` suffix so AzureOpenAI builds the right URL.
 */
function azureInferenceBase(rawEndpoint: string): string {
	return rawEndpoint.replace(/\/api\/projects\/[^/]+\/?$/, '').replace(/\/$/, '');
}

export interface GetLlmClientOptions {
	/** When true, ignore the cached singleton and build a fresh client. */
	fresh?: boolean;
}

/**
 * Returns a singleton OpenAI-compatible client routed to the active provider.
 *
 * Throws if credentials for the active provider are missing — caller decides
 * whether to fall back to the other provider or surface the error.
 */
export function getLlmClient(opts: GetLlmClientOptions = {}): OpenAI {
	const provider = getProvider();

	if (
		!opts.fresh &&
		globalThis.__flowlensLlmClient &&
		globalThis.__flowlensLlmClientProvider === provider
	) {
		return globalThis.__flowlensLlmClient;
	}

	let client: OpenAI;

	if (provider === 'azure') {
		// Accept either AZURE_FOUNDRY_ENDPOINT (the documented name) or
		// AZURE_FOUNDRY_BASE_URL (what `vercel env pull` writes when the
		// dashboard variable is created via the Azure AI Foundry integration).
		// Strip the trailing `/openai/v1` if present — AzureOpenAI builds the
		// `/openai/deployments/...` path itself.
		const rawEndpoint =
			process.env.AZURE_FOUNDRY_ENDPOINT ?? process.env.AZURE_FOUNDRY_BASE_URL;
		const apiKey = process.env.AZURE_FOUNDRY_API_KEY;
		const endpoint = rawEndpoint
			? rawEndpoint.replace(/\/openai\/v1\/?$/, '').replace(/\/$/, '')
			: undefined;
		if (!endpoint) {
			throw new Error(
				'LLM_PROVIDER=azure_foundry but AZURE_FOUNDRY_ENDPOINT (or AZURE_FOUNDRY_BASE_URL) is not set. See packages/llm-config/README.md.',
			);
		}
		if (!apiKey) {
			throw new Error(
				'LLM_PROVIDER=azure_foundry but AZURE_FOUNDRY_API_KEY is not set. See packages/llm-config/README.md.',
			);
		}
		client = new AzureOpenAI({
			endpoint: azureInferenceBase(endpoint),
			apiKey,
			apiVersion: process.env.AZURE_FOUNDRY_API_VERSION ?? DEFAULT_AZURE_API_VERSION,
		});
	} else {
		const apiKey = process.env.OPENAI_API_KEY;
		if (!apiKey) {
			throw new Error(
				'OPENAI_API_KEY is required (or set LLM_PROVIDER=azure_foundry + AZURE_FOUNDRY_*).',
			);
		}
		client = new OpenAI({ apiKey });
	}

	if (!opts.fresh) {
		globalThis.__flowlensLlmClient = client;
		globalThis.__flowlensLlmClientProvider = provider;
	}
	return client;
}

/**
 * Cheap presence check used by /api/health. Doesn't validate keys against the
 * upstream — only checks env shape.
 */
export function hasLlmCredentials(): {
	provider: 'openai' | 'azure';
	hasOpenai: boolean;
	hasAzure: boolean;
	configured: boolean;
} {
	const hasOpenai = !!process.env.OPENAI_API_KEY?.trim();
	const hasAzure =
		(!!process.env.AZURE_FOUNDRY_ENDPOINT?.trim() ||
			!!process.env.AZURE_FOUNDRY_BASE_URL?.trim()) &&
		!!process.env.AZURE_FOUNDRY_API_KEY?.trim();
	const provider = getProvider();
	const configured = provider === 'azure' ? hasAzure : hasOpenai;
	return { provider, hasOpenai, hasAzure, configured };
}
