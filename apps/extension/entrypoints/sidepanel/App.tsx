import { useEffect, useRef } from 'react';
import { APP_CONFIG } from '../../app.config';
import { useAppState } from '../../lib/state';

// Mirror of `STORAGE_KEY` and `PersistedSession` in entrypoints/background.ts.
// We read the session storage entry directly so the side panel can rehydrate
// even when the MV3 service worker is suspended — the SW-backed
// `get_recording_state` round-trip stays as a fallback for older builds.
const ACTIVE_SESSION_KEY = 'flowlens_active_session';
interface PersistedSessionView {
	recordingId: string;
	flowId: string;
	tabId: number;
	siteOrigin: string;
	startedAt: number;
	chunksUploaded: number;
	lastFlushAt: number;
	semanticActions: unknown[];
}
import { Idle } from './screens/Idle';
import { SignedOut } from './screens/SignedOut';
import { Recording } from './screens/Recording';
import { Reviewing } from './screens/Reviewing';
import { Compiling } from './screens/Compiling';
import { ContractReview } from './screens/ContractReview';
import { FailedScreen } from './screens/Failed';
import { Running } from './screens/Running';
import { RunReport } from './screens/RunReport';
import { AuthRefresh } from './screens/AuthRefresh';
import { MatrixRunning } from './screens/MatrixRunning';
import { MatrixReport } from './screens/MatrixReport';

const DEMO_EMAIL = 'demo@flowlens.local';
const DEMO_MODE_ACTIVE = APP_CONFIG.demoBearer.length > 0;

export function App() {
	const mode = useAppState((s) => s.mode);
	const setMode = useAppState((s) => s.setMode);
	// Stable cache of the resolved user email so the storage listener can
	// always produce a well-formed mode object even if `useAppState.getState()`
	// is mid-transition (e.g. `loading` or `compiling`). Without this the
	// listener would have to fall back to `DEMO_EMAIL` for non-demo users
	// or blank string, both of which can land downstream screens in an
	// inconsistent state.
	const userEmailRef = useRef<string | null>(null);
	// Suppress storage-change reactions during the initial mount window so
	// the rehydrate path doesn't race against onStorageChanged firing for
	// the very same `chrome.storage.session` write that we're already
	// reading. Cleared 500ms after mount.
	const listenerArmedRef = useRef(false);

	useEffect(() => {
		// Rehydrate the recording state when the side panel mounts. This runs
		// every time Chrome re-instantiates the panel (focus changes, page
		// navigations on some Chrome builds, panel close-reopen). Without it
		// the panel would silently drop back to Idle while rrweb and the
		// in-page overlay keep running — the "record button vanished after
		// form submit" bug.
		//
		// Source of truth = `chrome.storage.session[ACTIVE_SESSION_KEY]`,
		// which the background SW writes on every mutation. Reading storage
		// directly works even when the SW is suspended, so we don't depend on
		// a runtime message round-trip succeeding mid-navigation.
		const applyActiveState = (active: PersistedSessionView, userEmail: string) => {
			if (!userEmail) {
				console.warn(
					'[Flowlens] applyActiveState skipped — missing userEmail',
					active.recordingId,
				);
				return;
			}
			setMode({
				kind: 'recording',
				userEmail,
				recordingId: active.recordingId,
				flowId: active.flowId,
				siteOrigin: active.siteOrigin,
				actionsCaptured: active.semanticActions.length,
			});
		};

		const rehydrateThen = async (userEmail: string, fallback: () => void) => {
			userEmailRef.current = userEmail;
			// Path A — read session storage directly. Survives SW restarts.
			try {
				const res = await chrome.storage.session.get(ACTIVE_SESSION_KEY);
				const active = res[ACTIVE_SESSION_KEY] as PersistedSessionView | undefined;
				if (active) {
					applyActiveState(active, userEmail);
					return;
				}
			} catch (err) {
				console.warn('[Flowlens] session-storage rehydrate failed', err);
			}
			// Path B — fall back to messaging the SW (older builds without
			// session-storage persistence still work via this path).
			try {
				const state = (await chrome.runtime.sendMessage({ type: 'get_recording_state' })) as
					| { active: true; recordingId: string; flowId: string; siteOrigin: string; actionsCaptured: number }
					| { active: false }
					| undefined;
				if (state?.active) {
					applyActiveState(
						{
							recordingId: state.recordingId,
							flowId: state.flowId,
							tabId: 0,
							siteOrigin: state.siteOrigin,
							startedAt: 0,
							chunksUploaded: 0,
							lastFlushAt: 0,
							semanticActions: new Array(state.actionsCaptured),
						},
						userEmail,
					);
					return;
				}
			} catch (err) {
				console.warn('[Flowlens] get_recording_state failed', err);
			}
			fallback();
		};

		// Listen for session-storage changes pushed from the background SW.
		// This keeps the panel in sync even when it doesn't re-mount —
		// e.g. the user navigates between pages while the panel stays open.
		//
		// Defensive rules (any one short-circuits the handler):
		//   1. Only react after the initial-mount armed flag flips on.
		//   2. Only react to writes to the session-storage active session key.
		//   3. Never call setMode if we can't resolve a non-empty userEmail.
		//   4. If the incoming session matches the recordingId we already
		//      have, do nothing — Idle.tsx's own setMode is the source of
		//      truth for the start_recording transition, and re-applying the
		//      same state would just retrigger Recording.tsx's mount with
		//      stale animation state.
		//   5. When the session is cleared, only fall back to Idle if we
		//      were genuinely still on the Recording screen — never override
		//      `compiling`, `failed`, or any other mid-stop transition.
		const onStorageChanged = (
			changes: Record<string, chrome.storage.StorageChange>,
			areaName: chrome.storage.AreaName,
		) => {
			if (!listenerArmedRef.current) return;
			if (areaName !== 'session') return;
			const change = changes[ACTIVE_SESSION_KEY];
			if (!change) return;
			const next = change.newValue as PersistedSessionView | undefined;
			const cur = useAppState.getState().mode;
			const cachedEmail = userEmailRef.current;
			if (next) {
				if (cur.kind === 'recording' && cur.recordingId === next.recordingId) {
					// Already on the Recording screen for this exact session —
					// the only thing that may have moved is the action count.
					// Keep the current screen but let zustand bump the count.
					const nextCount = next.semanticActions.length;
					if (cur.actionsCaptured !== nextCount) {
						setMode({ ...cur, actionsCaptured: nextCount });
					}
					return;
				}
				const liveEmail =
					cur.kind === 'recording' || cur.kind === 'idle' ? cur.userEmail : null;
				const userEmail = liveEmail ?? cachedEmail ?? '';
				if (!userEmail) {
					console.warn(
						'[Flowlens] onStorageChanged: cannot resolve userEmail; ignoring change',
						{ curKind: cur.kind, recordingId: next.recordingId },
					);
					return;
				}
				applyActiveState(next, userEmail);
			} else if (cur.kind === 'recording') {
				// Active session cleared by background (stop_recording finished).
				// Don't override mid-stop transitions like 'compiling'; only
				// reset if we were actually still on the Recording screen.
				setMode({ kind: 'idle', userEmail: cur.userEmail });
			}
		};
		chrome.storage.onChanged.addListener(onStorageChanged);
		// Arm the listener after the initial rehydrate has had a chance to
		// resolve. 500ms is generous — the rehydrate read is sub-50ms in
		// practice — but cheap insurance against double-applying the same
		// session that triggered Idle's own setMode.
		const armTimer = setTimeout(() => {
			listenerArmedRef.current = true;
		}, 500);

		if (DEMO_MODE_ACTIVE) {
			void chrome.storage.local.set({
				flowlens_auth_token: `flowlens-demo-${APP_CONFIG.demoBearer}`,
				flowlens_user_email: DEMO_EMAIL,
				flowlens_auth_mode: 'demo',
			});
			userEmailRef.current = DEMO_EMAIL;
			void rehydrateThen(DEMO_EMAIL, () => setMode({ kind: 'idle', userEmail: DEMO_EMAIL }));
			return () => {
				clearTimeout(armTimer);
				chrome.storage.onChanged.removeListener(onStorageChanged);
			};
		}
		void chrome.storage.local.get(['flowlens_auth_token', 'flowlens_user_email']).then((res) => {
			const token = res.flowlens_auth_token as string | undefined;
			const email = res.flowlens_user_email as string | undefined;
			if (token && email) {
				userEmailRef.current = email;
				void rehydrateThen(email, () => setMode({ kind: 'idle', userEmail: email }));
			} else {
				setMode({ kind: 'signed_out' });
			}
		});
		return () => {
			clearTimeout(armTimer);
			chrome.storage.onChanged.removeListener(onStorageChanged);
		};
	}, [setMode]);

	return (
		<main className="bg-fl-white text-fl-black flex min-h-screen flex-col font-mono">
			{DEMO_MODE_ACTIVE && (
				<div className="bg-fl-light text-fl-gray border-fl-light border-b px-3 py-1 text-[10px]">
					Demo mode · all flows scoped to a shared demo org
				</div>
			)}
			{mode.kind === 'loading' && <p className="text-fl-gray p-4 text-sm">Loading…</p>}
			{mode.kind === 'signed_out' && <SignedOut />}
			{mode.kind === 'idle' && <Idle />}
			{mode.kind === 'recording' && <Recording />}
			{mode.kind === 'reviewing' && <Reviewing />}
			{mode.kind === 'contract_review' && <ContractReview />}
			{mode.kind === 'compiling' && <Compiling />}
			{mode.kind === 'running' && <Running />}
			{mode.kind === 'run_report' && <RunReport />}
			{mode.kind === 'auth_refresh' && <AuthRefresh />}
			{mode.kind === 'failed' && <FailedScreen />}
			{mode.kind === 'matrix_running' && <MatrixRunning />}
			{mode.kind === 'matrix_report' && <MatrixReport />}
		</main>
	);
}
