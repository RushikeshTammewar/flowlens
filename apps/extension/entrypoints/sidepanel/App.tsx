import { useEffect } from 'react';
import { AnimatePresence } from 'framer-motion';
import { APP_CONFIG } from '../../app.config';
import { useAppState } from '../../lib/state';
import { ToastProvider } from '../../components/ui';
import { Idle } from './screens/Idle';
import { SignedOut } from './screens/SignedOut';
import { Recording } from './screens/Recording';
import { Reviewing } from './screens/Reviewing';
import { Compiling } from './screens/Compiling';
import { FailedScreen } from './screens/Failed';
import { Running } from './screens/Running';
import { RunReport } from './screens/RunReport';
import { AuthRefresh } from './screens/AuthRefresh';
import { Loading } from './screens/Loading';

const DEMO_EMAIL = 'demo@flowlens.local';
const DEMO_MODE_ACTIVE = APP_CONFIG.demoBearer.length > 0;

export function App() {
	const mode = useAppState((s) => s.mode);
	const setMode = useAppState((s) => s.setMode);

	useEffect(() => {
		// Demo mode: skip storage probe + Clerk sign-in screen entirely. Stamp
		// a sentinel auth blob so any code that introspects chrome.storage sees
		// a consistent shape, and jump straight to Idle.
		if (DEMO_MODE_ACTIVE) {
			void chrome.storage.local.set({
				flowlens_auth_token: `flowlens-demo-${APP_CONFIG.demoBearer}`,
				flowlens_user_email: DEMO_EMAIL,
				flowlens_auth_mode: 'demo',
			});
			setMode({ kind: 'idle', userEmail: DEMO_EMAIL });
			return;
		}

		void chrome.storage.local.get(['flowlens_auth_token', 'flowlens_user_email']).then((res) => {
			const token = res.flowlens_auth_token as string | undefined;
			const email = res.flowlens_user_email as string | undefined;
			if (token && email) setMode({ kind: 'idle', userEmail: email });
			else setMode({ kind: 'signed_out' });
		});
	}, [setMode]);

	return (
		<ToastProvider>
			<main className="bg-fl-white text-fl-black flex min-h-screen flex-col font-mono">
				{DEMO_MODE_ACTIVE && (
					<div className="bg-fl-light text-fl-gray border-fl-light border-b px-3 py-1.5 text-[11px]">
						Demo mode · all flows scoped to a shared demo org
					</div>
				)}
				<AnimatePresence mode="wait" initial={false}>
					{mode.kind === 'loading' && <Loading key="loading" />}
					{mode.kind === 'signed_out' && <SignedOut key="signed_out" />}
					{mode.kind === 'idle' && <Idle key="idle" />}
					{mode.kind === 'recording' && <Recording key="recording" />}
					{mode.kind === 'reviewing' && <Reviewing key="reviewing" />}
					{mode.kind === 'compiling' && <Compiling key="compiling" />}
					{mode.kind === 'running' && <Running key="running" />}
					{mode.kind === 'run_report' && <RunReport key="run_report" />}
					{mode.kind === 'auth_refresh' && <AuthRefresh key="auth_refresh" />}
					{mode.kind === 'failed' && <FailedScreen key="failed" />}
				</AnimatePresence>
			</main>
		</ToastProvider>
	);
}
