import { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { X } from 'lucide-react';
import { useAppState } from '../../../lib/state';
import { api, type BatchView, type BatchStepResult } from '../../../lib/api-client';
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
					Edge-case report
				</h1>
				<p className="text-fl-gray mt-1 text-[11px]">
					{counts.passed}/{counts.total} variants passed · {counts.failed} failed ·{' '}
					{counts.errored} errored
				</p>
			</section>

			{data?.batch.aiClusterSummary && (
				<section className="px-3.5 pb-3">
					<Card padding="md" tone="neutral" title="AI cluster summary">
						<p className="text-fl-black text-[11px] leading-relaxed whitespace-pre-line">
							{data.batch.aiClusterSummary}
						</p>
					</Card>
				</section>
			)}

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

			<div className="flex-1" />

			<PanelFooter>
				<Button
					block
					size="md"
					variant="primary"
					onClick={() => setMode({ kind: 'idle', userEmail: mode.userEmail })}
				>
					Done
				</Button>
			</PanelFooter>

			<Lightbox state={lightbox} onClose={() => setLightbox(null)} />
		</PageShell>
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
