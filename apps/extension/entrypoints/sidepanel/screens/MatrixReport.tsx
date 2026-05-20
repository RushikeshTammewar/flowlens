import { useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { ArrowUpRight, X } from 'lucide-react';
import { useAppState } from '../../../lib/state';
import {
	api,
	type BatchView,
	type BatchStepResult,
	type BatchVariantRow,
	type BehaviorVerdictView,
	type Phase4Mode,
} from '../../../lib/api-client';
import { APP_CONFIG } from '../../../app.config';
import {
	Button,
	Card,
	IconButton,
	PageShell,
	PanelFooter,
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

const MODE_ORDER: Phase4Mode[] = ['verify', 'edge', 'stress', 'adversarial', 'invariant'];
const MODE_LABEL: Record<Phase4Mode, string> = {
	verify: 'Verify',
	edge: 'Edge',
	stress: 'Stress',
	adversarial: 'Adv',
	invariant: 'Inv',
};

interface LightboxState {
	src: string;
	caption: string;
}

export function MatrixReport() {
	const mode = useAppState((s) => s.mode);
	const setMode = useAppState((s) => s.setMode);
	const [data, setData] = useState<BatchView | null>(null);
	const [lightbox, setLightbox] = useState<LightboxState | null>(null);

	useEffect(() => {
		if (mode.kind !== 'matrix_report') return;
		void api.getBatch(mode.batchId).then(setData).catch(() => setData(null));
	}, [mode]);

	useEffect(() => {
		if (!lightbox) return;
		const onKey = (e: KeyboardEvent) => {
			if (e.key === 'Escape') setLightbox(null);
		};
		window.addEventListener('keydown', onKey);
		return () => window.removeEventListener('keydown', onKey);
	}, [lightbox]);

	if (mode.kind !== 'matrix_report') return null;

	const counts = data?.counts ?? { total: 0, passed: 0, failed: 0, errored: 0, running: 0, queued: 0 };
	const passRate = counts.total > 0 ? Math.round((counts.passed / counts.total) * 100) : 0;

	// Phase 4 / Tier 4 — two-axis verdict + behavior×mode grid (UX §6.7).
	// Falls back to the legacy variant-card list when no Phase 4 data is
	// present (V1 / Phase 3 batches, e.g. re-runs of pre-Phase-4 flows).
	const phase4Active = (data?.batch.behaviorVerdicts?.length ?? 0) > 0
		|| (data?.variants?.some((v) => v.variant.mode) ?? false);
	const correctness = data?.batch
		? {
				verified: data.batch.correctnessVerifiedCount,
				total: data.batch.correctnessTotalCount,
			}
		: { verified: 0, total: 0 };
	const robustness = data?.batch
		? {
				verified: data.batch.robustnessVerifiedCount,
				total: data.batch.robustnessTotalCount,
			}
		: { verified: 0, total: 0 };

	const grid = useMemo(() => buildReportGrid(data?.variants ?? []), [data?.variants]);

	const reportUrl = `${APP_CONFIG.flowlensWebUrl}/app/features/${mode.flowId}/runs/${mode.batchId}`;

	return (
		<PageShell
			motionKey="matrix_report"
			header={
				<PanelHeader>
					<Wordmark />
					<Pill
						size="xs"
						variant={passRate === 100 ? 'success' : passRate > 60 ? 'warn' : 'danger'}
					>
						{passRate}% pass
					</Pill>
				</PanelHeader>
			}
		>
			<section className="px-4 py-4">
				<h1 className="font-serif text-fl-black text-[22px] leading-tight tracking-tight">
					{phase4Active ? data?.flow?.name ?? 'Run report' : 'Edge-case report'}
				</h1>
				<p className="text-fl-gray mt-1 text-[11px]">
					{counts.passed}/{counts.total} variants passed · {counts.failed} failed ·{' '}
					{counts.errored} errored
				</p>
			</section>

			{phase4Active && (
				<section className="px-3.5 pb-3">
					<Card padding="md" tone="neutral">
						<TwoAxisHeader correctness={correctness} robustness={robustness} />
					</Card>
				</section>
			)}

			{phase4Active && grid.rows.length > 0 && (
				<section className="px-3.5 pb-3">
					<Card padding="sm" tone="neutral" title="By behavior">
						<ReportGrid
							rows={grid.rows}
							modesPresent={grid.modesPresent}
							verdicts={data?.batch.behaviorVerdicts ?? []}
						/>
					</Card>
				</section>
			)}

			{phase4Active && (data?.batch.behaviorVerdicts?.length ?? 0) > 0 && (
				<section className="px-3.5 pb-3 space-y-2">
					{data!.batch.behaviorVerdicts!
						.filter((v) => v.status !== 'verified')
						.slice(0, 4)
						.map((v) => (
							<BehaviorFailureCard key={v.behaviorId} verdict={v} />
						))}
				</section>
			)}

			{data?.batch.aiClusterSummary && (
				<section className="px-3.5 pb-3">
					<Card padding="md" tone="neutral" title="AI debugging analysis">
						<p className="text-fl-black text-[11px] leading-relaxed whitespace-pre-line">
							{data.batch.aiClusterSummary}
						</p>
					</Card>
				</section>
			)}

			{!phase4Active && (
				<section className="px-3.5 pb-4 space-y-2">
					{(data?.variants ?? []).map((row) => (
						<Card key={row.variant.id} padding="sm" tone="neutral">
							<div className="flex items-start justify-between gap-2">
								<div className="min-w-0">
									<div className="text-fl-black text-[12px] font-semibold leading-tight">
										{row.variant.name}
									</div>
									<div className="text-fl-gray mt-0.5 text-[10px]">
										{row.variant.family} · expected={row.variant.expectedOutcome.kind}
									</div>
									{row.run?.summary && (
										<div className="text-fl-gray mt-1 text-[10px] line-clamp-2">
											{row.run.summary}
										</div>
									)}
								</div>
								<Pill
									size="xs"
									variant={PILL_BY_STATUS[row.run?.status ?? 'queued'] ?? 'default'}
								>
									{row.run?.status ?? 'queued'}
								</Pill>
							</div>

							{row.stepResults.length > 0 && (
								<StepThumbStrip
									steps={row.stepResults}
									variantName={row.variant.name}
									onOpen={(src, caption) => setLightbox({ src, caption })}
								/>
							)}
						</Card>
					))}
				</section>
			)}

			{phase4Active && (data?.variants ?? []).some((v) => v.stepResults.length > 0) && (
				<section className="px-3.5 pb-4">
					<details className="border-fl-line border bg-fl-soft text-[11px]">
						<summary className="cursor-pointer px-2 py-1.5 text-fl-gray font-mono uppercase tracking-wider text-[10px]">
							Per-variant evidence ({(data?.variants ?? []).length})
						</summary>
						<div className="border-fl-line space-y-2 border-t p-2">
							{(data?.variants ?? []).map((row) => (
								<div key={row.variant.id}>
									<div className="text-fl-black flex items-center gap-2 text-[11px] font-semibold">
										<span className="text-fl-gray font-mono text-[9px] uppercase tracking-wider">
											{row.variant.mode ?? row.variant.family}
										</span>
										<span className="truncate">{row.variant.name}</span>
										<Pill size="xs" variant={PILL_BY_STATUS[row.run?.status ?? 'queued'] ?? 'default'}>
											{row.run?.status ?? 'queued'}
										</Pill>
									</div>
									{row.stepResults.length > 0 && (
										<StepThumbStrip
											steps={row.stepResults}
											variantName={row.variant.name}
											onOpen={(src, caption) => setLightbox({ src, caption })}
										/>
									)}
								</div>
							))}
						</div>
					</details>
				</section>
			)}

			<div className="flex-1" />

			<PanelFooter>
				<div className="space-y-2">
					<Button
						block
						size="md"
						variant="primary"
						onClick={() => window.open(reportUrl, '_blank', 'noopener,noreferrer')}
					>
						Open full report
						<ArrowUpRight size={12} className="ml-1 inline-block" aria-hidden="true" />
					</Button>
					<Button
						block
						size="sm"
						variant="ghost"
						onClick={() => setMode({ kind: 'idle', userEmail: mode.userEmail })}
					>
						Done
					</Button>
				</div>
			</PanelFooter>

			<Lightbox state={lightbox} onClose={() => setLightbox(null)} />
		</PageShell>
	);
}

// ──────────────────── Phase 4 / Tier 4 — Two-axis + grid ───────────────────

function TwoAxisHeader({
	correctness,
	robustness,
}: {
	correctness: { verified: number; total: number };
	robustness: { verified: number; total: number };
}) {
	return (
		<div className="space-y-2">
			<AxisRow label="Correctness" verified={correctness.verified} total={correctness.total} />
			<AxisRow label="Robustness" verified={robustness.verified} total={robustness.total} />
		</div>
	);
}

function AxisRow({
	label,
	verified,
	total,
}: {
	label: string;
	verified: number;
	total: number;
}) {
	const pct = total > 0 ? Math.round((verified / total) * 100) : 0;
	const tone = total === 0 ? 'default' : pct === 100 ? 'success' : pct >= 60 ? 'warn' : 'danger';
	return (
		<div className="flex items-center gap-2">
			<div className="text-fl-black w-24 shrink-0 text-[11px] font-semibold">{label}</div>
			<div className="bg-fl-soft border-fl-line relative h-2 flex-1 overflow-hidden border">
				<div
					className={
						tone === 'success'
							? 'bg-fl-green'
							: tone === 'warn'
								? 'bg-fl-amber'
								: tone === 'danger'
									? 'bg-fl-red'
									: 'bg-fl-line'
					}
					style={{ height: '100%', width: `${pct}%` }}
				/>
			</div>
			<div className="text-fl-gray font-mono text-[10px] tabular-nums w-14 text-right">
				{verified}/{total}
			</div>
		</div>
	);
}

interface ReportGridRow {
	behaviorId: string;
	label: string;
	cells: Record<Phase4Mode, Array<'passed' | 'failed' | 'inconclusive' | 'queued' | 'running' | 'errored'>>;
}

function buildReportGrid(variants: BatchVariantRow[]): {
	rows: ReportGridRow[];
	modesPresent: Phase4Mode[];
} {
	const byBehavior = new Map<string, ReportGridRow>();
	const modes = new Set<Phase4Mode>();
	for (const v of variants) {
		const m = v.variant.mode;
		if (!m) continue;
		modes.add(m);
		const behaviorId = v.variant.behaviorId ?? `invariant-${v.variant.id.slice(0, 8)}`;
		const label = (() => {
			if (m === 'invariant') return v.variant.name.length > 28 ? v.variant.name.slice(0, 28) + '…' : v.variant.name;
			const t = v.variant.name.split(' — ')[0] ?? v.variant.name;
			return t.length > 28 ? t.slice(0, 28) + '…' : t;
		})();
		const row: ReportGridRow = byBehavior.get(behaviorId) ?? {
			behaviorId,
			label,
			cells: { verify: [], edge: [], stress: [], adversarial: [], invariant: [] },
		};
		const status = v.run?.status ?? 'queued';
		const cell: ReportGridRow['cells'][Phase4Mode][number] = (() => {
			if (status === 'passed') return 'passed';
			if (status === 'failed' || status === 'errored') return 'failed';
			if (status === 'inconclusive') return 'inconclusive';
			if (status === 'running') return 'running';
			return 'queued';
		})();
		row.cells[m].push(cell);
		byBehavior.set(behaviorId, row);
	}
	const modesPresent = MODE_ORDER.filter((m) => modes.has(m));
	return { rows: [...byBehavior.values()], modesPresent };
}

function ReportGrid({
	rows,
	modesPresent,
	verdicts,
}: {
	rows: ReportGridRow[];
	modesPresent: Phase4Mode[];
	verdicts: BehaviorVerdictView[];
}) {
	const verdictById = new Map(verdicts.map((v) => [v.behaviorId, v]));
	return (
		<div className="overflow-x-auto">
			<table className="w-full border-separate border-spacing-y-0.5 text-[11px]">
				<thead>
					<tr className="text-fl-gray font-mono text-[9px] uppercase tracking-wider">
						<th className="text-left font-normal pr-2">Behavior</th>
						{modesPresent.map((m) => (
							<th key={m} className="text-center font-normal w-9">
								{MODE_LABEL[m]}
							</th>
						))}
						<th className="text-center font-normal w-7">Cor</th>
						<th className="text-center font-normal w-7">Rob</th>
					</tr>
				</thead>
				<tbody>
					{rows.map((row) => {
						const verdict = verdictById.get(row.behaviorId);
						return (
							<tr key={row.behaviorId}>
								<td className="text-fl-black truncate max-w-[160px] pr-2">{row.label}</td>
								{modesPresent.map((m) => (
									<td key={m} className="text-center">
										<CellRow cells={row.cells[m]} />
									</td>
								))}
								<td className="text-center">{axisMark(verdict, ['verify', 'edge'])}</td>
								<td className="text-center">{axisMark(verdict, ['stress', 'adversarial', 'invariant'])}</td>
							</tr>
						);
					})}
				</tbody>
			</table>
		</div>
	);
}

function CellRow({
	cells,
}: {
	cells: Array<'passed' | 'failed' | 'inconclusive' | 'queued' | 'running' | 'errored'>;
}) {
	if (cells.length === 0) return <span className="text-fl-gray">·</span>;
	return (
		<span className="inline-flex items-center justify-center gap-0.5">
			{cells.map((c, i) => (
				<span
					key={i}
					className={
						c === 'passed'
							? 'text-fl-green'
							: c === 'failed' || c === 'errored' || c === 'inconclusive'
								? 'text-fl-red'
								: c === 'running'
									? 'text-fl-amber'
									: 'text-fl-gray'
					}
				>
					{c === 'passed' ? '✓' : c === 'failed' || c === 'errored' || c === 'inconclusive' ? '✗' : c === 'running' ? '•' : '○'}
				</span>
			))}
		</span>
	);
}

function axisMark(verdict: BehaviorVerdictView | undefined, modes: Phase4Mode[]) {
	if (!verdict) return <span className="text-fl-gray">·</span>;
	const relevant = verdict.modes.filter((m) => modes.includes(m.mode));
	if (relevant.length === 0) return <span className="text-fl-gray">—</span>;
	const allPass = relevant.every((m) => m.variantsFailed === 0 && m.variantsTotal > 0);
	const anyFail = relevant.some((m) => m.variantsFailed > 0);
	if (allPass) return <span className="text-fl-green">✓</span>;
	if (anyFail) return <span className="text-fl-red">✗</span>;
	return <span className="text-fl-gray">·</span>;
}

function BehaviorFailureCard({ verdict }: { verdict: BehaviorVerdictView }) {
	const tone =
		verdict.status === 'failed'
			? 'danger'
			: verdict.status === 'partial'
				? 'warn'
				: 'default';
	return (
		<Card padding="sm" tone="neutral">
			<div className="flex items-start gap-2">
				<Pill size="xs" variant={tone}>
					{verdict.status}
				</Pill>
				<div className="min-w-0 flex-1">
					<div className="text-fl-black text-[11.5px] font-semibold leading-tight">
						{verdict.behaviorTitle}
					</div>
					{verdict.failureSummary && (
						<div className="text-fl-gray mt-1 text-[10px] leading-snug line-clamp-3">
							{verdict.failureSummary}
						</div>
					)}
					<div className="text-fl-gray mt-1 font-mono text-[9px]">
						{verdict.failingVariantIds.length} failing variant{verdict.failingVariantIds.length === 1 ? '' : 's'}
					</div>
				</div>
			</div>
		</Card>
	);
}

interface StripProps {
	steps: BatchStepResult[];
	variantName: string;
	onOpen: (src: string, caption: string) => void;
}

function StepThumbStrip({ steps, variantName, onOpen }: StripProps) {
	const sorted = [...steps].sort((a, b) => a.stepIndex - b.stepIndex);
	return (
		<div className="mt-2 -mx-0.5 flex gap-1 overflow-x-auto pb-1">
			{sorted.map((sr) => (
				<StepThumb
					key={sr.stepIndex}
					step={sr}
					onOpen={(src) =>
						onOpen(src, `${variantName} · step ${sr.stepIndex + 1}`)
					}
				/>
			))}
		</div>
	);
}

function StepThumb({
	step,
	onOpen,
}: {
	step: BatchStepResult;
	onOpen: (src: string) => void;
}) {
	const borderClass =
		step.status === 'passed'
			? 'border-fl-green'
			: step.status === 'failed' || step.status === 'inconclusive'
				? 'border-fl-red'
				: step.status === 'flaky'
					? 'border-fl-amber'
					: 'border-fl-line';
	const src = step.replayScreenshotUrl;
	const label = `Step ${step.stepIndex + 1} · ${step.status}`;
	const common = 'relative block h-12 w-16 shrink-0 overflow-hidden border-2 bg-fl-soft';

	if (!src) {
		return (
			<span
				className={`${common} ${borderClass} cursor-default`}
				aria-label={`${label} (no screenshot)`}
				title={`${label} — no screenshot`}
			>
				<span className="text-fl-gray absolute inset-0 flex items-center justify-center font-mono text-[10px] tabular-nums">
					{step.stepIndex + 1}
				</span>
			</span>
		);
	}

	return (
		<button
			type="button"
			onClick={() => onOpen(src)}
			aria-label={label}
			title={label}
			className={`${common} ${borderClass} transition-transform duration-150 ease-out hover:scale-[1.04] hover:z-10`}
		>
			<img
				src={src}
				alt=""
				className="absolute inset-0 h-full w-full object-cover"
				loading="lazy"
			/>
			<span className="absolute bottom-0 left-0 right-0 bg-fl-black/70 text-fl-white px-1 py-0.5 font-mono text-[8px] uppercase tracking-wider">
				{step.stepIndex + 1}
			</span>
		</button>
	);
}

function Lightbox({
	state,
	onClose,
}: {
	state: LightboxState | null;
	onClose: () => void;
}) {
	return (
		<AnimatePresence>
			{state && (
				<motion.div
					key="step-lightbox"
					initial={{ opacity: 0 }}
					animate={{ opacity: 1 }}
					exit={{ opacity: 0 }}
					transition={{ duration: 0.15 }}
					role="dialog"
					aria-modal="true"
					className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-fl-black/85 p-3"
					onClick={onClose}
				>
					<motion.div
						initial={{ scale: 0.96 }}
						animate={{ scale: 1 }}
						exit={{ scale: 0.96 }}
						transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
						onClick={(e) => e.stopPropagation()}
						className="bg-fl-white border-fl-line relative max-h-full max-w-full overflow-hidden border shadow-[0_2px_6px_rgba(15,15,15,0.18),0_12px_32px_rgba(15,15,15,0.32)]"
					>
						<header className="border-fl-light bg-fl-white flex items-center justify-between gap-2 border-b px-2 py-1.5">
							<span className="text-fl-black font-mono text-[10px] truncate">
								{state.caption}
							</span>
							<IconButton
								label="Close"
								icon={<X size={14} aria-hidden="true" />}
								size="sm"
								onClick={onClose}
							/>
						</header>
						<img
							src={state.src}
							alt={state.caption}
							className="block max-h-[70vh] max-w-[90vw] object-contain"
						/>
					</motion.div>
				</motion.div>
			)}
		</AnimatePresence>
	);
}
