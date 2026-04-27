import { useEffect } from 'react';
import { AnimatePresence } from 'framer-motion';
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

export function App() {
	const mode = useAppState((s) => s.mode);
	const setMode = useAppState((s) => s.setMode);

	useEffect(() => {
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
