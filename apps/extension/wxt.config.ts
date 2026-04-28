import { defineConfig } from 'wxt';
import tailwindcss from '@tailwindcss/vite';

/**
 * Strip raw UTF-8 BOM bytes (`EF BB BF`) from any emitted JS/CSS chunk and
 * replace them with the `\ufeff` JS-escape so the equivalent character ends
 * up in memory at runtime. Chrome MV3 content scripts reject any raw BOM
 * bytes anywhere in the file (rrweb defensively writes a literal BOM in its
 * BOM-detection helpers, which trips this rule). WXT now uses oxc as its
 * minifier instead of esbuild, so the `esbuild.charset:'ascii'` flag is
 * silently ignored — this plugin is the deterministic fix.
 */
function stripRawBom() {
	return {
		name: 'flowlens:strip-raw-bom',
		generateBundle(_opts: unknown, bundle: Record<string, { type: string; code?: string; source?: string | Uint8Array }>) {
			for (const fileName of Object.keys(bundle)) {
				const chunk = bundle[fileName]!;
				if (chunk.type === 'chunk' && typeof chunk.code === 'string') {
					if (chunk.code.includes('\uFEFF')) {
						chunk.code = chunk.code.replace(/\uFEFF/g, '\\ufeff');
					}
				} else if (chunk.type === 'asset' && typeof chunk.source === 'string') {
					if (chunk.source.includes('\uFEFF')) {
						chunk.source = chunk.source.replace(/\uFEFF/g, '\\ufeff');
					}
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
		host_permissions: [],
		optional_host_permissions: ['<all_urls>'],
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
