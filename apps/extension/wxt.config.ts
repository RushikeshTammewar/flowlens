import { defineConfig } from 'wxt';
import tailwindcss from '@tailwindcss/vite';

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
		plugins: [tailwindcss()],
	}),
});
