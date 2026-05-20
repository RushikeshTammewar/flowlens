import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import {
	ArrowLeft,
	ArrowUpRight,
	ChevronDown,
	ChevronRight,
	RefreshCcw,
	Sparkles,
} from 'lucide-react';
import { useAppState, type SidePanelStepResult } from '../../../lib/state';
import { api } from '../../../lib/api-client';
import { APP_CONFIG } from '../../../app.config';
import {
	Button,
	Card,
	IconButton,
	KeyValue,
	KeyValueList,
	PageShell,
	PanelFooter,
	PanelHeader,
	Pill,
	StepDot,
	type StepStatus,
	Wordmark,
} from '../../../components/ui';

export function RunReport() {
	const mode = useAppState((s) => s.mode);
	const setMode = useAppState((s) => s.setMode);
	const [summary, setSummary] = useState('');
	const [healthScore, setHealthScore] = useState<number | null>(null);
	const [expanded, setExpanded] = useState<number | null>(null);

	useEffect(() => {
		if (mode.kind !== 'run_report') return;
		void api
			.getRun(mode.runId)
			.then((res) => {
				setSummary(res.run.summary);
				setHealthScore(res.run.healthScore);
			})
			.catch(() => {
				// fall back to whatever we got from SSE
			});
	}, [mode]);

	if (mode.kind !== 'run_report') return null;

	const finalScore = healthScore ?? mode.healthScore ?? null;
	const passed = mode.stepResults.filter((r) => r.status === 'passed').length;
	const failed = mode.stepResults.filter((r) => r.status === 'failed').length;
	const total = mode.stepResults.length;

	const tone: 'success' | 'danger' | 'warn' =
		mode.status === 'passed' ? 'success' : mode.status === 'failed' ? 'danger' : 'warn';
	const banner =
		tone === 'success'
			? { title: 'all steps passed', class: 'border-fl-green/40 bg-fl-green-bg' }
			: tone === 'danger'
				? { title: `failed at step ${failed > 0 ? mode.stepResults.findIndex((r) => r.status === 'failed') + 1 : '?'}`, class: 'border-fl-red/40 bg-fl-red-bg' }
				: { title: mode.status, class: 'border-fl-amber/40 bg-fl-amber-bg' };

	return (
		<PageShell
			motionKey="run_report"
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
					<Pill size="xs" variant={tone} dot>
						{mode.status}
					</Pill>
				</PanelHeader>
			}
		>
			<section className="px-3.5 pt-3">
				<motion.div
					initial={{ opacity: 0, y: 4 }}
					animate={{ opacity: 1, y: 0 }}
					transition={{ duration: 0.22 }}
					className={`border ${banner.class} px-3 py-2.5`}
				>
					<div className="text-fl-gray text-[10px] uppercase tracking-wider">run summary</div>
					<div className="text-fl-black mt-0.5 font-mono text-[14px] font-semibold tracking-tight">
						{banner.title}
					</div>
					<div className="text-fl-gray mt-1 text-[10px]">
						{passed} of {total} passed · {failed} failed
					</div>
				</motion.div>

				<HealthScore score={finalScore} />
			</section>

			{(summary || mode.status === 'failed') && (
				<section className="px-3.5 pt-3">
					<Card
						padding="md"
						tone="info"
						title={
							<span className="flex items-center gap-1.5">
								<Sparkles size={12} className="text-fl-blue" aria-hidden="true" /> AI diagnosis
							</span>
						}
					>
						<p className="text-fl-black text-[11px] leading-relaxed">
							{summary ||
								'No diagnosis yet — open the full report on flowlens.in for the deep analysis.'}
						</p>
					</Card>
				</section>
			)}

			<section className="px-3.5 pt-3">
				<Card padding="md">
					<KeyValueList>
						<KeyValue label="run id" value={mode.runId.slice(0, 8)} />
						<KeyValue label="passed" value={`${passed} / ${total}`} />
						<KeyValue label="failed" value={String(failed)} />
						{finalScore !== null && (
							<KeyValue label="health" value={`${finalScore} / 100`} />
						)}
					</KeyValueList>
				</Card>
			</section>

			<section className="border-fl-light mt-3 flex-1 border-t px-3.5 py-3">
				<header className="text-fl-gray mb-1.5 flex items-baseline justify-between text-[10px] uppercase tracking-wider">
					<span>step-by-step</span>
					<span>{total} steps</span>
				</header>
				<ol className="space-y-1">
					{mode.stepResults.map((r) => {
						const isOpen = expanded === r.stepIndex;
						const status = statusToStepStatus(r.status);
						return (
							<li key={r.stepIndex} className="border-fl-light border">
								<button
									onClick={() => setExpanded(isOpen ? null : r.stepIndex)}
									className="hover:bg-fl-soft flex w-full items-center gap-2 px-2 py-1.5 text-left transition-colors"
								>
									<StepDot status={status} index={r.stepIndex} />
									<span className="text-fl-black flex-1 truncate text-[11px]">
										{r.intent ?? `step ${r.stepIndex + 1}`}
									</span>
									{isOpen ? (
										<ChevronDown size={11} aria-hidden="true" />
									) : (
										<ChevronRight size={11} aria-hidden="true" />
									)}
								</button>
								{isOpen && (
									<motion.div
										initial={{ opacity: 0, height: 0 }}
										animate={{ opacity: 1, height: 'auto' }}
										transition={{ duration: 0.18 }}
										className="border-fl-light border-t px-2 py-2 text-[10px]"
									>
										<dl className="space-y-1">
											{r.errorMessage && (
												<div>
													<dt className="text-fl-gray uppercase tracking-wider">error</dt>
													<dd className="text-fl-red break-words">{r.errorMessage}</dd>
												</div>
											)}
											{r.durationMs !== undefined && (
												<div>
													<dt className="text-fl-gray uppercase tracking-wider">duration</dt>
													<dd className="text-fl-black font-mono">
														{(r.durationMs / 1000).toFixed(2)}s
													</dd>
												</div>
											)}
											<div>
												<dt className="text-fl-gray uppercase tracking-wider">status</dt>
												<dd className="text-fl-black font-mono">{r.status}</dd>
											</div>
										</dl>
									</motion.div>
								)}
							</li>
						);
					})}
				</ol>
			</section>

			<PanelFooter>
				<div className="flex gap-2">
					<a
						href={`${APP_CONFIG.flowlensWebUrl}/app/runs/${mode.runId}`}
						target="_blank"
						rel="noreferrer"
						className="border-fl-line text-fl-black hover:bg-fl-soft inline-flex h-9 flex-1 items-center justify-center gap-1.5 border px-3 font-mono text-[11px] uppercase tracking-wider transition-colors"
					>
						open full report <ArrowUpRight size={11} aria-hidden="true" />
					</a>
					<Button
						className="flex-1"
						variant="primary"
						leftIcon={<RefreshCcw size={11} aria-hidden="true" />}
					>
						re-run
					</Button>
				</div>
			</PanelFooter>
		</PageShell>
	);
}

function HealthScore({ score }: { score: number | null }) {
	if (score === null) return null;
	const tone =
		score >= 85 ? 'text-fl-green' : score >= 60 ? 'text-fl-amber' : 'text-fl-red';
	return (
		<motion.div
			initial={{ opacity: 0 }}
			animate={{ opacity: 1 }}
			transition={{ delay: 0.1 }}
			className="mt-3 flex items-baseline gap-2"
		>
			<motion.span
				key={score}
				initial={{ scale: 0.8, opacity: 0 }}
				animate={{ scale: 1, opacity: 1 }}
				transition={{ duration: 0.32, ease: [0.34, 1.36, 0.64, 1] }}
				className={`font-serif tabular-nums ${tone} text-[42px] leading-none tracking-tight`}
			>
				{score}
			</motion.span>
			<span className="text-fl-gray font-mono text-[11px]">/ 100 · health score</span>
		</motion.div>
	);
}

function statusToStepStatus(s: SidePanelStepResult['status']): StepStatus {
	switch (s) {
		case 'passed':
			return 'passed';
		case 'failed':
			return 'failed';
		case 'in_progress':
			return 'running';
		case 'flaky':
			return 'flaky';
		case 'blocked_auth':
			return 'blocked';
		case 'inconclusive':
			return 'inconclusive';
		case 'skipped':
			return 'skipped';
		default:
			return 'pending';
	}
}
