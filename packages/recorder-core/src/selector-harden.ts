/**
 * 4-tier selector hardener.
 *
 * Order of priority (matches replay-engine/resolve.ts):
 *   1. testid       (`data-testid` / `data-test` / `data-cy` / id)
 *   2. role+name    (ARIA role + accessible name)
 *   3. css          (shortest unique CSS, no fragile :nth-child if avoidable)
 *   4. xpath        (last resort)
 *
 * Plus we may stamp a synthetic `data-flowlens-id` at compile time to make
 * resolution at replay time effectively deterministic. See LLD §5.5.
 */
import type { HardenedSelectors } from '@flowlens/schema';

export interface SelectorContext {
	element: Element;
}

export function hardenSelectors(ctx: SelectorContext): HardenedSelectors {
	const el = ctx.element;
	const role = el.getAttribute('role') ?? implicitRole(el);
	const accessibleName = computeAccessibleName(el);
	const testid =
		el.getAttribute('data-testid') ??
		el.getAttribute('data-test') ??
		el.getAttribute('data-cy') ??
		el.id ??
		undefined;
	const flowlensId = el.getAttribute('data-flowlens-id') ?? undefined;

	const out: HardenedSelectors = {};
	if (role) out.role = role;
	if (accessibleName) out.accessibleName = accessibleName;
	if (testid) out.testid = testid;
	if (flowlensId) out.flowlensId = flowlensId;

	const css = optimalCssSelector(el);
	if (css) out.css = css;

	const xpath = uniqueXPath(el);
	if (xpath) out.xpath = xpath;

	return out;
}

const ROLE_BY_TAG: Record<string, string> = {
	a: 'link',
	button: 'button',
	input: 'textbox',
	textarea: 'textbox',
	select: 'combobox',
	option: 'option',
	form: 'form',
	nav: 'navigation',
	main: 'main',
	header: 'banner',
	footer: 'contentinfo',
	aside: 'complementary',
	section: 'region',
	article: 'article',
	dialog: 'dialog',
};

function implicitRole(el: Element): string | undefined {
	const tag = el.tagName.toLowerCase();
	if (tag === 'input') {
		const type = (el as HTMLInputElement).type;
		if (type === 'button' || type === 'submit' || type === 'reset') return 'button';
		if (type === 'checkbox') return 'checkbox';
		if (type === 'radio') return 'radio';
		if (type === 'range') return 'slider';
		return 'textbox';
	}
	return ROLE_BY_TAG[tag];
}

/**
 * Minimal accessible-name implementation per WAI-ARIA §4.3.
 * Doesn't cover every edge case but handles the common ones we care about
 * for replay (button labels, input labels, ARIA-labelled regions).
 */
function computeAccessibleName(el: Element): string | undefined {
	const ariaLabel = el.getAttribute('aria-label');
	if (ariaLabel) return ariaLabel.trim() || undefined;

	const labelledBy = el.getAttribute('aria-labelledby');
	if (labelledBy) {
		const refs = labelledBy
			.split(/\s+/)
			.map((id) => el.ownerDocument.getElementById(id)?.textContent?.trim() ?? '')
			.filter(Boolean);
		if (refs.length) return refs.join(' ');
	}

	if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') {
		const id = el.id;
		if (id) {
			const lbl = el.ownerDocument.querySelector<HTMLLabelElement>(`label[for="${cssEscape(id)}"]`);
			if (lbl?.textContent) return lbl.textContent.trim();
		}
		const wrappingLabel = el.closest('label');
		if (wrappingLabel?.textContent) return wrappingLabel.textContent.trim();
		const placeholder = (el as HTMLInputElement).placeholder;
		if (placeholder) return placeholder.trim();
	}

	if (el instanceof HTMLImageElement && el.alt) return el.alt.trim();

	const text = el.textContent?.trim();
	if (text && text.length <= 80) return text;
	return undefined;
}

function optimalCssSelector(el: Element): string | undefined {
	if (!el.ownerDocument) return undefined;
	if (el.id) return `#${cssEscape(el.id)}`;

	// Walk up from the element building a minimal-yet-unique selector.
	const parts: string[] = [];
	let cur: Element | null = el;
	let depth = 0;
	while (cur && depth < 6) {
		const node: Element = cur;
		const tag = node.tagName.toLowerCase();
		let part = tag;
		const classes = node.classList?.length
			? Array.from(node.classList)
					.slice(0, 2)
					.map((c) => `.${cssEscape(c)}`)
					.join('')
			: '';
		part += classes;
		const parent: Element | null = node.parentElement;
		if (parent) {
			const siblings = Array.from(parent.children).filter(
				(c: Element) => c.tagName === node.tagName,
			);
			if (siblings.length > 1) {
				part += `:nth-of-type(${siblings.indexOf(node) + 1})`;
			}
		}
		parts.unshift(part);
		const candidate = parts.join(' > ');
		try {
			if (el.ownerDocument.querySelectorAll(candidate).length === 1) {
				return candidate;
			}
		} catch {
			// invalid selector path; bail out below
		}
		cur = parent;
		depth++;
	}
	return parts.length ? parts.join(' > ') : undefined;
}

function uniqueXPath(el: Element): string | undefined {
	if (!el.ownerDocument) return undefined;
	const parts: string[] = [];
	let cur: Element | null = el;
	while (cur && cur.nodeType === 1) {
		let i = 1;
		let sib = cur.previousElementSibling;
		while (sib) {
			if (sib.tagName === cur.tagName) i++;
			sib = sib.previousElementSibling;
		}
		parts.unshift(`${cur.tagName.toLowerCase()}[${i}]`);
		cur = cur.parentElement;
	}
	if (!parts.length) return undefined;
	return '/' + parts.join('/');
}

function cssEscape(s: string): string {
	if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(s);
	return s.replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`);
}
