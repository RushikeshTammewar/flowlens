import { useEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { Pause, Sparkles, Square } from 'lucide-react';
import { useAppState, type SidePanelStepResult } from '../../../lib/state';
import { api } from '../../../lib/api-client';
import {
	Button,
	IconButton,
	PageShell,
	PanelFooter,
	PanelHeader,
	Pill,
	StepDot,
	type StepStatus,
	Wordmark,
	useToast,
} from '../../../components/ui';

const POLL_MS = 1500;

const TERMINAL_STATUSES = new Set([
	'passed',
	'failed',
	'errored',
	'canceled',
	'paused_auth',
	'paused_user',
]);

const THOUGHT_LOOP: ReadonlyArray<string> = [
	'finding the target element…',
	'reasoning about the page…',
	'verifying the action landed…',
	'comparing to recorded intent…',
];

export function Running() {
	const mode = useAppState((s) => s.mode);
	const setMode = useAppState((s) => s.setMode);
	const toast = useToast();
	const [err, setErr] = useState('');
	const [thought, setThought] = useState(0);
	const [elapsedSec, setElapsedSec] = useState(0);
	const startedAt = useState(() => Date.now())[0];
	const stoppedRef = useRef(false);

	useEffect(() => {
		if (mode.kind !== 'running') return;
		const runId = mode.runId;
		stoppedRef.current = false;
		let timer: ReturnType<typeof setTimeout> | null = null;

		// Poll `/api/runs/:id` at ~1Hz. We replaced the SSE stream because
		// the EventSource auth path didn't accept the demo bearer (it lives
		// in `Authorization`, but EventSource can't set headers, and the
		// stream route doesn't honor `?token=`). Polling is robust to that
		// and works against any deployment.
		const tick = async () => {
			if (stoppedRef.current) return;
			try {
				const data = await api.getRun(runId);
				if (stoppedRef.current) return;
				setErr('');

				// Defensive guards — the API contract returns both arrays but
				// older / partial deployments may return undefined; never crash
				// the side panel because the polling endpoint shape regressed.
				const safeFlowSteps = Array.isArray(data?.flowSteps) ? data.flowSteps : [];
				const safeStepResults = Array.isArray(data?.stepResults) ? data.stepResults : [];
				const intentByIndex = new Map(
					safeFlowSteps.map((s) => [s.index, s.intent] as const),
				);
				const finishedByIndex = new Map(
					safeStepResults.map((r) => [r.stepIndex, r] as const),
				);

				// Build the full step list so the user sees pending steps from
				// the very first poll. The currently-executing step is the
				// first one without a finished row; everything before it is
				// finished, everything after is pending.
				const total = safeFlowSteps.length;
				const merged: SidePanelStepResult[] = [];
				let firstUnfinished = total;
				for (let i = 0; i < total; i++) {
					const fin = finishedByIndex.get(i);
					if (fin) {
						merged.push({
							stepIndex: i,
							status: fin.status,
							intent: intentByIndex.get(i),
							durationMs: fin.durationMs ?? undefined,
							errorMessage: fin.errorMessage ?? undefined,
						});
					} else {
						if (i < firstUnfinished) firstUnfinished = i;
						const isRunning = i === firstUnfinished && data.run.status === 'running';
						merged.push({
							stepIndex: i,
							status: isRunning ? 'in_progress' : 'pending',
							intent: intentByIndex.get(i),
						});
					}
				}

				const currentStepIndex = Math.min(firstUnfinished, Math.max(0, total - 1));

				const current = useAppState.getState().mode;
				if (current.kind !== 'running' || current.runId !== runId) return;
				useAppState.setState({
					mode: {
						...current,
						liveUrl: data.run.liveUrl ?? current.liveUrl,
						currentStepIndex,
						stepResults: merged,
					},
				});

				if (TERMINAL_STATUSES.has(data.run.status)) {
					stoppedRef.current = true;
					if (data.run.status === 'paused_auth') {
						setMode({
							kind: 'auth_refresh',
							userEmail: current.userEmail,
							runId,
							siteOrigin: '',
							hint: data.run.summary ?? 'auth wall detected',
						});
					} else {
						setMode({
							kind: 'run_report',
							userEmail: current.userEmail,
							flowId: current.flowId,
							runId,
							status: data.run.status,
							healthScore: data.run.healthScore,
							summary: data.run.summary ?? '',
							stepResults: merged,
						});
					}
					return;
				}
			} catch (e) {
				setErr((e as Error).message);
			}
			if (!stoppedRef.current) {
				timer = setTimeout(tick, POLL_MS);
			}
		};
		void tick();

		return () => {
			stoppedRef.current = true;
			if (timer) clearTimeout(timer);
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [mode.kind === 'running' ? mode.runId : null]);

	useEffect(() => {
		const id = setInterval(() => {
			setThought((t) => (t + 1) % THOUGHT_LOOP.length);
			setElapsedSec(Math.floor((Date.now() - startedAt) / 1000));
		}, 1500);
		return () => clearInterval(id);
	}, [startedAt]);

	if (mode.kind !== 'running') return null;

	const cancel = async () => {
		try {
			await api.cancelRun(mode.runId);
			toast.push({ tone: 'info', title: 'Run cancelled' });
		} catch (e) {
			setErr((e as Error).message);
		}
	};

	const total = mode.stepResults.length;
	const passed = mode.stepResults.filter((r) => r.status === 'passed').length;
	const failed = mode.stepResults.filter((r) => r.status === 'failed').length;

	const minutes = Math.floor(elapsedSec / 60);
	const seconds = elapsedSec % 60;

	const currentLabel =
		total > 0
			? `Step ${Math.min(mode.currentStepIndex + 1, total)} of ${total}`
			: 'Starting in cloud browser…';

	return (
		<PageShell
			motionKey="running"
			header={
				<PanelHeader>
					<div className="flex min-w-0 items-center gap-2">
						<Wordmark />
						<Pill size="xs" variant="warn" dot>
							running
						</Pill>
					</div>
					<span className="text-fl-gray font-mono text-[10px] tabular-nums">
						{String(minutes).padStart(2, '0')}:{String(seconds).padStart(2, '0')}
					</span>
				</PanelHeader>
			}
		>
			<section className="px-3.5 pb-2 pt-3">
				<h1 className="font-mono text-[12px] font-semibold uppercase tracking-wider">{currentLabel}</h1>
				<div className="text-fl-gray flex items-center gap-2 text-[10px]">
					<span>{passed} passed</span>
					<span aria-hidden="true">·</span>
					<span className="text-fl-red">{failed} failed</span>
				</div>
			</section>

			{mode.liveUrl ? (
				<motion.section
					initial={{ opacity: 0 }}
					animate={{ opacity: 1 }}
					transition={{ duration: 0.3 }}
					className="px-3.5 pb-2"
				>
					<div className="border-fl-line bg-fl-black/95 overflow-hidden border shadow-[0_2px_6px_rgba(15,15,15,0.08),0_12px_32px_rgba(15,15,15,0.06)]">
						<div className="bg-fl-soft border-fl-line text-fl-gray flex items-center justify-between border-b px-2 py-1 text-[9px] uppercase tracking-wider">
							<span className="flex items-center gap-1">
								<span className="bg-fl-red inline-block h-1.5 w-1.5 rounded-full fl-stage-pulse" />
								live · cloud browser
							</span>
							<span>watching</span>
						</div>
						<iframe
							src={mode.liveUrl}
							title="Live replay"
							className="block h-44 w-full border-0 bg-fl-white"
							sandbox="allow-scripts allow-same-origin"
						/>
					</div>
				</motion.section>
			) : (
				<section className="px-3.5 pb-2">
					<div className="border-fl-line bg-fl-soft flex h-32 items-center justify-center border">
						<span className="text-fl-gray text-[11px]">connecting to cloud browser…</span>
					</div>
				</section>
			)}

			<section className="border-fl-light flex-1 overflow-auto border-t px-3.5 py-3">
				<div className="text-fl-gray flex items-center justify-between text-[10px] uppercase tracking-wider">
					<span>steps</span>
					<motion.span
						key={thought}
						initial={{ opacity: 0, y: 4 }}
						animate={{ opacity: 1, y: 0 }}
						transition={{ duration: 0.18 }}
						className="text-fl-amber inline-flex items-center gap-1 normal-case tracking-tight"
					>
						<Sparkles size={10} aria-hidden="true" />
						{THOUGHT_LOOP[thought]}
					</motion.span>
				</div>
				<ol className="mt-2 space-y-1.5">
					{mode.stepResults.length === 0 && (
						<li className="text-fl-gray text-[11px]">starting…</li>
					)}
					{mode.stepResults.map((r) => {
						const isCurrent = r.stepIndex === mode.currentStepIndex && r.status === 'in_progress';
						return (
							<li
								key={r.stepIndex}
								className={`flex items-start gap-2 px-1.5 py-1 text-[11px] ${
									isCurrent ? 'bg-fl-amber-bg shadow-[inset_0_0_0_1px_rgba(180,83,9,0.35)]' : ''
								}`}
							>
								<StepDot status={statusToStepStatus(r.status)} index={r.stepIndex} />
								<div className="min-w-0 flex-1">
									<div className="text-fl-black truncate">
										{r.intent ?? `step ${r.stepIndex + 1}`}
									</div>
									{r.errorMessage && (
										<div className="text-fl-red mt-0.5 text-[10px]">{r.errorMessage}</div>
									)}
								</div>
								{r.durationMs && (
									<span className="text-fl-gray font-mono text-[10px]">
										{Math.round(r.durationMs / 100) / 10}s
									</span>
								)}
							</li>
						);
					})}
				</ol>
				{err && (
					<p className="text-fl-red mt-2 text-[10px]">{err}</p>
				)}
			</section>

			<PanelFooter>
				<div className="flex items-center gap-2">
					<IconButton
						label="Pause"
						icon={<Pause size={13} aria-hidden="true" />}
						variant="outline"
						size="md"
					/>
					<Button
						className="flex-1"
						variant="dark"
						onClick={cancel}
						leftIcon={<Square size={11} aria-hidden="true" />}
					>
						stop
					</Button>
				</div>
			</PanelFooter>
		</PageShell>
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
		case 'pending':
		default:
			return 'pending';
	}
}
