import { useEffect, useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import {
	ArrowRight,
	Circle,
	LogOut,
	Play,
	RefreshCcw,
	Settings as SettingsIcon,
	Sparkles,
	UserRound,
} from 'lucide-react';
import { useAppState } from '../../../lib/state';
import { api } from '../../../lib/api-client';
import {
	Button,
	Card,
	EmptyState,
	FlowCardSkeleton,
	IconButton,
	PageShell,
	PanelHeader,
	Pill,
	SiteContext,
	Tabs,
	type TabItem,
	Wordmark,
	useToast,
	StepDot,
} from '../../../components/ui';
import { SettingsAccount } from './SettingsAccount';
import { SettingsSites } from './SettingsSites';

interface ActiveTab {
	tabId: number | null;
	url: string | null;
	origin: string | null;
}

interface FlowSummary {
	id: string;
	name: string;
	status: string;
	updatedAt: string;
	lastRun?: { status: string; finishedAt: string | null; healthScore: number | null } | null;
	lastDiagnosis?: string | null;
}

type IdleTab = 'all' | 'recent' | 'failing' | 'suggested';

type SettingsView = 'account' | 'sites' | null;

export function Idle() {
	const mode = useAppState((s) => s.mode);
	const setMode = useAppState((s) => s.setMode);
	const toast = useToast();

	const [tab, setTab] = useState<ActiveTab>({ tabId: null, url: null, origin: null });
	const [flows, setFlows] = useState<FlowSummary[]>([]);
	const [loading, setLoading] = useState(true);
	const [busy, setBusy] = useState(false);
	const [running, setRunning] = useState<string | null>(null);
	const [err, setErr] = useState('');
	const [active, setActive] = useState<IdleTab>('all');
	const [settings, setSettings] = useState<SettingsView>(null);

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
		const load = async () => {
			setLoading(true);
			try {
				const res = await api.listFlows({});
				setFlows((res.flows as FlowSummary[]) ?? []);
			} catch {
				// no-op — show empty state
			} finally {
				setLoading(false);
			}
		};
		void load();
	}, []);

	const counts = useMemo(() => {
		const failing = flows.filter((f) => f.lastRun?.status === 'failed').length;
		const recent = flows.slice(0, 5).length;
		return { all: flows.length, recent, failing, suggested: 0 };
	}, [flows]);

	const filtered = useMemo(() => {
		if (active === 'failing') return flows.filter((f) => f.lastRun?.status === 'failed');
		if (active === 'recent') {
			return [...flows]
				.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
				.slice(0, 5);
		}
		if (active === 'suggested') return [];
		return flows;
	}, [flows, active]);

	if (mode.kind !== 'idle') return null;

	const tabs: ReadonlyArray<TabItem<IdleTab>> = [
		{ id: 'all', label: 'all', count: counts.all },
		{ id: 'recent', label: 'recent', count: counts.recent },
		{ id: 'failing', label: 'failing', count: counts.failing },
		{ id: 'suggested', label: 'suggested' },
	];

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
			const msg = (e as Error).message;
			setErr(msg);
			toast.push({ tone: 'error', title: 'Failed to start run', body: msg });
		} finally {
			setRunning(null);
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
			toast.push({ tone: 'success', title: 'Recording started', body: 'demonstrate the flow.' });
			setMode({
				kind: 'recording',
				userEmail: mode.userEmail,
				recordingId: res.recordingId,
				flowId: res.flowId,
				siteOrigin: tab.origin,
				actionsCaptured: 0,
			});
		} catch (e) {
			const msg = (e as Error).message;
			setErr(msg);
			toast.push({ tone: 'error', title: 'Could not start', body: msg });
		} finally {
			setBusy(false);
		}
	};

	const signOut = () => {
		void chrome.storage.local.remove(['flowlens_auth_token', 'flowlens_user_email']);
		setMode({ kind: 'signed_out' });
	};

	if (settings === 'account') {
		return <SettingsAccount onBack={() => setSettings(null)} userEmail={mode.userEmail} />;
	}
	if (settings === 'sites') {
		return <SettingsSites onBack={() => setSettings(null)} />;
	}

	const hostName = tab.origin ? hostFromOrigin(tab.origin) : null;

	return (
		<PageShell
			motionKey="idle"
			header={
				<PanelHeader>
					<div className="flex min-w-0 items-center gap-2">
						<Wordmark version="3" />
					</div>
					<div className="flex items-center gap-1">
						<IconButton
							size="sm"
							label="Settings"
							icon={<SettingsIcon size={13} aria-hidden="true" />}
							onClick={() => setSettings('sites')}
						/>
						<IconButton
							size="sm"
							label="Account"
							icon={<UserRound size={13} aria-hidden="true" />}
							onClick={() => setSettings('account')}
						/>
						<IconButton
							size="sm"
							label="Sign out"
							icon={<LogOut size={13} aria-hidden="true" />}
							onClick={signOut}
						/>
					</div>
				</PanelHeader>
			}
		>
			<div className="border-fl-light flex items-center justify-between gap-2 border-b px-3.5 py-1.5">
				<SiteContext host={hostName} />
				<Pill size="xs" variant="default" dot>
					{mode.userEmail.includes('@') ? mode.userEmail : 'signed in'}
				</Pill>
			</div>

			<section className="px-3.5 pb-3 pt-3">
				<RecordCTA busy={busy} disabled={!tab.origin} onClick={startRecord} hostName={hostName} />
				{!tab.origin && (
					<p className="text-fl-gray mt-2 text-[10px]">Open a site in this tab first.</p>
				)}
				{err && <p className="text-fl-red mt-2 text-[10px]">{err}</p>}
			</section>

			<section className="px-3.5">
				<Tabs items={tabs} value={active} onChange={setActive} />
			</section>

			<section className="px-3.5 py-3">
				{loading ? (
					<div className="space-y-1.5">
						<FlowCardSkeleton />
						<FlowCardSkeleton />
						<FlowCardSkeleton />
					</div>
				) : filtered.length === 0 ? (
					<EmptyState
						icon={<Circle size={20} />}
						title={
							active === 'failing'
								? 'no failing flows'
								: active === 'suggested'
									? 'no suggestions yet'
									: 'no flows yet'
						}
						body={
							active === 'failing'
								? 'all clear — your flows are passing.'
								: active === 'suggested'
									? 'record a flow first; we suggest siblings after the first save.'
									: 'demonstrate a flow above and we handle the rest.'
						}
					/>
				) : (
					<ul className="space-y-1.5">
						{filtered.slice(0, 12).map((f) => (
							<FlowRow
								key={f.id}
								flow={f}
								running={running === f.id}
								onRun={() => void runFlow(f.id)}
							/>
						))}
					</ul>
				)}
			</section>

			<section className="border-fl-light flex-1 border-t px-3.5 py-3">
				<header className="mb-1.5 flex items-baseline justify-between">
					<h3 className="text-fl-gray text-[10px] uppercase tracking-wider">recent runs</h3>
					<a
						className="text-fl-gray hover:text-fl-black text-[10px] underline-offset-2 hover:underline"
						href="#"
					>
						view all on web →
					</a>
				</header>
				<RecentRuns flows={flows.slice(0, 4)} />
			</section>

			<footer className="border-fl-light bg-fl-soft sticky bottom-0 flex items-center justify-between gap-2 border-t px-3.5 py-2">
				<div className="flex items-center gap-2 text-[10px]">
					<Pill variant="success" dot size="xs">
						auth fresh
					</Pill>
					<span className="text-fl-gray">expires in 9 d</span>
				</div>
				<button
					type="button"
					className="text-fl-gray hover:text-fl-black inline-flex items-center gap-1 text-[10px] uppercase tracking-wider"
				>
					<RefreshCcw size={10} aria-hidden="true" /> refresh
				</button>
			</footer>
		</PageShell>
	);
}

function RecordCTA({
	busy,
	disabled,
	onClick,
	hostName,
}: {
	busy: boolean;
	disabled: boolean;
	onClick: () => void;
	hostName: string | null;
}) {
	return (
		<motion.button
			whileHover={{ y: disabled ? 0 : -1 }}
			whileTap={{ y: 0 }}
			transition={{ duration: 0.15 }}
			onClick={onClick}
			disabled={disabled || busy}
			className="group bg-fl-cta relative w-full overflow-hidden border border-fl-cta/40 px-4 py-3 text-left text-fl-white transition-shadow duration-200 ease-out hover:shadow-[0_2px_6px_rgba(15,15,15,0.08),0_12px_24px_rgba(15,15,15,0.10)] disabled:cursor-not-allowed disabled:opacity-60"
			style={{
				backgroundImage: 'linear-gradient(180deg, #1f6e37 0%, #174f27 100%)',
			}}
		>
			<span
				aria-hidden="true"
				className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/20 to-transparent"
			/>
			<div className="flex items-center gap-3">
				<motion.span
					animate={busy ? { scale: [1, 1.12, 1] } : { scale: 1 }}
					transition={busy ? { duration: 1.4, repeat: Infinity, ease: 'easeInOut' } : { duration: 0 }}
					className="relative inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-fl-red shadow-[inset_0_0_0_2px_rgba(255,255,255,0.18)]"
				>
					<span className="block h-2 w-2 rounded-full bg-fl-white" />
				</motion.span>
				<div className="min-w-0 flex-1">
					<div className="font-mono text-[12px] font-semibold uppercase tracking-wider">
						{busy ? 'starting…' : 'record a flow'}
					</div>
					<div className="text-fl-white/70 truncate font-mono text-[10px]">
						{hostName ? `capture what to test on ${hostName}` : 'open a site in this tab first'}
					</div>
				</div>
				<ArrowRight
					size={14}
					className="transition-transform duration-200 group-hover:translate-x-0.5"
					aria-hidden="true"
				/>
			</div>
		</motion.button>
	);
}

function FlowRow({
	flow,
	running,
	onRun,
}: {
	flow: FlowSummary;
	running: boolean;
	onRun: () => void;
}) {
	const isFailing = flow.lastRun?.status === 'failed';
	const isPassing = flow.lastRun?.status === 'passed';
	return (
		<motion.li
			layout
			initial={{ opacity: 0, y: 4 }}
			animate={{ opacity: 1, y: 0 }}
			transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
		>
			<Card
				interactive
				padding="sm"
				className="group"
				tone={isFailing ? 'danger' : 'neutral'}
			>
				<div className="flex items-center gap-2">
					<StatusGlyph status={flow.lastRun?.status ?? flow.status} />
					<div className="min-w-0 flex-1">
						<div className="text-fl-black truncate text-[11px] font-semibold">{flow.name}</div>
						<div className="text-fl-gray flex items-center gap-1.5 text-[10px]">
							<span>last run · {timeAgo(flow.lastRun?.finishedAt ?? flow.updatedAt)}</span>
							{isFailing && <Pill size="xs" variant="danger">failed</Pill>}
							{isPassing && <Pill size="xs" variant="success">passed</Pill>}
						</div>
					</div>
					<Button
						size="sm"
						variant={isFailing ? 'danger' : 'dark'}
						loading={running}
						onClick={onRun}
						leftIcon={!running ? <Play size={10} aria-hidden="true" /> : undefined}
						disabled={flow.status !== 'ready'}
					>
						run
					</Button>
				</div>
				{isFailing && flow.lastDiagnosis && (
					<div className="text-fl-red mt-1.5 flex items-start gap-1 border-t border-fl-red/20 pt-1.5 text-[10px]">
						<Sparkles size={10} className="mt-px shrink-0" aria-hidden="true" />
						<span className="line-clamp-2">{flow.lastDiagnosis}</span>
					</div>
				)}
			</Card>
		</motion.li>
	);
}

function StatusGlyph({ status }: { status: string }) {
	if (status === 'passed' || status === 'ready') {
		return <span className="bg-fl-green inline-block h-2 w-2 rounded-full" aria-hidden="true" />;
	}
	if (status === 'failed') {
		return <span className="bg-fl-red inline-block h-2 w-2 rounded-full" aria-hidden="true" />;
	}
	if (status === 'compiling') {
		return <span className="bg-fl-amber fl-stage-pulse inline-block h-2 w-2 rounded-full" aria-hidden="true" />;
	}
	return <span className="bg-fl-line inline-block h-2 w-2 rounded-full" aria-hidden="true" />;
}

function RecentRuns({ flows }: { flows: FlowSummary[] }) {
	if (flows.length === 0) {
		return <p className="text-fl-gray text-[10px]">no recent runs.</p>;
	}
	return (
		<ul className="space-y-1">
			{flows.map((f, i) => (
				<li key={f.id} className="flex items-center gap-1.5 text-[10px]">
					<StepDot
						status={f.lastRun?.status === 'passed' ? 'passed' : f.lastRun?.status === 'failed' ? 'failed' : 'pending'}
						index={i}
					/>
					<span className="text-fl-black flex-1 truncate">{f.name}</span>
					<span className="text-fl-gray font-mono">{timeAgo(f.lastRun?.finishedAt ?? f.updatedAt)}</span>
				</li>
			))}
		</ul>
	);
}

function timeAgo(iso?: string | null): string {
	if (!iso) return '—';
	const ms = Date.now() - new Date(iso).getTime();
	if (Number.isNaN(ms)) return '—';
	const m = Math.round(ms / 60000);
	if (m < 1) return 'just now';
	if (m < 60) return `${m}m ago`;
	const h = Math.round(m / 60);
	if (h < 24) return `${h}h ago`;
	const d = Math.round(h / 24);
	return `${d}d ago`;
}

function hostFromOrigin(origin: string): string {
	try {
		return new URL(origin).host;
	} catch {
		return origin;
	}
}
