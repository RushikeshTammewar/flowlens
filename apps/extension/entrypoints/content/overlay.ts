/**
 * In-page recording overlay.
 *
 * Anchored bottom-right by default. Draggable by header (vanilla pointer
 * events). Pulsing red dot via CSS keyframes that respect
 * `prefers-reduced-motion`. Hover elevation via CSS transitions.
 *
 * Implemented as plain DOM (no React, no Framer Motion) so the content-script
 * bundle stays small — Phase 3.9 budget caps total at 750 kB. The side panel
 * still uses React + Framer Motion for the rich state machine.
 */

export interface OverlayCallbacks {
	onNote: (text: string) => void;
	onPause: () => void;
	onResume: () => void;
	onStop: () => void;
}

export interface OverlayHandle {
	root: HTMLElement;
	bumpAction: () => void;
	setPaused: (paused: boolean) => void;
	destroy: () => void;
}

const STYLE = `
:host {
	all: initial;
	font-family: 'IBM Plex Mono', ui-monospace, SFMono-Regular, Menlo, monospace;
}
.fl-root {
	position: fixed;
	right: 16px;
	bottom: 16px;
	width: 252px;
	color: #0f0f0f;
	background: #fafaf9;
	border: 1px solid #d6d3d1;
	box-shadow: 0 1px 2px rgba(15,15,15,0.06), 0 8px 24px rgba(15,15,15,0.10);
	user-select: none;
	z-index: 2147483646;
	transition: box-shadow 200ms cubic-bezier(0.22,1,0.36,1), transform 200ms cubic-bezier(0.22,1,0.36,1);
	font-family: inherit;
}
.fl-root:hover {
	transform: translateY(-2px);
	box-shadow: 0 2px 6px rgba(15,15,15,0.10), 0 16px 40px rgba(15,15,15,0.18);
}
.fl-root.dragging {
	cursor: grabbing;
}
.fl-header {
	display: flex;
	align-items: center;
	gap: 6px;
	padding: 8px 10px;
	border-bottom: 1px solid #e7e5e4;
	cursor: grab;
}
.fl-header:active { cursor: grabbing; }
.fl-pulse-wrap {
	position: relative;
	display: inline-flex;
	width: 10px;
	height: 10px;
	flex: 0 0 auto;
}
.fl-pulse {
	position: absolute;
	inset: 0;
	background: rgba(220,38,38,0.45);
	border-radius: 50%;
	animation: fl-ping 1.6s cubic-bezier(0.22,1,0.36,1) infinite;
}
.fl-dot {
	position: relative;
	display: inline-block;
	width: 10px;
	height: 10px;
	background: #dc2626;
	border-radius: 50%;
}
.fl-paused .fl-dot {
	background: #b45309;
}
.fl-paused .fl-pulse {
	animation: none;
	opacity: 0;
}
@keyframes fl-ping {
	0% { transform: scale(0.6); opacity: 0.6; }
	100% { transform: scale(1.7); opacity: 0; }
}
.fl-title {
	font-size: 11px;
	font-weight: 600;
	text-transform: uppercase;
	letter-spacing: 0.06em;
}
.fl-counter, .fl-time {
	font-size: 11px;
	font-variant-numeric: tabular-nums;
}
.fl-time { color: #737373; }
.fl-sep {
	color: #a3a3a3;
	font-size: 11px;
}
.fl-handle {
	margin-left: auto;
	color: #737373;
	display: inline-flex;
}
.fl-actions {
	display: flex;
	gap: 4px;
	padding: 6px;
}
.fl-btn {
	flex: 1;
	display: inline-flex;
	align-items: center;
	justify-content: center;
	gap: 4px;
	height: 26px;
	padding: 0 8px;
	background: #fafaf9;
	color: #0f0f0f;
	border: 1px solid #d6d3d1;
	font-size: 10px;
	font-family: inherit;
	text-transform: uppercase;
	letter-spacing: 0.06em;
	cursor: pointer;
	transition: background 150ms ease-out, border-color 150ms ease-out, color 150ms ease-out;
}
.fl-btn:hover {
	background: #f4f3f1;
	border-color: rgba(15,15,15,0.35);
}
.fl-btn:focus-visible {
	outline: none;
	box-shadow: 0 0 0 2px #fafaf9, 0 0 0 4px #1a5c2e;
}
.fl-btn.fl-danger {
	background: #dc2626;
	color: #fafaf9;
	border-color: rgba(220,38,38,0.55);
}
.fl-btn.fl-danger:hover { background: #c1272a; }
.fl-note {
	display: none;
	gap: 4px;
	padding: 6px 8px;
	border-bottom: 1px solid #e7e5e4;
	background: #f4f3f1;
}
.fl-note.open { display: flex; }
.fl-note-input {
	flex: 1;
	height: 24px;
	padding: 0 8px;
	border: 1px solid #d6d3d1;
	background: #fafaf9;
	font-size: 11px;
	font-family: inherit;
	color: #0f0f0f;
	outline: none;
}
.fl-note-input:focus { border-color: #1a5c2e; }
.fl-note-submit {
	height: 24px;
	padding: 0 8px;
	border: 1px solid #1a5c2e;
	background: #1a5c2e;
	color: #fafaf9;
	font-size: 10px;
	font-family: inherit;
	text-transform: uppercase;
	letter-spacing: 0.06em;
	cursor: pointer;
}
@media (prefers-reduced-motion: reduce) {
	.fl-pulse { animation: none !important; }
	.fl-root, .fl-btn { transition: none !important; }
}
`;

const NOTE_ICON =
	'<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 19l7-7-3-3-7 7v3h3z"/><path d="M5 21h14"/></svg>';
const PAUSE_ICON =
	'<svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="5" width="4" height="14"/><rect x="14" y="5" width="4" height="14"/></svg>';
const PLAY_ICON =
	'<svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 5l12 7-12 7V5z"/></svg>';
const STOP_ICON =
	'<svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="6" width="12" height="12"/></svg>';
const DRAG_ICON =
	'<svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="9" cy="6" r="1.4"/><circle cx="15" cy="6" r="1.4"/><circle cx="9" cy="12" r="1.4"/><circle cx="15" cy="12" r="1.4"/><circle cx="9" cy="18" r="1.4"/><circle cx="15" cy="18" r="1.4"/></svg>';

export function mountOverlay(host: HTMLElement, cb: OverlayCallbacks): OverlayHandle {
	const startedAt = Date.now();
	let actions = 0;
	let paused = false;
	let timer: number | null = null;

	const style = document.createElement('style');
	style.textContent = STYLE;
	host.appendChild(style);

	const root = document.createElement('div');
	root.className = 'fl-root';
	root.setAttribute('role', 'region');
	root.setAttribute('aria-label', 'Flowlens recording controls');
	root.innerHTML = `
		<div class="fl-header" data-fl-drag>
			<span class="fl-pulse-wrap">
				<span class="fl-pulse"></span>
				<span class="fl-dot"></span>
			</span>
			<span class="fl-title" data-fl-status>recording</span>
			<span class="fl-sep">·</span>
			<span class="fl-counter" data-fl-counter>0 actions</span>
			<span class="fl-sep">·</span>
			<span class="fl-time" data-fl-time>00:00</span>
			<span class="fl-handle" aria-hidden="true">${DRAG_ICON}</span>
		</div>
		<form class="fl-note" data-fl-note>
			<input type="text" class="fl-note-input" placeholder="note for next action…" aria-label="note for next captured action"/>
			<button type="submit" class="fl-note-submit">add</button>
		</form>
		<div class="fl-actions">
			<button type="button" class="fl-btn" data-fl-action="note" title="note this step">${NOTE_ICON}<span>note</span></button>
			<button type="button" class="fl-btn" data-fl-action="pause" title="pause">${PAUSE_ICON}<span>pause</span></button>
			<button type="button" class="fl-btn fl-danger" data-fl-action="stop" title="stop recording">${STOP_ICON}<span>stop</span></button>
		</div>
	`;
	host.appendChild(root);

	const counterEl = root.querySelector<HTMLElement>('[data-fl-counter]')!;
	const timeEl = root.querySelector<HTMLElement>('[data-fl-time]')!;
	const statusEl = root.querySelector<HTMLElement>('[data-fl-status]')!;
	const noteForm = root.querySelector<HTMLFormElement>('[data-fl-note]')!;
	const noteInput = noteForm.querySelector<HTMLInputElement>('input')!;
	const noteBtn = root.querySelector<HTMLButtonElement>('[data-fl-action="note"]')!;
	const pauseBtn = root.querySelector<HTMLButtonElement>('[data-fl-action="pause"]')!;
	const stopBtn = root.querySelector<HTMLButtonElement>('[data-fl-action="stop"]')!;

	const updateTime = () => {
		const sec = Math.floor((Date.now() - startedAt) / 1000);
		const m = Math.floor(sec / 60);
		const s = sec % 60;
		timeEl.textContent = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
	};
	updateTime();
	timer = window.setInterval(updateTime, 500);

	const updateCounter = () => {
		counterEl.textContent = `${actions} action${actions === 1 ? '' : 's'}`;
	};

	noteBtn.addEventListener('click', () => {
		noteForm.classList.toggle('open');
		if (noteForm.classList.contains('open')) noteInput.focus();
	});
	noteForm.addEventListener('submit', (e) => {
		e.preventDefault();
		const text = noteInput.value.trim();
		if (text) {
			cb.onNote(text);
			noteInput.value = '';
		}
		noteForm.classList.remove('open');
	});
	noteInput.addEventListener('keydown', (e) => {
		if (e.key === 'Escape') {
			noteForm.classList.remove('open');
			noteInput.value = '';
		}
	});

	pauseBtn.addEventListener('click', () => {
		if (paused) {
			paused = false;
			cb.onResume();
		} else {
			paused = true;
			cb.onPause();
		}
		applyPaused();
	});
	stopBtn.addEventListener('click', () => cb.onStop());

	function applyPaused() {
		if (paused) {
			root.classList.add('fl-paused');
			statusEl.textContent = 'paused';
			pauseBtn.innerHTML = `${PLAY_ICON}<span>resume</span>`;
		} else {
			root.classList.remove('fl-paused');
			statusEl.textContent = 'recording';
			pauseBtn.innerHTML = `${PAUSE_ICON}<span>pause</span>`;
		}
	}

	enableDrag(root);

	return {
		root,
		bumpAction() {
			actions += 1;
			updateCounter();
		},
		setPaused(p: boolean) {
			paused = p;
			applyPaused();
		},
		destroy() {
			if (timer !== null) clearInterval(timer);
			root.remove();
			style.remove();
		},
	};
}

function enableDrag(root: HTMLElement): void {
	const handle = root.querySelector<HTMLElement>('[data-fl-drag]');
	if (!handle) return;

	let dragging = false;
	let pointerId = 0;
	let startX = 0;
	let startY = 0;
	let originLeft = 0;
	let originTop = 0;

	const onPointerDown = (e: PointerEvent) => {
		// don't start drag from buttons inside header (we have none, but defensive)
		if ((e.target as HTMLElement).closest('button')) return;
		dragging = true;
		pointerId = e.pointerId;
		root.classList.add('dragging');
		handle.setPointerCapture(pointerId);
		const rect = root.getBoundingClientRect();
		// Lock the position to absolute pixels and remove right/bottom anchors so we can drag freely.
		root.style.left = `${rect.left}px`;
		root.style.top = `${rect.top}px`;
		root.style.right = 'auto';
		root.style.bottom = 'auto';
		originLeft = rect.left;
		originTop = rect.top;
		startX = e.clientX;
		startY = e.clientY;
		e.preventDefault();
	};

	const onPointerMove = (e: PointerEvent) => {
		if (!dragging || e.pointerId !== pointerId) return;
		const dx = e.clientX - startX;
		const dy = e.clientY - startY;
		const w = root.offsetWidth;
		const h = root.offsetHeight;
		const maxX = window.innerWidth - w - 4;
		const maxY = window.innerHeight - h - 4;
		const nx = Math.min(Math.max(originLeft + dx, 4), maxX);
		const ny = Math.min(Math.max(originTop + dy, 4), maxY);
		root.style.left = `${nx}px`;
		root.style.top = `${ny}px`;
	};

	const onPointerUp = (e: PointerEvent) => {
		if (e.pointerId !== pointerId) return;
		dragging = false;
		root.classList.remove('dragging');
		try {
			handle.releasePointerCapture(pointerId);
		} catch {
			// ignore — capture may have already been lost
		}
	};

	handle.addEventListener('pointerdown', onPointerDown);
	handle.addEventListener('pointermove', onPointerMove);
	handle.addEventListener('pointerup', onPointerUp);
	handle.addEventListener('pointercancel', onPointerUp);
}
