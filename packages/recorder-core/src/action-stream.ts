/**
 * Translates rrweb's low-level mutation/event stream into Flowlens semantic
 * `RecordedAction`s.
 *
 * Strategy:
 *   - Listen on the same DOM via global event listeners (capture phase) for
 *     click / change / submit / keypress / scroll / navigate. Cheaper than
 *     trying to reverse-engineer rrweb's mutation buffer.
 *   - rrweb is still emitting in parallel (for replay fidelity). We just
 *     don't depend on its event shape for action semantics.
 *
 * The resulting actions are emitted via `emit(rawAction)`. The recorder
 * adds selector hardening + sensitive detection upstream.
 */
import type { eventWithTime } from 'rrweb';
import type { RecordedActionType } from '@flowlens/schema';

export type ControlType =
	| 'radio'
	| 'checkbox'
	| 'select'
	| 'text'
	| 'number'
	| 'email'
	| 'password'
	| 'textarea'
	| 'unknown';

export interface ControlConstraints {
	minLength?: number;
	maxLength?: number;
	min?: number;
	max?: number;
	pattern?: string;
}

export interface RawSemanticAction {
	type: RecordedActionType;
	timestamp: number;
	target?: Element;
	value?: string;
	rrwebEventId?: number;
	/**
	 * Control-context — populated only when `target` is a form control. Lets
	 * downstream stages (compile, matrix-gen) ground variant generation in
	 * the actual UI shape (e.g. don't try to inject unicode into a 3-option
	 * radio group).
	 */
	controlType?: ControlType;
	/** For radio / checkbox-group / select: the set of valid option values. */
	availableOptions?: string[];
	/** Boundary hints lifted from HTML attributes (minlength, max, pattern, …). */
	constraints?: ControlConstraints;
	/** Field group name (e.g. radio `name=`) when present, else undefined. */
	controlName?: string;
}

export interface ActionStreamOptions {
	emit: (raw: RawSemanticAction) => void;
}

export interface ActionStreamHandle {
	handleRrwebEvent: (event: eventWithTime) => void;
	dispose: () => void;
}

export function rrwebToActionStream(opts: ActionStreamOptions): ActionStreamHandle {
	// Per-element bookkeeping. The 250ms throttle on `input` is a perf
	// optimization for noisy keystroke streams; the safety nets below
	// (submit / blur / beforeunload / navigation) are the *correctness*
	// backstop that guarantees every dirty form value is captured even
	// when the user tabs to the next field and clicks submit before the
	// throttle window elapses.
	const lastInputAt = new WeakMap<Element, number>();
	const lastEmittedValue = new WeakMap<Element, string>();

	const isFormFieldElement = (
		el: Element | null | undefined,
	): el is HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement => {
		return (
			el instanceof HTMLInputElement ||
			el instanceof HTMLTextAreaElement ||
			el instanceof HTMLSelectElement
		);
	};

	/**
	 * Cheap (<1 KB allocated, no LLM, no async) per-action snapshot of the
	 * control's "shape" so matrix-gen can ground variants in actual UI.
	 *
	 * Idempotent and safe to call on every captured action — selectors are
	 * the only things we walk the DOM for, and we early-return if `el` isn't
	 * a form control.
	 */
	const extractControlContext = (
		el: Element | undefined,
	): {
		controlType?: ControlType;
		availableOptions?: string[];
		constraints?: ControlConstraints;
		controlName?: string;
	} => {
		if (!el) return {};
		try {
			const labelOf = (input: Element): string => {
				const node = input as HTMLInputElement;
				const id = node.id;
				if (id && node.ownerDocument) {
					const lbl = node.ownerDocument.querySelector(
						`label[for="${id.replace(/"/g, '\\"')}"]`,
					);
					const t = lbl?.textContent?.trim();
					if (t) return t;
				}
				const wrapping = node.closest?.('label')?.textContent?.trim();
				if (wrapping) return wrapping;
				const aria = node.getAttribute?.('aria-label')?.trim();
				if (aria) return aria;
				return '';
			};

			if (el instanceof HTMLSelectElement) {
				const options = Array.from(el.options).map((opt) => {
					const v = opt.value;
					const t = (opt.textContent ?? '').trim();
					return v || t;
				});
				const out: ReturnType<typeof extractControlContext> = {
					controlType: 'select',
					availableOptions: options,
				};
				if (el.name) out.controlName = el.name;
				return out;
			}

			if (el instanceof HTMLTextAreaElement) {
				const constraints: ControlConstraints = {};
				if (Number.isFinite(el.minLength) && el.minLength >= 0)
					constraints.minLength = el.minLength;
				if (Number.isFinite(el.maxLength) && el.maxLength >= 0)
					constraints.maxLength = el.maxLength;
				const out: ReturnType<typeof extractControlContext> = { controlType: 'textarea' };
				if (Object.keys(constraints).length > 0) out.constraints = constraints;
				if (el.name) out.controlName = el.name;
				return out;
			}

			if (el instanceof HTMLInputElement) {
				const type = (el.type || 'text').toLowerCase();
				const baseConstraints = (): ControlConstraints => {
					const c: ControlConstraints = {};
					// minLength/maxLength default to -1 in JS when unset
					if (typeof el.minLength === 'number' && el.minLength >= 0)
						c.minLength = el.minLength;
					if (typeof el.maxLength === 'number' && el.maxLength >= 0)
						c.maxLength = el.maxLength;
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
					return c;
				};

				if (type === 'radio' || type === 'checkbox') {
					const controlType: ControlType = type === 'radio' ? 'radio' : 'checkbox';
					const out: ReturnType<typeof extractControlContext> = { controlType };
					if (el.name) out.controlName = el.name;
					if (el.name && el.ownerDocument) {
						const escaped = el.name.replace(/"/g, '\\"');
						const siblings = Array.from(
							el.ownerDocument.querySelectorAll<HTMLInputElement>(
								`input[type="${type}"][name="${escaped}"]`,
							),
						);
						if (siblings.length > 0) {
							const seen = new Set<string>();
							const options: string[] = [];
							for (const sib of siblings) {
								const label = labelOf(sib);
								const v = sib.value || label || '';
								if (v && !seen.has(v)) {
									seen.add(v);
									options.push(v);
								}
							}
							if (options.length > 0) out.availableOptions = options;
						}
					}
					return out;
				}

				const map: Record<string, ControlType> = {
					text: 'text',
					search: 'text',
					url: 'text',
					tel: 'text',
					number: 'number',
					range: 'number',
					email: 'email',
					password: 'password',
				};
				const controlType: ControlType = map[type] ?? 'unknown';
				const constraints = baseConstraints();
				const out: ReturnType<typeof extractControlContext> = { controlType };
				if (Object.keys(constraints).length > 0) out.constraints = constraints;
				if (el.name) out.controlName = el.name;
				return out;
			}

			return {};
		} catch {
			// Defensive — recorder runs in arbitrary content-script contexts
			// and must never throw on a single misshapen DOM node.
			return {};
		}
	};

	const emitWithControl = (raw: RawSemanticAction) => {
		// For click events on a <label>, the user's "real" target is the
		// associated form control. Resolving here gives matrix-gen the
		// correct controlType for label-driven radio clicks.
		let target: Element | undefined = raw.target;
		if (target instanceof HTMLLabelElement) {
			const ctrl = target.control ?? null;
			if (ctrl instanceof Element) target = ctrl;
		}
		const ctx = extractControlContext(target);
		opts.emit({
			...raw,
			...(ctx.controlType !== undefined ? { controlType: ctx.controlType } : {}),
			...(ctx.availableOptions !== undefined ? { availableOptions: ctx.availableOptions } : {}),
			...(ctx.constraints !== undefined ? { constraints: ctx.constraints } : {}),
			...(ctx.controlName !== undefined ? { controlName: ctx.controlName } : {}),
		});
	};

	const skipFieldKind = (el: HTMLInputElement): boolean => {
		// Buttons/submits/files/checkboxes/radios are handled via click/change,
		// not via value snapshots — their `value` attribute is not user input.
		const t = (el.type || 'text').toLowerCase();
		return (
			t === 'button' ||
			t === 'submit' ||
			t === 'reset' ||
			t === 'image' ||
			t === 'file' ||
			t === 'checkbox' ||
			t === 'radio' ||
			t === 'hidden'
		);
	};

	const emitSyntheticInput = (el: Element) => {
		if (!isFormFieldElement(el)) return;
		if (el instanceof HTMLInputElement && skipFieldKind(el)) return;
		const value = el.value;
		if (value === undefined || value === null || value === '') {
			// Empty field: nothing to capture as a synthetic input. If the user
			// previously cleared a populated field that *had* been emitted, that
			// clearing already went through onInput / onChange.
			return;
		}
		const last = lastEmittedValue.get(el);
		if (last === value) return;
		lastEmittedValue.set(el, value);
		const now = Date.now();
		lastInputAt.set(el, now);
		emitWithControl({
			type: 'input',
			timestamp: now,
			target: el,
			value,
		});
	};

	const snapshotDirtyFields = (root: ParentNode | Document) => {
		// Walk every input/textarea/select reachable from `root` and emit a
		// synthetic input action for any whose current `.value` differs from
		// what we last emitted. Safe to call repeatedly — duplicates are
		// suppressed by the lastEmittedValue map.
		let nodes: NodeListOf<Element>;
		try {
			nodes = root.querySelectorAll('input, textarea, select');
		} catch {
			return;
		}
		for (const el of Array.from(nodes)) {
			emitSyntheticInput(el);
		}
	};

	const onClick = (ev: MouseEvent) => {
		const target = ev.target instanceof Element ? ev.target : undefined;
		emitWithControl({ type: 'click', timestamp: Date.now(), ...(target ? { target } : {}) });
	};
	const onChange = (ev: Event) => {
		const target = ev.target instanceof Element ? ev.target : undefined;
		const value = isFormFieldElement(target) ? target.value : undefined;
		if (target && value !== undefined) {
			lastEmittedValue.set(target, value);
		}
		emitWithControl({
			type: 'change',
			timestamp: Date.now(),
			...(target ? { target } : {}),
			...(value !== undefined ? { value } : {}),
		});
	};
	const onInput = (ev: Event) => {
		// Capture-phase 'input' is noisy; we sample at most once every 250ms per element.
		const target = ev.target instanceof Element ? ev.target : undefined;
		if (!target) return;
		const last = lastInputAt.get(target) ?? 0;
		const now = Date.now();
		if (now - last < 250) return;
		lastInputAt.set(target, now);
		const value =
			target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement
				? target.value
				: undefined;
		if (value !== undefined) {
			lastEmittedValue.set(target, value);
		}
		emitWithControl({
			type: 'input',
			timestamp: now,
			target,
			...(value !== undefined ? { value } : {}),
		});
	};
	const onSubmit = (ev: Event) => {
		// Capture-phase: the throttled `input` handler may have dropped the last
		// keystroke for one or more fields if the user tabbed/clicked-submit
		// faster than 250ms. Walk every element in this form (and as a belt
		// for forms that don't use <form>, the whole document) and emit
		// synthetic `input` actions BEFORE the submit so the compiled flow
		// has the user's typed value for every field.
		const target = ev.target instanceof Element ? ev.target : undefined;
		if (target instanceof HTMLFormElement) {
			for (const el of Array.from(target.elements)) {
				if (el instanceof Element) emitSyntheticInput(el);
			}
		} else {
			snapshotDirtyFields(document);
		}
		emitWithControl({ type: 'submit', timestamp: Date.now(), ...(target ? { target } : {}) });
	};
	const onBlur = (ev: FocusEvent) => {
		// Per-element correctness backstop: when focus leaves an input we
		// flush its current value if it changed since last emission. This
		// covers the common "type into username, Tab, type into password"
		// pattern where the username field never receives a blur via mouse.
		const target = ev.target instanceof Element ? ev.target : undefined;
		if (!target) return;
		emitSyntheticInput(target);
	};
	const onKeyDown = (ev: KeyboardEvent) => {
		// Only emit "interesting" keys: Enter, Escape, Tab, arrows.
		const interesting = new Set(['Enter', 'Escape', 'Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);
		if (!interesting.has(ev.key)) return;
		const target = ev.target instanceof Element ? ev.target : undefined;
		// Tab/Enter often advance focus past the throttle window — flush the
		// originating field's value before the focus moves.
		if (target && (ev.key === 'Tab' || ev.key === 'Enter')) {
			emitSyntheticInput(target);
		}
		emitWithControl({
			type: 'keypress',
			timestamp: Date.now(),
			...(target ? { target } : {}),
			value: ev.key,
		});
	};
	const onScroll = (() => {
		let last = 0;
		return () => {
			const now = Date.now();
			if (now - last < 750) return;
			last = now;
			emitWithControl({ type: 'scroll', timestamp: now });
		};
	})();

	const onBeforeUnload = () => {
		// Final correctness backstop for client-side navigations and full
		// page unloads: snapshot every dirty input before the page tears down.
		snapshotDirtyFields(document);
	};

	let lastUrl = location.href;
	const checkUrl = () => {
		if (location.href !== lastUrl) {
			// SPA navigation (pushState/replaceState/hashchange). Snapshot
			// dirty inputs *before* recording the navigate action so the
			// captured input actions are ordered before the navigation in
			// the timeline.
			snapshotDirtyFields(document);
			lastUrl = location.href;
			emitWithControl({ type: 'navigate', timestamp: Date.now() });
		}
	};

	document.addEventListener('click', onClick, true);
	document.addEventListener('change', onChange, true);
	document.addEventListener('input', onInput, true);
	document.addEventListener('submit', onSubmit, true);
	document.addEventListener('blur', onBlur, true);
	document.addEventListener('keydown', onKeyDown, true);
	window.addEventListener('scroll', onScroll, true);
	window.addEventListener('beforeunload', onBeforeUnload, true);
	window.addEventListener('pagehide', onBeforeUnload, true);

	const urlInterval = setInterval(checkUrl, 250);

	return {
		handleRrwebEvent: (event) => {
			// We currently use rrweb only for replay fidelity, not as the source of
			// semantic actions. If rrweb signals a navigation we ack it via checkUrl
			// (which runs on its own timer) — no extra wiring needed.
			void event;
		},
		dispose: () => {
			document.removeEventListener('click', onClick, true);
			document.removeEventListener('change', onChange, true);
			document.removeEventListener('input', onInput, true);
			document.removeEventListener('submit', onSubmit, true);
			document.removeEventListener('blur', onBlur, true);
			document.removeEventListener('keydown', onKeyDown, true);
			window.removeEventListener('scroll', onScroll, true);
			window.removeEventListener('beforeunload', onBeforeUnload, true);
			window.removeEventListener('pagehide', onBeforeUnload, true);
			clearInterval(urlInterval);
		},
	};
}
