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

export interface RawSemanticAction {
	type: RecordedActionType;
	timestamp: number;
	target?: Element;
	value?: string;
	rrwebEventId?: number;
}

export interface ActionStreamOptions {
	emit: (raw: RawSemanticAction) => void;
}

export interface ActionStreamHandle {
	handleRrwebEvent: (event: eventWithTime) => void;
	dispose: () => void;
}

export function rrwebToActionStream(opts: ActionStreamOptions): ActionStreamHandle {
	const onClick = (ev: MouseEvent) => {
		const target = ev.target instanceof Element ? ev.target : undefined;
		opts.emit({ type: 'click', timestamp: Date.now(), ...(target ? { target } : {}) });
	};
	const onChange = (ev: Event) => {
		const target = ev.target instanceof Element ? ev.target : undefined;
		const value =
			target instanceof HTMLInputElement ||
			target instanceof HTMLTextAreaElement ||
			target instanceof HTMLSelectElement
				? target.value
				: undefined;
		opts.emit({
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
		opts.emit({
			type: 'input',
			timestamp: now,
			target,
			...(value !== undefined ? { value } : {}),
		});
	};
	const onSubmit = (ev: Event) => {
		const target = ev.target instanceof Element ? ev.target : undefined;
		opts.emit({ type: 'submit', timestamp: Date.now(), ...(target ? { target } : {}) });
	};
	const onKeyDown = (ev: KeyboardEvent) => {
		// Only emit "interesting" keys: Enter, Escape, Tab, arrows.
		const interesting = new Set(['Enter', 'Escape', 'Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);
		if (!interesting.has(ev.key)) return;
		const target = ev.target instanceof Element ? ev.target : undefined;
		opts.emit({
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
			opts.emit({ type: 'scroll', timestamp: now });
		};
	})();

	let lastUrl = location.href;
	const checkUrl = () => {
		if (location.href !== lastUrl) {
			lastUrl = location.href;
			opts.emit({ type: 'navigate', timestamp: Date.now() });
		}
	};

	const lastInputAt = new WeakMap<Element, number>();

	document.addEventListener('click', onClick, true);
	document.addEventListener('change', onChange, true);
	document.addEventListener('input', onInput, true);
	document.addEventListener('submit', onSubmit, true);
	document.addEventListener('keydown', onKeyDown, true);
	window.addEventListener('scroll', onScroll, true);

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
			document.removeEventListener('keydown', onKeyDown, true);
			window.removeEventListener('scroll', onScroll, true);
			clearInterval(urlInterval);
		},
	};
}
