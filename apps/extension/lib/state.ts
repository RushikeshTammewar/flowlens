/**
 * Extension state machine. Owned by the side panel; the service worker
 * mutates it via `chrome.runtime.sendMessage` events.
 *
 * Lifecycle: idle → recording → reviewing → compiling → idle (saved)
 *                                       └─→ failed → idle
 */
import { create } from 'zustand';

export type AppMode =
	| { kind: 'loading' }
	| { kind: 'signed_out' }
	| { kind: 'idle'; userEmail: string }
	| { kind: 'recording'; userEmail: string; recordingId: string; flowId: string; siteOrigin: string; actionsCaptured: number }
	| { kind: 'reviewing'; userEmail: string; flowId: string }
	| { kind: 'compiling'; userEmail: string; flowId: string; pct: number; stage: string }
	| { kind: 'running'; userEmail: string; flowId: string; runId: string; liveUrl: string | null; currentStepIndex: number; stepResults: SidePanelStepResult[] }
	| { kind: 'run_report'; userEmail: string; flowId: string; runId: string; status: string; healthScore: number | null; summary: string; stepResults: SidePanelStepResult[] }
	| { kind: 'auth_refresh'; userEmail: string; runId: string; siteOrigin: string; hint: string }
	| { kind: 'failed'; userEmail: string; reason: string }
	// Test-Matrix screens
	| { kind: 'matrix_running'; userEmail: string; flowId: string; batchId: string }
	| { kind: 'matrix_report'; userEmail: string; flowId: string; batchId: string };

export interface SidePanelStepResult {
	stepIndex: number;
	status:
		| 'pending'
		| 'in_progress'
		| 'passed'
		| 'failed'
		| 'flaky'
		| 'blocked_auth'
		| 'inconclusive'
		| 'skipped';
	intent?: string;
	durationMs?: number;
	errorMessage?: string;
}

export interface AppState {
	mode: AppMode;
	setMode: (m: AppMode) => void;
	bumpActionCount: () => void;
	updateStepResult: (r: SidePanelStepResult) => void;
}

export const useAppState = create<AppState>((set, get) => ({
	mode: { kind: 'loading' },
	setMode: (m) => set({ mode: m }),
	bumpActionCount: () => {
		const m = get().mode;
		if (m.kind !== 'recording') return;
		set({ mode: { ...m, actionsCaptured: m.actionsCaptured + 1 } });
	},
	updateStepResult: (r) => {
		const m = get().mode;
		if (m.kind !== 'running') return;
		const existing = m.stepResults.find((s) => s.stepIndex === r.stepIndex);
		const next = existing
			? m.stepResults.map((s) => (s.stepIndex === r.stepIndex ? { ...s, ...r } : s))
			: [...m.stepResults, r];
		set({ mode: { ...m, stepResults: next, currentStepIndex: r.stepIndex } });
	},
}));
