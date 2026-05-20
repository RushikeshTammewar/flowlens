import { defineConfig } from 'wxt';
import tailwindcss from '@tailwindcss/vite';

/**
 * Strip raw BOM bytes (forward `EF BB BF` = U+FEFF, and reverse `EF BF BE`
 * = U+FFFE) from any emitted JS/CSS chunk and replace them with the
 * `\ufeff` / `\ufffe` JS-escapes so the equivalent character still ends
 * up in memory at runtime. Chrome MV3 content scripts reject any raw BOM
 * bytes anywhere in the file (rrweb defensively writes BOMs in its
 * BOM-detection helpers, which trips this rule on both forward AND reverse
 * BOM constants). WXT now uses oxc as its minifier instead of esbuild, so
 * the `esbuild.charset:'ascii'` flag is silently ignored — this plugin is
 * the deterministic fix.
 */
function stripRawBom() {
	const sanitize = (s: string) => s.replace(/\uFEFF/g, '\\ufeff').replace(/\uFFFE/g, '\\ufffe');
	const hasRawBom = (s: string) => s.includes('\uFEFF') || s.includes('\uFFFE');
	return {
		name: 'flowlens:strip-raw-bom',
		generateBundle(_opts: unknown, bundle: Record<string, { type: string; code?: string; source?: string | Uint8Array }>) {
			for (const fileName of Object.keys(bundle)) {
				const chunk = bundle[fileName]!;
				if (chunk.type === 'chunk' && typeof chunk.code === 'string') {
					if (hasRawBom(chunk.code)) chunk.code = sanitize(chunk.code);
				} else if (chunk.type === 'asset' && typeof chunk.source === 'string') {
					if (hasRawBom(chunk.source)) chunk.source = sanitize(chunk.source);
				}
			}
		},
	};
}

// See https://wxt.dev/api/config.html
export default defineConfig({
	srcDir: '.',
	modules: ['@wxt-dev/module-react'],
	manifest: {
		name: 'Flowlens',
		description: 'Record a flow once. We test it forever.',
		version: '0.0.1',
		permissions: ['cookies', 'storage', 'scripting', 'activeTab', 'sidePanel', 'tabs', 'notifications'],
		optional_permissions: ['tabCapture'],
		// `<all_urls>` is required by `chrome.tabs.captureVisibleTab` for any
		// page the user navigates to mid-recording. The `activeTab` grant
		// alone is not sufficient because it lapses on cross-origin (and in
		// some Chrome builds, even same-origin) navigation, which silently
		// drops every per-step screenshot — leaving the side panel showing
		// gray "screenshot" placeholders for compiled flows.
		host_permissions: ['<all_urls>'],
		optional_host_permissions: [],
		side_panel: {
			default_path: 'sidepanel.html',
		},
		action: {
			default_title: 'Flowlens',
			default_icon: {
				'16': 'icon/16.png',
				'32': 'icon/32.png',
				'48': 'icon/48.png',
				'128': 'icon/128.png',
			},
		},
		icons: {
			'16': 'icon/16.png',
			'32': 'icon/32.png',
			'48': 'icon/48.png',
			'128': 'icon/128.png',
		},
		web_accessible_resources: [
			{
				resources: ['recorder.js'],
				matches: ['<all_urls>'],
			},
		],
	},
	vite: () => ({
		plugins: [tailwindcss(), stripRawBom()],
	}),
});
