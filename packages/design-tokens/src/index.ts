/**
 * Flowlens design tokens — single source of truth.
 * Mirrored as CSS custom properties in tokens.css.
 *
 * Anchor: existing flowlens/frontend/app/globals.css color palette
 * (off-white background, near-black text, IBM Plex Mono, dark green CTAs).
 */
export const tokens = {
	color: {
		black: '#0f0f0f',
		white: '#fafaf9',
		gray: '#737373',
		light: '#e7e5e4',
		soft: '#f4f3f1',
		line: '#d6d3d1',
		green: '#16a34a',
		red: '#dc2626',
		amber: '#b45309',
		blue: '#1e40af',
		cta: '#1a5c2e',
		ctaHi: '#1f6e37',
		ctaLo: '#174f27',
		greenBg: '#ecfdf5',
		redBg: '#fef2f2',
		amberBg: '#fffbeb',
		blueBg: '#eff6ff',
	},
	font: {
		sans: "'IBM Plex Mono', ui-monospace, SFMono-Regular, Menlo, monospace",
		mono: "'IBM Plex Mono', ui-monospace, SFMono-Regular, Menlo, monospace",
		serif: "'Instrument Serif', Georgia, serif",
	},
	radius: {
		none: '0',
		sm: '2px',
		md: '4px',
		lg: '8px',
	},
	spacing: {
		xs: '4px',
		sm: '8px',
		md: '12px',
		lg: '16px',
		xl: '24px',
		'2xl': '32px',
		'3xl': '48px',
	},
	type: {
		xs: { size: '11px', leading: '1.5' },
		sm: { size: '12px', leading: '1.55' },
		base: { size: '13px', leading: '1.6' },
		md: { size: '14px', leading: '1.6' },
		lg: { size: '16px', leading: '1.5' },
		xl: { size: '20px', leading: '1.4' },
		'2xl': { size: '24px', leading: '1.3' },
		'3xl': { size: '32px', leading: '1.2' },
	},
	shadow: {
		sm: '0 1px 0 rgba(15, 15, 15, 0.04)',
		md: '0 1px 2px rgba(15, 15, 15, 0.06), 0 4px 12px rgba(15, 15, 15, 0.04)',
		lg: '0 2px 6px rgba(15, 15, 15, 0.08), 0 12px 32px rgba(15, 15, 15, 0.08)',
	},
	motion: {
		duration: {
			fast: 150,
			base: 220,
			slow: 320,
		},
		ease: {
			out: 'cubic-bezier(0.22, 1, 0.36, 1)',
			spring: 'cubic-bezier(0.34, 1.36, 0.64, 1)',
		},
	},
} as const;

export type Tokens = typeof tokens;
