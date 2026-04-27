import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { Check, ExternalLink, Lock, ShieldAlert } from 'lucide-react';
import { useAppState } from '../../../lib/state';
import { api } from '../../../lib/api-client';
import {
	Button,
	Card,
	IconButton,
	PageShell,
	PanelFooter,
	PanelHeader,
	Pill,
	Wordmark,
	useToast,
} from '../../../components/ui';

type StepState = 'pending' | 'active' | 'done';

interface StepDef {
	id: 'open' | 'login' | 'click';
	title: string;
	body: string;
}

const STEPS: ReadonlyArray<StepDef> = [
	{ id: 'open', title: 'open the site', body: 'in this tab, navigate to your site.' },
	{ id: 'login', title: 'log in', body: 'we never see your password.' },
	{ id: 'click', title: 'click below', body: 'we capture fresh cookies and resume.' },
];

export function AuthRefresh() {
	const mode = useAppState((s) => s.mode);
	const setMode = useAppState((s) => s.setMode);
	const toast = useToast();
	const [busy, setBusy] = useState(false);
	const [err, setErr] = useState('');
	const [openedAt, setOpenedAt] = useState<number | null>(null);

	useEffect(() => {
		if (mode.kind !== 'auth_refresh') return;
		if (!mode.siteOrigin) return;
	}, [mode]);

	if (mode.kind !== 'auth_refresh') return null;

	const states: Record<StepDef['id'], StepState> =
		busy
			? { open: 'done', login: 'done', click: 'active' }
			: openedAt
				? { open: 'done', login: 'active', click: 'pending' }
				: { open: 'active', login: 'pending', click: 'pending' };

	const openSite = () => {
		if (mode.siteOrigin) {
			void chrome.tabs.create({ url: mode.siteOrigin });
			setOpenedAt(Date.now());
		}
	};

	const refresh = async () => {
		setBusy(true);
		setErr('');
		try {
			const [tab] = await new Promise<chrome.tabs.Tab[]>((resolve) =>
				chrome.tabs.query({ active: true, currentWindow: true }, resolve),
			);
			if (!tab?.id || !tab.url) throw new Error('no active tab');
			const captured = (await chrome.runtime.sendMessage({
				type: 'capture_cookies_and_storage',
				tabId: tab.id,
				url: tab.url,
			})) as {
				cookies: unknown[];
				storage: { localStorage: Record<string, string>; sessionStorage: Record<string, string> };
				origin: string;
			};
			await api.refreshCookies({
				siteOrigin: captured.origin,
				cookies: captured.cookies,
				storage: captured.storage,
				triggeredByRunId: mode.runId,
			});
			toast.push({ tone: 'success', title: 'auth refreshed' });
			setMode({ kind: 'idle', userEmail: mode.userEmail });
		} catch (e) {
			const msg = (e as Error).message;
			setErr(msg);
			toast.push({ tone: 'error', title: 'refresh failed', body: msg });
		} finally {
			setBusy(false);
		}
	};

	return (
		<PageShell
			motionKey="auth_refresh"
			header={
				<PanelHeader>
					<div className="flex min-w-0 items-center gap-2">
						<Wordmark />
						<Pill size="xs" variant="warn" dot>
							auth expired
						</Pill>
					</div>
					<IconButton
						size="sm"
						label="Cancel"
						icon={<ExternalLink size={13} aria-hidden="true" />}
						onClick={() => setMode({ kind: 'idle', userEmail: mode.userEmail })}
					/>
				</PanelHeader>
			}
		>
			<section className="px-4 pt-4 text-center">
				<motion.span
					initial={{ scale: 0.8, opacity: 0 }}
					animate={{ scale: 1, opacity: 1 }}
					transition={{ type: 'spring', damping: 18, stiffness: 220 }}
					className="border-fl-amber bg-fl-amber-bg text-fl-amber inline-flex h-9 w-9 items-center justify-center border"
				>
					<ShieldAlert size={18} aria-hidden="true" />
				</motion.span>
				<h1 className="font-serif text-fl-black mt-2 text-[20px] leading-tight tracking-tight">
					Refresh auth
				</h1>
				<p className="text-fl-gray mt-1 text-[11px]">{mode.hint || 'cookies expired — log in again to resume.'}</p>
			</section>

			<section className="px-3.5 pt-4">
				<ol className="space-y-2">
					{STEPS.map((step, i) => {
						const state = states[step.id];
						return (
							<motion.li
								key={step.id}
								layout
								initial={false}
								animate={{ opacity: state === 'pending' ? 0.5 : 1 }}
								className="flex gap-3"
							>
								<StepBubble n={i + 1} state={state} />
								<div className="min-w-0 flex-1 pt-0.5">
									<div
										className={`text-[11px] font-mono uppercase tracking-wider ${
											state === 'pending' ? 'text-fl-gray' : 'text-fl-black'
										}`}
									>
										{step.title}
									</div>
									<div className="text-fl-gray mt-0.5 text-[10px]">{step.body}</div>
								</div>
							</motion.li>
						);
					})}
				</ol>

				<div className="mt-4 space-y-2">
					{!openedAt && (
						<Button
							block
							size="lg"
							variant="secondary"
							onClick={openSite}
							rightIcon={<ExternalLink size={12} aria-hidden="true" />}
						>
							open site
						</Button>
					)}
					<Button
						block
						size="lg"
						variant="primary"
						loading={busy}
						onClick={refresh}
					>
						i&apos;m logged in — refresh auth
					</Button>
				</div>
				{err && <p className="text-fl-red mt-2 break-words text-[10px]">{err}</p>}
			</section>

			<section className="border-fl-light mt-4 border-t px-3.5 py-3 text-[10px]">
				<Card padding="sm" tone="neutral">
					<div className="text-fl-gray flex items-start gap-1.5">
						<Lock size={11} className="text-fl-green mt-px shrink-0" aria-hidden="true" />
						<div>
							We capture fresh cookies (encrypted), update the test profile, and resume the
							paused run.
						</div>
					</div>
				</Card>
			</section>

			<div className="flex-1" />

			<PanelFooter>
				<Button
					block
					variant="ghost"
					size="md"
					onClick={() => setMode({ kind: 'idle', userEmail: mode.userEmail })}
				>
					cancel and stop run
				</Button>
			</PanelFooter>
		</PageShell>
	);
}

function StepBubble({ n, state }: { n: number; state: StepState }) {
	const ringMap: Record<StepState, string> = {
		pending: 'border-fl-line bg-fl-white text-fl-gray',
		active: 'border-fl-cta bg-fl-cta/5 text-fl-cta shadow-[0_0_0_3px_rgba(26,92,46,0.10)]',
		done: 'border-fl-green bg-fl-green text-fl-white',
	};
	return (
		<span
			className={`mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center border font-mono text-[11px] tabular-nums transition-colors ${ringMap[state]}`}
		>
			{state === 'done' ? <Check size={12} aria-hidden="true" /> : n}
		</span>
	);
}
