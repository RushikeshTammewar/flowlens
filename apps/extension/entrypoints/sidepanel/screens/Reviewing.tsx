import { useEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import {
	ArrowLeft,
	ArrowUpRight,
	ChevronLeft,
	ChevronRight,
	Lock,
	Pencil,
	Save,
	Sparkles,
	Trash2,
} from 'lucide-react';
import { useAppState } from '../../../lib/state';
import { api } from '../../../lib/api-client';
import { APP_CONFIG } from '../../../app.config';
import {
	Button,
	Card,
	IconButton,
	PageShell,
	PanelFooter,
	PanelHeader,
	Pill,
	StepDot,
	Wordmark,
	useToast,
} from '../../../components/ui';
import { SiblingsModal } from './SiblingsModal';

interface FlowResp {
	flow: {
		id: string;
		name: string;
		description: string | null;
		steps: Array<{
			index: number;
			action: string;
			intent: string;
			expectedOutcome: string;
			isCritical: boolean;
			recordedScreenshotKey?: string;
			// Server-enriched public blob URL for the per-step screenshot
			// (built from BLOB_PUBLIC_BASE_URL + recordedScreenshotKey).
			recordedScreenshotUrl?: string;
		}>;
		status: string;
		// Server-enriched cookie metadata (added by /api/flows/:id when the
		// flow has a cookie_snapshots row). Optional because legacy flows
		// recorded before this enrichment landed don't have it.
		cookieSnapshot?: {
			cookieCount: number;
			authDetected: boolean;
			origin: string | null;
		} | null;
	};
}

export function Reviewing() {
	const mode = useAppState((s) => s.mode);
	const setMode = useAppState((s) => s.setMode);
	const toast = useToast();
	const [data, setData] = useState<FlowResp | null>(null);
	const [err, setErr] = useState('');
	const [name, setName] = useState('');
	const [editingName, setEditingName] = useState(false);
	const [siblings, setSiblings] = useState(false);
	const [saving, setSaving] = useState(false);
	const [active, setActive] = useState(0);
	const carouselRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		if (mode.kind !== 'reviewing') return;
		void api
			.getFlow(mode.flowId)
			.then((res) => {
				const fr = res as FlowResp;
				setData(fr);
				setName(fr.flow.name);
			})
			.catch((e) => setErr((e as Error).message));
	}, [mode]);

	if (mode.kind !== 'reviewing') return null;

	const steps = data?.flow.steps ?? [];
	const total = steps.length;
	const current = steps[Math.min(active, Math.max(0, total - 1))];

	const scrollToStep = (i: number) => {
		const el = carouselRef.current?.querySelector<HTMLDivElement>(`[data-step-card="${i}"]`);
		el?.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
	};

	const goPrev = () => {
		const next = Math.max(0, active - 1);
		setActive(next);
		scrollToStep(next);
	};
	const goNext = () => {
		const next = Math.min(total - 1, active + 1);
		setActive(next);
		scrollToStep(next);
	};

	const onSave = () => {
		setSaving(true);
		setTimeout(() => {
			setSaving(false);
			toast.push({ tone: 'success', title: 'flow saved' });
			setSiblings(true);
		}, 600);
	};

	return (
		<PageShell
			motionKey="reviewing"
			header={
				<PanelHeader>
					<div className="flex min-w-0 items-center gap-2">
						<IconButton
							size="sm"
							label="Back"
							icon={<ArrowLeft size={13} aria-hidden="true" />}
							onClick={() => setMode({ kind: 'idle', userEmail: mode.userEmail })}
						/>
						<Wordmark />
					</div>
					<Pill size="xs" variant="success" dot>
						compiled
					</Pill>
				</PanelHeader>
			}
		>
			<section className="px-3.5 py-3">
				{err && <p className="text-fl-red text-[10px]">{err}</p>}
				{!data ? (
					<div className="space-y-1.5">
						<div className="bg-fl-soft h-3 w-2/3 fl-shimmer" />
						<div className="bg-fl-soft h-3 w-full fl-shimmer" />
						<div className="bg-fl-soft h-3 w-5/6 fl-shimmer" />
					</div>
				) : (
					<>
						<div className="flex items-start justify-between gap-2">
							{editingName ? (
								<input
									autoFocus
									value={name}
									onChange={(e) => setName(e.target.value)}
									onBlur={() => setEditingName(false)}
									onKeyDown={(e) => e.key === 'Enter' && setEditingName(false)}
									className="border-fl-line bg-fl-white text-fl-black w-full border px-1.5 py-1 font-mono text-[14px] font-semibold"
								/>
							) : (
								<button
									onClick={() => setEditingName(true)}
									className="group flex min-w-0 items-baseline gap-1.5 text-left"
								>
									<h1 className="font-serif text-fl-black truncate text-[20px] leading-tight tracking-tight">
										{name || data.flow.name}
									</h1>
									<Pencil
										size={11}
										className="text-fl-gray group-hover:text-fl-black mt-1.5 shrink-0 transition-colors"
										aria-hidden="true"
									/>
								</button>
							)}
						</div>
						{data.flow.description && (
							<Card tone="info" padding="sm" className="mt-2">
								<div className="flex items-start gap-1.5 text-[11px]">
									<Sparkles size={11} className="text-fl-blue mt-0.5 shrink-0" aria-hidden="true" />
									<p className="text-fl-black">{data.flow.description}</p>
								</div>
							</Card>
						)}
					</>
				)}
			</section>

			{total > 0 && (
				<>
					<section className="px-3.5">
						<div className="flex items-center justify-between gap-2">
							<span className="text-fl-gray text-[10px] uppercase tracking-wider">
								step {active + 1} of {total}
							</span>
							<div className="flex items-center gap-1">
								<IconButton
									size="sm"
									label="Previous step"
									icon={<ChevronLeft size={13} aria-hidden="true" />}
									onClick={goPrev}
									disabled={active === 0}
								/>
								<IconButton
									size="sm"
									label="Next step"
									icon={<ChevronRight size={13} aria-hidden="true" />}
									onClick={goNext}
									disabled={active >= total - 1}
								/>
							</div>
						</div>

						<div className="mt-1.5 flex items-center gap-1 overflow-x-auto pb-1">
							{steps.map((s, i) => (
								<button
									key={s.index}
									onClick={() => {
										setActive(i);
										scrollToStep(i);
									}}
									aria-label={`Step ${i + 1}: ${s.intent}`}
								>
									{/*
									 * Reviewing is pre-replay — no step has actually passed
									 * or failed yet. Use 'running' for the actively-viewed
									 * step and 'pending' for everything else; criticality is
									 * already conveyed by the per-step `critical` pill on
									 * each card and by the carousel highlight, so we don't
									 * need to color critical-but-pending dots red (which
									 * looks alarming for a flow that hasn't run yet).
									 */}
									<StepDot index={i} status={i === active ? 'running' : 'pending'} />
								</button>
							))}
						</div>
					</section>

					<section
						ref={carouselRef}
						className="-mx-1 overflow-x-auto px-1 pt-2 [scroll-snap-type:x_mandatory]"
					>
						<div className="flex gap-2 px-2.5">
							{steps.map((s, i) => (
								<motion.div
									key={s.index}
									data-step-card={i}
									className="min-w-[300px] snap-center"
									animate={{ scale: i === active ? 1 : 0.98, opacity: i === active ? 1 : 0.6 }}
									transition={{ duration: 0.18 }}
								>
									<Card
										padding="sm"
										tone="neutral"
										title={
											<span className="flex items-center gap-1.5">
												<span className="text-fl-gray font-mono text-[10px] tabular-nums">
													{String(i + 1).padStart(2, '0')}
												</span>
												<span className="capitalize">{s.action}</span>
												{s.isCritical && (
													<Pill size="xs" variant="warn">
														critical
													</Pill>
												)}
											</span>
										}
									>
										<div className="bg-fl-soft border-fl-line aspect-[4/3] w-full overflow-hidden border">
											{s.recordedScreenshotUrl ? (
												<img
													src={s.recordedScreenshotUrl}
													alt={`Step ${i + 1} screenshot`}
													loading="lazy"
													className="h-full w-full object-cover object-top"
												/>
											) : (
												<div className="flex h-full w-full items-center justify-center text-[10px] text-fl-gray">
													screenshot unavailable
												</div>
											)}
										</div>
										<dl className="mt-2 space-y-1 text-[11px]">
											<div>
												<dt className="text-fl-gray text-[10px] uppercase tracking-wider">intent</dt>
												<dd className="text-fl-black">{s.intent}</dd>
											</div>
											<div>
												<dt className="text-fl-gray text-[10px] uppercase tracking-wider">expected</dt>
												<dd className="text-fl-black">{s.expectedOutcome}</dd>
											</div>
										</dl>
										<div className="mt-2 flex items-center gap-1.5">
											<Button size="sm" variant="ghost" leftIcon={<Pencil size={10} />}>
												edit
											</Button>
											<Button size="sm" variant="ghost" leftIcon={<Trash2 size={10} />}>
												delete
											</Button>
										</div>
									</Card>
								</motion.div>
							))}
						</div>
					</section>
				</>
			)}

			{data?.flow.cookieSnapshot ? (
				<section className="px-3.5 py-3">
					<div className="border-fl-light bg-fl-soft border px-2.5 py-2 text-[10px]">
						<div className="text-fl-gray flex items-center gap-1.5">
							<Lock size={11} className="text-fl-green" aria-hidden="true" />
							<span>
								cookies captured · {data.flow.cookieSnapshot.cookieCount} (encrypted)
								{data.flow.cookieSnapshot.authDetected ? ' · auth detected' : ''}
							</span>
						</div>
					</div>
				</section>
			) : null}

			<div className="flex-1" />

			<PanelFooter>
				<div className="flex gap-2">
					<a
						href={`${APP_CONFIG.flowlensWebUrl}/app/flows/${mode.flowId}`}
						target="_blank"
						rel="noreferrer"
						className="border-fl-line text-fl-black hover:bg-fl-soft inline-flex h-9 flex-1 items-center justify-center gap-1.5 border px-3 font-mono text-[11px] uppercase tracking-wider transition-colors"
					>
						open on web <ArrowUpRight size={11} aria-hidden="true" />
					</a>
					<Button
						className="flex-1"
						variant="primary"
						loading={saving}
						leftIcon={!saving ? <Save size={12} aria-hidden="true" /> : undefined}
						onClick={onSave}
					>
						save flow
					</Button>
				</div>
			</PanelFooter>

			<SiblingsModal
				open={siblings}
				onClose={() => setSiblings(false)}
				onConfirm={(_ids) => {
					toast.push({ tone: 'info', title: 'queued sibling runs' });
					setSiblings(false);
					setMode({ kind: 'idle', userEmail: mode.userEmail });
				}}
				onSkip={() => {
					setSiblings(false);
					setMode({ kind: 'idle', userEmail: mode.userEmail });
				}}
			/>
		</PageShell>
	);
}
