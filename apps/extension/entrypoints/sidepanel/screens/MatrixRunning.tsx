import { useEffect, useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import { ChevronDown, ChevronRight, Eye, EyeOff } from 'lucide-react';
import { useAppState } from '../../../lib/state';
import { api, type BatchView, type BatchVariantRow } from '../../../lib/api-client';
import {
	Card,
	IconButton,
	PageShell,
	PanelHeader,
	Pill,
	Wordmark,
} from '../../../components/ui';

const PILL_BY_STATUS: Record<string, 'success' | 'danger' | 'default' | 'warn'> = {
	passed: 'success',
	failed: 'danger',
	errored: 'danger',
	running: 'warn',
	queued: 'default',
};

export function MatrixRunning() {
	const mode = useAppState((s) => s.mode);
	const setMode = useAppState((s) => s.setMode);
	const [data, setData] = useState<BatchView | null>(null);
	const [flowOpen, setFlowOpen] = useState(true);
	// Per-variant collapse state for the live iframe. Defaults open; user
	// can hide a noisy stream without losing the surrounding step dots.
	const [iframeHidden, setIframeHidden] = useState<Record<string, boolean>>({});

	useEffect(() => {
		if (mode.kind !== 'matrix_running') return;
		let stopped = false;
		const tick = async () => {
			try {
				const view = await api.getBatch(mode.batchId);
				if (stopped) return;
				setData(view);
				if (view.batch.status === 'completed' || view.batch.status === 'errored') {
					setMode({
						kind: 'matrix_report',
						userEmail: mode.userEmail,
						flowId: mode.flowId,
						batchId: mode.batchId,
					});
					return;
				}
			} catch {
				/* network blip — keep polling */
			}
			setTimeout(tick, 2500);
		};
		void tick();
		return () => {
			stopped = true;
		};
	}, [mode, setMode]);

	if (mode.kind !== 'matrix_running') return null;

	const variants = data?.variants ?? [];
	const counts = data?.counts ?? { total: 0, passed: 0, failed: 0, errored: 0, running: 0, queued: 0 };
	const flow = data?.flow ?? null;

	return (
		<PageShell
			motionKey="matrix_running"
			header={
				<PanelHeader>
					<div className="flex min-w-0 items-center gap-2">
						<Wordmark />
						<Pill size="xs" variant="warn" dot>
							batch
						</Pill>
					</div>
					<span className="text-fl-gray font-mono text-[10px] tabular-nums">
						{counts.passed}/{counts.total} passed
					</span>
				</PanelHeader>
			}
		>
			<section className="px-4 py-4">
				<h1 className="font-serif text-fl-black text-[20px] leading-tight tracking-tight">
					Edge-case batch
				</h1>
				<p className="text-fl-gray mt-1 text-[11px]">
					{counts.running} running · {counts.queued} queued · {counts.failed + counts.errored} failed
				</p>
			</section>

			{flow && (
				<section className="px-3.5 pb-3">
					<Card padding="sm" tone="info">
						<button
							type="button"
							onClick={() => setFlowOpen((v) => !v)}
							className="flex w-full items-start justify-between gap-2 text-left"
							aria-expanded={flowOpen}
						>
							<div className="min-w-0">
								<div className="text-fl-gray font-mono text-[9px] uppercase tracking-wider">
									What we think you're testing
								</div>
								<div className="text-fl-black mt-0.5 text-[12px] font-semibold leading-tight">
									{flow.name}
								</div>
							</div>
							{flowOpen ? (
								<ChevronDown size={14} className="text-fl-gray shrink-0" aria-hidden="true" />
							) : (
								<ChevronRight size={14} className="text-fl-gray shrink-0" aria-hidden="true" />
							)}
						</button>
						{flowOpen && (
							<div className="mt-2 space-y-2">
								{flow.description && (
									<p className="text-fl-black text-[11px] leading-relaxed">
										{flow.description}
									</p>
								)}
								{flow.preconditions.length > 0 && (
									<div>
										<div className="text-fl-gray font-mono text-[9px] uppercase tracking-wider">
											Preconditions
										</div>
										<ul className="mt-1 list-disc pl-4 text-[11px] text-fl-black space-y-0.5">
											{flow.preconditions.map((p, i) => (
												<li key={i}>{p}</li>
											))}
										</ul>
									</div>
								)}
								<div>
									<div className="text-fl-gray font-mono text-[9px] uppercase tracking-wider">
										Steps ({flow.steps.length})
									</div>
									<ol className="mt-1 space-y-1">
										{flow.steps.map((s) => (
											<li
												key={s.index}
												className="flex gap-2 text-[11px] leading-snug"
											>
												<span className="text-fl-gray shrink-0 font-mono tabular-nums">
													{String(s.index + 1).padStart(2, '0')}
												</span>
												<span className="text-fl-black">
													<span className="text-fl-gray font-mono text-[10px] uppercase">
														{s.action}
													</span>{' '}
													{s.intent}
												</span>
											</li>
										))}
									</ol>
								</div>
							</div>
						)}
					</Card>
				</section>
			)}

			<section className="px-3.5 pb-4 space-y-2">
				{variants.length === 0 && (
					<p className="text-fl-gray text-[11px]">Launching variants…</p>
				)}
				{variants.map((row) => (
					<VariantCard
						key={row.variant.id}
						row={row}
						iframeHidden={!!iframeHidden[row.variant.id]}
						onToggleIframe={() =>
							setIframeHidden((m) => ({
								...m,
								[row.variant.id]: !m[row.variant.id],
							}))
						}
					/>
				))}
			</section>
		</PageShell>
	);
}

interface VariantCardProps {
	row: BatchVariantRow;
	iframeHidden: boolean;
	onToggleIframe: () => void;
}

function VariantCard({ row, iframeHidden, onToggleIframe }: VariantCardProps) {
	const status = row.run?.status ?? 'queued';
	const isRunning = status === 'running';
	const liveUrl = row.run?.liveUrl ?? null;
	const showIframe = isRunning && !!liveUrl && !iframeHidden;

	// Memoize iframe so a poll-driven re-render of the parent (which fires
	// every 2.5s) doesn't reload the BU Cloud session — the iframe `src`
	// only matters once and a remount can flicker the live stream.
	const iframeNode = useMemo(() => {
		if (!liveUrl) return null;
		return (
			<iframe
				src={liveUrl}
				title={`Live replay · ${row.variant.name}`}
				className="block h-[140px] w-full border-0 bg-fl-white"
				sandbox="allow-scripts allow-same-origin"
			/>
		);
	}, [liveUrl, row.variant.name]);

	return (
		<Card padding="sm" tone="neutral">
			<div className="flex items-start justify-between gap-2">
				<div className="min-w-0">
					<div className="text-fl-black text-[12px] font-semibold leading-tight">
						{row.variant.name}
					</div>
					<div className="text-fl-gray mt-0.5 text-[10px]">
						{row.variant.family} · {row.variant.fragility} fragility
					</div>
				</div>
				<div className="flex items-center gap-1">
					{isRunning && liveUrl && (
						<IconButton
							size="sm"
							label={iframeHidden ? 'Show live stream' : 'Hide live stream'}
							icon={
								iframeHidden ? (
									<Eye size={12} aria-hidden="true" />
								) : (
									<EyeOff size={12} aria-hidden="true" />
								)
							}
							onClick={onToggleIframe}
						/>
					)}
					<Pill size="xs" variant={PILL_BY_STATUS[status] ?? 'default'}>
						{status}
					</Pill>
				</div>
			</div>

			{isRunning && (
				<div className="mt-2">
					{showIframe ? (
						<div className="border-fl-line bg-fl-black/95 overflow-hidden border">
							<div className="bg-fl-soft border-fl-line text-fl-gray flex items-center justify-between border-b px-1.5 py-0.5 text-[9px] uppercase tracking-wider">
								<span className="flex items-center gap-1">
									<span className="bg-fl-red inline-block h-1.5 w-1.5 rounded-full fl-stage-pulse" />
									live
								</span>
								<span>cloud</span>
							</div>
							{iframeNode}
						</div>
					) : (
						<div className="border-fl-line bg-fl-soft text-fl-gray flex h-[60px] items-center justify-center border text-[10px]">
							{liveUrl ? 'live stream hidden' : 'connecting to cloud browser…'}
						</div>
					)}
				</div>
			)}

			{row.stepResults.length > 0 && (
				<div className="mt-2 flex gap-1">
					{row.stepResults.map((sr) => (
						<motion.span
							key={sr.stepIndex}
							initial={{ scale: 0.8, opacity: 0 }}
							animate={{ scale: 1, opacity: 1 }}
							className={`inline-block h-1.5 w-3 ${
								sr.status === 'passed'
									? 'bg-fl-green'
									: sr.status === 'failed' || sr.status === 'inconclusive'
										? 'bg-fl-red'
										: 'bg-fl-line'
							}`}
						/>
					))}
				</div>
			)}
		</Card>
	);
}
