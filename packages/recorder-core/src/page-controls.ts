/**
 * Page-wide form control inventory.
 *
 * Walks every visible form control in `document` once at recording stop and
 * returns a flat `PageControlSummary[]`. Matrix-gen consumes this so it knows
 * about controls the user *didn't* touch — the source of "combinatorial
 * variants" (e.g. user only filtered by language; matrix-gen now knows there's
 * also a `min enrollments` number input that's untouched and worth combining
 * with the recorded action).
 *
 * Cheap (single DOM walk, no LLM, no async). Capped at 50 controls so a giant
 * form on a CMS page doesn't bloat the recording payload.
 *
 * Skips:
 *   - hidden / display:none / offsetHeight === 0 controls
 *   - input[type=hidden]
 *   - duplicate radio/checkbox group entries (folded into a single radioGroup
 *     summary keyed by `name` with all options surfaced under
 *     `availableOptions`)
 */
import type { PageControlSummary } from '@flowlens/schema';

export interface ExtractPageControlsOptions {
	/** Cap on returned controls. Default 50. */
	max?: number;
	/**
	 * Set of `controlName | id | label` strings of controls the user
	 * INTERACTED with during the recording. Used to mark
	 * `interactedDuringRecording` so the matrix prompt can call out the
	 * untouched controls. Optional — if absent every entry defaults to
	 * `false`.
	 */
	touchedKeys?: ReadonlySet<string>;
	/** Override `document` (test injection). Defaults to globalThis.document. */
	doc?: Document;
}

const DEFAULT_MAX = 50;

/**
 * `true` when `el` is laid out and not aria-hidden. We deliberately don't
 * call `getComputedStyle` (which forces a layout flush in deep DOMs) — the
 * cheap `offsetHeight === 0 || hidden attr` heuristic catches `display:none`
 * (which removes the box) and the explicit `hidden` attribute, which is what
 * the user spec asked for.
 */
function isVisible(el: HTMLElement): boolean {
	if (el.hidden) return false;
	if (el.offsetHeight === 0 && el.offsetWidth === 0) return false;
	const style = el.getAttribute('style');
	if (style && /display\s*:\s*none/i.test(style)) return false;
	return true;
}

function resolveLabel(el: Element): string | undefined {
	const node = el as HTMLInputElement;
	const id = node.id;
	if (id && node.ownerDocument) {
		try {
			const lbl = node.ownerDocument.querySelector(
				`label[for="${id.replace(/"/g, '\\"')}"]`,
			);
			const t = lbl?.textContent?.trim();
			if (t) return t;
		} catch {
			// querySelector throws on truly invalid selectors; ignore.
		}
	}
	const wrapping = node.closest?.('label')?.textContent?.trim();
	if (wrapping) return wrapping;
	const aria = node.getAttribute?.('aria-label')?.trim();
	if (aria) return aria;
	const ariaLabelledBy = node.getAttribute?.('aria-labelledby');
	if (ariaLabelledBy && node.ownerDocument) {
		const referenced = node.ownerDocument.getElementById(ariaLabelledBy);
		const t = referenced?.textContent?.trim();
		if (t) return t;
	}
	const placeholder = (node as HTMLInputElement).placeholder?.trim?.();
	if (placeholder) return placeholder;
	return undefined;
}

function readConstraints(
	el: HTMLInputElement | HTMLTextAreaElement,
): PageControlSummary['constraints'] {
	const c: NonNullable<PageControlSummary['constraints']> = {};
	if (typeof el.minLength === 'number' && el.minLength >= 0) c.minLength = el.minLength;
	if (typeof el.maxLength === 'number' && el.maxLength >= 0) c.maxLength = el.maxLength;
	if (el instanceof HTMLInputElement) {
		const minAttr = el.getAttribute('min');
		if (minAttr !== null && minAttr !== '') {
			const n = Number(minAttr);
			if (Number.isFinite(n)) c.min = n;
		}
		const maxAttr = el.getAttribute('max');
		if (maxAttr !== null && maxAttr !== '') {
			const n = Number(maxAttr);
			if (Number.isFinite(n)) c.max = n;
		}
		const pattern = el.getAttribute('pattern');
		if (pattern) c.pattern = pattern;
	}
	return Object.keys(c).length === 0 ? undefined : c;
}

const TEXTLIKE_TYPES = new Set([
	'text',
	'search',
	'url',
	'tel',
	'email',
	'password',
	'number',
	'range',
	'date',
	'datetime-local',
	'month',
	'time',
	'week',
	'color',
]);

function controlTypeForInput(t: string): PageControlSummary['controlType'] {
	switch (t) {
		case 'text':
		case 'search':
		case 'url':
		case 'tel':
			return 'text';
		case 'number':
		case 'range':
			return 'number';
		case 'email':
			return 'email';
		case 'password':
			return 'password';
		case 'radio':
			return 'radio';
		case 'checkbox':
			return 'checkbox';
		default:
			return 'unknown';
	}
}

function pushIfNew(out: PageControlSummary[], item: PageControlSummary, max: number): boolean {
	if (out.length >= max) return false;
	out.push(item);
	return true;
}

function isTouched(
	keys: ReadonlySet<string> | undefined,
	candidates: Array<string | undefined>,
): boolean {
	if (!keys || keys.size === 0) return false;
	for (const c of candidates) if (c && keys.has(c)) return true;
	return false;
}

export function extractPageControls(
	opts: ExtractPageControlsOptions = {},
): PageControlSummary[] {
	const max = opts.max ?? DEFAULT_MAX;
	const touched = opts.touchedKeys;
	const doc = opts.doc ?? (typeof document !== 'undefined' ? document : undefined);
	if (!doc) return [];

	const out: PageControlSummary[] = [];

	let nodes: NodeListOf<Element>;
	try {
		nodes = doc.querySelectorAll(
			'input, textarea, select, button[type="submit"], [role="combobox"], [role="listbox"]',
		);
	} catch {
		return [];
	}

	const radioGroupsSeen = new Map<string, PageControlSummary>();
	const checkboxGroupsSeen = new Map<string, PageControlSummary>();

	for (const node of Array.from(nodes)) {
		if (out.length >= max) break;
		if (!(node instanceof HTMLElement)) continue;
		if (!isVisible(node)) continue;

		try {
			if (node instanceof HTMLSelectElement) {
				const optionList = Array.from(node.options).map((opt) => {
					const v = opt.value;
					const t = (opt.textContent ?? '').trim();
					return v || t;
				});
				const summary: PageControlSummary = {
					kind: 'select',
					controlType: 'select',
					interactedDuringRecording: false,
				};
				if (node.name) summary.name = node.name;
				if (node.id) summary.id = node.id;
				const label = resolveLabel(node);
				if (label) summary.label = label;
				if (node.value) summary.value = node.value;
				if (optionList.length > 0) summary.availableOptions = optionList;
				summary.interactedDuringRecording = isTouched(touched, [
					summary.name,
					summary.id,
					summary.label,
				]);
				pushIfNew(out, summary, max);
				continue;
			}

			if (node instanceof HTMLTextAreaElement) {
				const summary: PageControlSummary = {
					kind: 'textarea',
					controlType: 'textarea',
					interactedDuringRecording: false,
				};
				if (node.name) summary.name = node.name;
				if (node.id) summary.id = node.id;
				const label = resolveLabel(node);
				if (label) summary.label = label;
				if (node.value) summary.value = node.value;
				const c = readConstraints(node);
				if (c) summary.constraints = c;
				summary.interactedDuringRecording = isTouched(touched, [
					summary.name,
					summary.id,
					summary.label,
				]);
				pushIfNew(out, summary, max);
				continue;
			}

			if (node instanceof HTMLButtonElement) {
				if ((node.type || 'submit').toLowerCase() !== 'submit') continue;
				const summary: PageControlSummary = {
					kind: 'submit',
					controlType: 'unknown',
					interactedDuringRecording: false,
				};
				if (node.name) summary.name = node.name;
				if (node.id) summary.id = node.id;
				const label = (node.textContent ?? node.getAttribute('aria-label') ?? '').trim();
				if (label) summary.label = label;
				summary.interactedDuringRecording = isTouched(touched, [
					summary.name,
					summary.id,
					summary.label,
				]);
				pushIfNew(out, summary, max);
				continue;
			}

			if (node instanceof HTMLInputElement) {
				const type = (node.type || 'text').toLowerCase();
				if (type === 'hidden') continue;
				if (type === 'reset' || type === 'button' || type === 'image' || type === 'file') {
					// Out-of-scope: file/button-style inputs aren't directly
					// overridable by matrix-gen and would clutter the prompt.
					continue;
				}

				if (type === 'radio') {
					const groupKey = node.name || `__anon_${node.id || resolveLabel(node) || 'radio'}`;
					const existing = radioGroupsSeen.get(groupKey);
					const optValue = node.value || resolveLabel(node) || '';
					if (existing) {
						if (optValue && !existing.availableOptions?.includes(optValue)) {
							existing.availableOptions = [...(existing.availableOptions ?? []), optValue];
						}
						if (node.checked) existing.value = optValue;
						continue;
					}
					const summary: PageControlSummary = {
						kind: 'radioGroup',
						controlType: 'radio',
						availableOptions: optValue ? [optValue] : [],
						interactedDuringRecording: false,
					};
					if (node.name) summary.name = node.name;
					if (node.id) summary.id = node.id;
					const label = resolveLabel(node);
					if (label) summary.label = label;
					if (node.checked && optValue) summary.value = optValue;
					summary.interactedDuringRecording = isTouched(touched, [
						summary.name,
						summary.id,
						summary.label,
					]);
					if (pushIfNew(out, summary, max)) {
						radioGroupsSeen.set(groupKey, summary);
					}
					continue;
				}

				if (type === 'checkbox') {
					// Group when `name` is shared (typical filter UI); otherwise
					// emit per-checkbox so matrix-gen sees standalone toggles
					// (cookie consent, "remember me", etc.) individually.
					const groupKey = node.name && node.name.length > 0 ? node.name : null;
					if (groupKey) {
						const existing = checkboxGroupsSeen.get(groupKey);
						const optValue = node.value || resolveLabel(node) || '';
						if (existing) {
							if (optValue && !existing.availableOptions?.includes(optValue)) {
								existing.availableOptions = [...(existing.availableOptions ?? []), optValue];
							}
							continue;
						}
						const summary: PageControlSummary = {
							kind: 'checkboxGroup',
							controlType: 'checkbox',
							availableOptions: optValue ? [optValue] : [],
							interactedDuringRecording: false,
						};
						if (node.name) summary.name = node.name;
						if (node.id) summary.id = node.id;
						const label = resolveLabel(node);
						if (label) summary.label = label;
						summary.interactedDuringRecording = isTouched(touched, [
							summary.name,
							summary.id,
							summary.label,
						]);
						if (pushIfNew(out, summary, max)) {
							checkboxGroupsSeen.set(groupKey, summary);
						}
						continue;
					}
					const summary: PageControlSummary = {
						kind: 'checkboxGroup',
						controlType: 'checkbox',
						interactedDuringRecording: false,
					};
					if (node.id) summary.id = node.id;
					const label = resolveLabel(node);
					if (label) summary.label = label;
					if (node.value) summary.value = node.value;
					summary.interactedDuringRecording = isTouched(touched, [summary.id, summary.label]);
					pushIfNew(out, summary, max);
					continue;
				}

				if (type === 'submit') {
					const summary: PageControlSummary = {
						kind: 'submit',
						controlType: 'unknown',
						interactedDuringRecording: false,
					};
					if (node.name) summary.name = node.name;
					if (node.id) summary.id = node.id;
					const label = (node.value || resolveLabel(node) || '').trim();
					if (label) summary.label = label;
					summary.interactedDuringRecording = isTouched(touched, [
						summary.name,
						summary.id,
						summary.label,
					]);
					pushIfNew(out, summary, max);
					continue;
				}

				if (TEXTLIKE_TYPES.has(type) || type === 'text') {
					const summary: PageControlSummary = {
						kind: 'input',
						controlType: controlTypeForInput(type),
						interactedDuringRecording: false,
					};
					if (node.name) summary.name = node.name;
					if (node.id) summary.id = node.id;
					const label = resolveLabel(node);
					if (label) summary.label = label;
					if (node.value) summary.value = node.value;
					const c = readConstraints(node);
					if (c) summary.constraints = c;
					summary.interactedDuringRecording = isTouched(touched, [
						summary.name,
						summary.id,
						summary.label,
					]);
					pushIfNew(out, summary, max);
					continue;
				}

				// Unknown input type — surface it generically so the model
				// can still see "there's *some* input here".
				const summary: PageControlSummary = {
					kind: 'input',
					controlType: 'unknown',
					interactedDuringRecording: false,
				};
				if (node.name) summary.name = node.name;
				if (node.id) summary.id = node.id;
				const label = resolveLabel(node);
				if (label) summary.label = label;
				summary.interactedDuringRecording = isTouched(touched, [
					summary.name,
					summary.id,
					summary.label,
				]);
				pushIfNew(out, summary, max);
				continue;
			}

			// role="combobox" / role="listbox" — Radix / shadcn primitives. We
			// can't always read their value (it's hidden behind a custom popup)
			// but matrix-gen still benefits from knowing they exist.
			const role = node.getAttribute('role');
			if (role === 'combobox' || role === 'listbox') {
				const summary: PageControlSummary = {
					kind: 'select',
					controlType: 'select',
					interactedDuringRecording: false,
				};
				const ariaLabel = node.getAttribute('aria-label')?.trim();
				if (ariaLabel) summary.label = ariaLabel;
				if (node.id) summary.id = node.id;
				summary.interactedDuringRecording = isTouched(touched, [summary.id, summary.label]);
				pushIfNew(out, summary, max);
				continue;
			}
		} catch {
			// Per-element extraction is best-effort. A single misshapen node
			// must never abort the inventory (recorder runs in arbitrary
			// content-script contexts including buggy 3rd-party widgets).
			continue;
		}
	}

	return out;
}
