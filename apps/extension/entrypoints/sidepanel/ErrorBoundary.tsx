/**
 * Top-level error boundary for the side panel.
 *
 * Without one, any thrown render error (e.g. `useToast must be used inside
 * <ToastProvider>`) unmounts the entire React root and leaves the panel
 * body blank — the user only sees Chrome's outer side-panel chrome and has
 * no signal about what went wrong. This boundary surfaces the error inline
 * so the user can paste the message + stack into a bug report.
 *
 * Intentionally minimal: no logging service, no retry logic. The "Reload"
 * button just nukes window so Chrome re-instantiates the panel.
 */
import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
	children: ReactNode;
}

interface State {
	error: Error | null;
	info: ErrorInfo | null;
}

export class SidePanelErrorBoundary extends Component<Props, State> {
	state: State = { error: null, info: null };

	static getDerivedStateFromError(error: Error): Partial<State> {
		return { error };
	}

	componentDidCatch(error: Error, info: ErrorInfo): void {
		console.error('[Flowlens] side-panel render crashed', error, info);
		this.setState({ info });
	}

	private reload = () => {
		this.setState({ error: null, info: null });
		try {
			window.location.reload();
		} catch {
			// best-effort
		}
	};

	render() {
		const { error, info } = this.state;
		if (!error) return this.props.children;
		return (
			<main className="bg-fl-white text-fl-black flex min-h-screen flex-col gap-3 p-4 font-mono text-[11px]">
				<header className="flex items-center justify-between">
					<span className="text-fl-red font-semibold">Flowlens · render error</span>
					<button
						onClick={this.reload}
						className="border-fl-line text-fl-black hover:bg-fl-light border px-2 py-0.5 text-[10px]"
					>
						reload panel
					</button>
				</header>
				<p className="text-fl-gray">
					The side panel hit a render error. Copy the details below into a bug report so we can fix
					it. The in-page recorder overlay (if active) is unaffected.
				</p>
				<pre className="text-fl-black bg-fl-soft border-fl-line max-h-32 overflow-auto whitespace-pre-wrap break-words border p-2 text-[10px]">
					{error.name}: {error.message}
				</pre>
				{error.stack && (
					<pre className="text-fl-gray bg-fl-soft border-fl-line max-h-48 overflow-auto whitespace-pre-wrap break-words border p-2 text-[10px]">
						{error.stack}
					</pre>
				)}
				{info?.componentStack && (
					<pre className="text-fl-gray bg-fl-soft border-fl-line max-h-32 overflow-auto whitespace-pre-wrap break-words border p-2 text-[10px]">
						{info.componentStack}
					</pre>
				)}
			</main>
		);
	}
}
