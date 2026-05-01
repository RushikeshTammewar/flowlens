import { useEffect, useState } from 'react';
import { useAppState } from '../../../lib/state';
import { api } from '../../../lib/api-client';
import { APP_CONFIG } from '../../../app.config';

interface ActiveTab {
	tabId: number | null;
	url: string | null;
	origin: string | null;
}

type MatrixSize = 5 | 10 | 20;

export function Idle() {
	const mode = useAppState((s) => s.mode);
	const setMode = useAppState((s) => s.setMode);
	const [tab, setTab] = useState<ActiveTab>({ tabId: null, url: null, origin: null });
	const [flows, setFlows] = useState<Array<{ id: string; name: string; status: string; updatedAt: string }>>([]);
	const [busy, setBusy] = useState(false);
	const [running, setRunning] = useState<string | null>(null);
	const [matrixBusy, setMatrixBusy] = useState<string | null>(null);
	const [pickerFor, setPickerFor] = useState<string | null>(null);
	const [err, setErr] = useState('');

	useEffect(() => {
		void chrome.tabs.query({ active: true, currentWindow: true }, ([t]) => {
			if (t?.url && typeof t.id === 'number') {
				try {
					const u = new URL(t.url);
					setTab({ tabId: t.id, url: t.url, origin: u.origin });
				} catch {
					setTab({ tabId: t.id, url: t.url, origin: null });
				}
			}
		});
	}, []);

	useEffect(() => {
		// Lazy-load the user's flows — best-effort; fails silently if API unavailable.
		const load = async () => {
			try {
				const { api } = await import('../../../lib/api-client');
				const res = await api.listFlows({});
				setFlows(
					(res.flows as Array<{ id: string; name: string; status: string; updatedAt: string }>) ?? [],
				);
			} catch {
				// no-op
			}
		};
		void load();
	}, []);

	if (mode.kind !== 'idle') return null;

	const runFlow = async (flowId: string) => {
		setRunning(flowId);
		setErr('');
		try {
			const { runId } = await api.startRun(flowId, 'hybrid');
			setMode({
				kind: 'running',
				userEmail: mode.userEmail,
				flowId,
				runId,
				liveUrl: null,
				currentStepIndex: -1,
				stepResults: [],
			});
		} catch (e) {
			setErr((e as Error).message);
		} finally {
			setRunning(null);
		}
	};

	const runMatrix = async (flowId: string, count: MatrixSize) => {
		setMatrixBusy(flowId);
		setPickerFor(null);
		setErr('');
		try {
			const token = APP_CONFIG.demoBearer
				? `flowlens-demo-${APP_CONFIG.demoBearer}`
				: '';

			// Step 1: ensure variants exist (generate if missing or count requested differs).
			const listRes = await fetch(
				`${APP_CONFIG.apiUrl}/api/flows/${flowId}/test-matrix`,
				{ headers: token ? { Authorization: `Bearer ${token}` } : {} },
			);
			if (!listRes.ok) throw new Error(`list variants failed: ${listRes.status}`);
			const listJson = (await listRes.json()) as {
				variants: Array<{ id: string }>;
			};
			let variantIds = listJson.variants.map((v) => v.id);
			if (variantIds.length === 0) {
				const genRes = await fetch(
					`${APP_CONFIG.apiUrl}/api/flows/${flowId}/test-matrix`,
					{
						method: 'POST',
						headers: {
							'Content-Type': 'application/json',
							...(token ? { Authorization: `Bearer ${token}` } : {}),
						},
						body: JSON.stringify({ count }),
					},
				);
				if (!genRes.ok) throw new Error(`generate variants failed: ${genRes.status}`);
				const genJson = (await genRes.json()) as {
					variants: Array<{ id: string }>;
				};
				variantIds = genJson.variants.map((v) => v.id);
			}

			// Step 2: kick off batch.
			const batchRes = await fetch(
				`${APP_CONFIG.apiUrl}/api/flows/${flowId}/runs/batch`,
				{
					method: 'POST',
					headers: {
						'Content-Type': 'application/json',
						...(token ? { Authorization: `Bearer ${token}` } : {}),
					},
					body: JSON.stringify({ variantIds: variantIds.slice(0, count) }),
				},
			);
			if (!batchRes.ok) throw new Error(`start batch failed: ${batchRes.status}`);
			const batchJson = (await batchRes.json()) as { batchId: string };

			setMode({
				kind: 'matrix_running',
				userEmail: mode.userEmail,
				flowId,
				batchId: batchJson.batchId,
			});
		} catch (e) {
			setErr((e as Error).message);
		} finally {
			setMatrixBusy(null);
		}
	};

	const startRecord = async () => {
		if (!tab.tabId || !tab.origin) return;
		setBusy(true);
		setErr('');
		try {
			const res = (await chrome.runtime.sendMessage({
				type: 'start_recording',
				tabId: tab.tabId,
				siteOrigin: tab.origin,
				displayName: hostFromOrigin(tab.origin),
				viewport: { w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio || 1 },
				userAgent: navigator.userAgent,
			})) as { ok: boolean; recordingId?: string; flowId?: string; reason?: string };
			if (!res?.ok || !res.recordingId || !res.flowId) {
				throw new Error(res?.reason ?? 'failed to start');
			}
			setMode({
				kind: 'recording',
				userEmail: mode.userEmail,
				recordingId: res.recordingId,
				flowId: res.flowId,
				siteOrigin: tab.origin,
				actionsCaptured: 0,
			});
		} catch (e) {
			setErr((e as Error).message);
		} finally {
			setBusy(false);
		}
	};

	return (
		<>
			<header className="border-fl-light flex items-center justify-between border-b px-4 py-3">
				<div className="flex items-center gap-2">
					<span className="font-mono text-sm font-semibold">Flowlens</span>
					<span className="text-fl-gray text-xs">{tab.origin ? hostFromOrigin(tab.origin) : 'no site'}</span>
				</div>
				<button
					onClick={() => {
						void chrome.storage.local.remove(['flowlens_auth_token', 'flowlens_user_email']);
						setMode({ kind: 'signed_out' });
					}}
					className="text-fl-gray hover:text-fl-black text-xs"
				>
					sign out
				</button>
			</header>

			<section className="px-4 py-4">
				<button
					onClick={startRecord}
					disabled={busy || !tab.origin}
					className="bg-fl-cta text-fl-white hover:bg-fl-cta/90 disabled:bg-fl-light disabled:text-fl-gray w-full rounded-none px-4 py-3 text-xs uppercase tracking-wider disabled:cursor-not-allowed"
				>
					{busy ? 'starting…' : '● Record a flow'}
				</button>
				{!tab.origin && (
					<p className="text-fl-gray mt-2 text-[11px]">Open a site in this tab first.</p>
				)}
				{err && <p className="text-fl-red mt-2 text-[11px]">{err}</p>}
			</section>

			<section className="border-fl-light flex-1 border-t px-4 py-3">
				<h2 className="text-fl-gray mb-2 text-[11px] uppercase tracking-wider">Flows</h2>
				{flows.length === 0 ? (
					<p className="text-fl-gray text-xs">No flows yet. Demonstrate one and we&apos;ll handle the rest.</p>
				) : (
					<ul className="space-y-2">
						{flows.slice(0, 10).map((f) => (
							<li key={f.id} className="border-fl-light border-b pb-2 text-xs">
								<div className="flex items-center gap-2">
									<span className={statusColor(f.status)}>{statusGlyph(f.status)}</span>
									<span className="flex-1 truncate">{f.name}</span>
									<button
										disabled={f.status !== 'ready' || running === f.id}
										onClick={() => void runFlow(f.id)}
										className="bg-fl-black text-fl-white hover:bg-fl-black/90 disabled:bg-fl-light disabled:text-fl-gray rounded-none px-2 py-1 text-[10px] uppercase tracking-wider disabled:cursor-not-allowed"
									>
										{running === f.id ? 'starting…' : '▶ run'}
									</button>
								</div>
								{f.status === 'ready' && (
									<div className="mt-1.5 flex items-center gap-1.5">
										<button
											onClick={() => setPickerFor(pickerFor === f.id ? null : f.id)}
											disabled={matrixBusy === f.id}
											className="text-fl-cta hover:text-fl-cta/80 text-[10px] underline-offset-2 hover:underline disabled:opacity-50"
										>
											{matrixBusy === f.id ? 'starting…' : '✦ Run with edge cases'}
										</button>
										{pickerFor === f.id && (
											<div className="flex items-center gap-1">
												<span className="text-fl-gray text-[10px]">size:</span>
												{[5, 10, 20].map((n) => (
													<button
														key={n}
														onClick={() => void runMatrix(f.id, n as MatrixSize)}
														className="bg-fl-light hover:bg-fl-cta hover:text-fl-white px-1.5 py-0.5 text-[10px]"
													>
														{n}
													</button>
												))}
											</div>
										)}
									</div>
								)}
							</li>
						))}
					</ul>
				)}
			</section>
		</>
	);
}

function statusGlyph(s: string): string {
	if (s === 'ready') return '✓';
	if (s === 'compiling') return '●';
	if (s === 'archived') return '×';
	return '·';
}
function statusColor(s: string): string {
	if (s === 'ready') return 'text-fl-green';
	if (s === 'compiling') return 'text-fl-amber';
	if (s === 'archived') return 'text-fl-gray';
	return 'text-fl-gray';
}
function hostFromOrigin(origin: string): string {
	try {
		return new URL(origin).host;
	} catch {
		return origin;
	}
}
