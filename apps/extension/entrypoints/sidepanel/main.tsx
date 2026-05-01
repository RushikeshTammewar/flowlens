import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { ToastProvider } from '../../components/ui';
import { SidePanelErrorBoundary } from './ErrorBoundary';

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('No #root found in side panel HTML');

// `<ToastProvider>` MUST wrap `<App />` because Recording, Reviewing,
// Running, AuthRefresh, and SignedOut all call `useToast()` — which throws
// when no provider is mounted. Without the boundary above it, that throw
// would unmount the entire React tree and leave the panel body blank
// (regression that triggered the "click Record → blank panel" bug).
createRoot(rootEl).render(
	<StrictMode>
		<SidePanelErrorBoundary>
			<ToastProvider>
				<App />
			</ToastProvider>
		</SidePanelErrorBoundary>
	</StrictMode>,
);
