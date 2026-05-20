import { useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, Cpu, Sparkles } from 'lucide-react';
import { useAppState } from '../../../lib/state';
import { api } from '../../../lib/api-client';
import {
	Button,
	Card,
	PageShell,
	PanelFooter,
	PanelHeader,
	Pill,
	ProgressBar,
	ProgressStages,
	type ProgressStage,
	Wordmark,
	useToast,
} from '../../../components/ui';

interface FlowPreview {
	name: string;
	description: string | null;
	steps: Array<{ index: number; action: string; intent: string; isCritical: boolean }>;
}

const STAGE_ORDER: ReadonlyArray<{ id: string; label: string }> = [
	{ id: 'stitching', label: 'Stitching the recording' },
	{ id: 'narrating', label: 'Narrating each step' },
	{ id: 'synthesizing', label: 'Synthesizing the flow' },
	{ id: 'siblings', label: 'Suggesting related flows' },
	{ id: 'matrix', label: 'Generating test matrix' },
	{ id: 'launching', label: 'Launching cloud sessions' },
];

const STAGE_ALIASES: Record<string, string> = {
	queued: 'stitching',
	stitch: 'stitching',
	stitching: 'stitching',
	narrate: 'narrating',
	narrating: 'narrating',
	synthesize: 'synthesizing',
	synthesizing: 'synthesizing',
	siblings: 'siblings',
	suggesting: 'siblings',
	done: 'siblings',
	matrix: 'matrix',
	'matrix-gen': 'matrix',
	launching: 'launching',
	'batch-start': 'launching',
};

// Default size of the auto-generated matrix kicked off after compile-success.
// 5 keeps OpenAI cost ~$0.03 and the BU Cloud fan-out within parallelism=5,
// which is what the demo budget assumes.
const AUTO_MATRIX_COUNT = 5;

type AutoPhase = 'idle' | 'matrix-gen' | 'batch-start' | 'failed';

interface DecodedStep {
	stepIndex: number;
	actionType: string;
	intent: string;
	isCritical: boolean;
}

export function Compiling() {
	const mode = useAppState((s) => s.mode);
	const setMode = useAppState((s) => s.setMode);
	const toast = useToast();
	const [pct, setPct] = useState(0);
	const [rawStage, setRawStage] = useState<string>('queued');
	const [detail, setDetail] = useState<string>('');
	const [autoPhase, setAutoPhase] = useState<AutoPhase>('idle');
	// Phase 4 / UX §1 — live "what the AI just decoded" feed surfaced
	// from the narrate-stage rolling buffer. Empty until first step
	// finishes narrating; cleared once we move past narrate.
	const [decodedSteps, setDecodedSteps] = useState<DecodedStep[]>([]);
	// What the AI thinks the user is testing — fetched once compile is done
	// so the user can verify (and watch) during the matrix-gen wait
	// (~60-120s on gpt-5.4 reasoning-high). Without this the user just
	// stares at a frozen progress bar wondering what's happening.
	const [flowPreview, setFlowPreview] = useState<FlowPreview | null>(null);
	const [previewOpen, setPreviewOpen] = useState(true);
	// Guard so the post-compile auto path only fires once per mount, even
	// though the poller may observe `ready+done` on multiple ticks before
	// it gets cleared by the cancel ref below.
	const autoTriggeredRef = useRef(false);

	useEffect(() => {
		if (mode.kind !== 'compiling') return;
		let cancelled = false;

		// Auto-run flow: matrix-gen → batch-start → setMode matrix_running.
		// Lives inside the effect so it inherits the `cancelled` flag and
		// can be torn down cleanly if the panel unmounts mid-flight (e.g.
		// the user hits cancel in the footer).
		//
		// Phase 4 / Tier 4 — when the compiled flow has a featureContract,
		// we land on `contract_review` instead of auto-running matrix-gen.
		// The user approves the contract, then ContractReview kicks off
		// matrix-gen + batch-start. This is the UX §6.5 surface.
		const startAutoMatrix = async (flowId: string, userEmail: string) => {
			autoTriggeredRef.current = true;
			setAutoPhase('matrix-gen');
			setRawStage('matrix');
			setDetail('asking the model for edge-case variants…');
			setPct(95);
			// Best-effort: fetch the compiled flow so we can BOTH preview
			// it during the wait AND check whether a Phase 4 contract was
			// synthesized — if it was, we pivot to ContractReview instead
			// of auto-running. Don't block matrix-gen on this fetch
			// errors; we still progress to the matrix path.
			let hasContract = false;
			try {
				const res = await api.getFlow(flowId);
				const f = (res as {
					flow?: FlowPreview & { featureContract?: unknown };
				}).flow;
				if (f && Array.isArray(f.steps)) {
					setFlowPreview({
						name: f.name,
						description: f.description ?? null,
						steps: f.steps.map((s) => ({
							index: s.index,
							action: s.action,
							intent: s.intent,
							isCritical: s.isCritical,
						})),
					});
				}
				if (f?.featureContract) {
					hasContract = true;
				}
			} catch {
				/* preview / pivot detection is optional UX polish */
			}
			if (cancelled) return;
			if (hasContract) {
				console.info('[phase4:ui] contract present — pivoting to ContractReview');
				setMode({ kind: 'contract_review', userEmail, flowId });
				return;
			}
			try {
				// Reuse existing variants if the user already generated some
				// for this flow (e.g. retried compile). Saves an LLM call and
				// matches the manual `runMatrix` path in Idle.tsx.
				const list = await api.listTestMatrix(flowId);
				let variantIds = list.variants.map((v) => v.id);
				if (variantIds.length === 0) {
					const gen = await api.generateTestMatrix(flowId, AUTO_MATRIX_COUNT);
					variantIds = gen.variants.map((v) => v.id);
				}
				if (cancelled) return;
				if (variantIds.length === 0) {
					throw new Error('matrix generation returned 0 variants');
				}

				setAutoPhase('batch-start');
				setRawStage('launching');
				setDetail(`spinning up ${Math.min(variantIds.length, AUTO_MATRIX_COUNT)} cloud sessions…`);
				setPct(98);
				const batch = await api.startBatchRun(flowId, {
					variantIds: variantIds.slice(0, AUTO_MATRIX_COUNT),
					parallelism: 5,
				});
				if (cancelled) return;
				setPct(100);
				setMode({
					kind: 'matrix_running',
					userEmail,
					flowId,
					batchId: batch.batchId,
				});
			} catch (err) {
				if (cancelled) return;
				console.warn('[Flowlens] auto matrix-run failed; falling back to Reviewing', err);
				setAutoPhase('failed');
				const msg = err instanceof Error ? err.message : 'unknown error';
				toast.push({
					tone: 'error',
					title: 'auto-run failed',
					body: `${msg} — review the flow and run manually.`,
				});
				setMode({ kind: 'reviewing', userEmail, flowId });
			}
		};

		const tick = async () => {
			// Once we've kicked off auto-matrix, stop polling compile-status —
			// the server view is already at `ready+done` and won't change.
			if (autoTriggeredRef.current) return;
			try {
				const res = await api.getCompileStatus(mode.flowId);
				if (cancelled) return;
				setPct(res.compile.pct);
				setRawStage(res.compile.stage);
				setDetail(res.compile.detail ?? '');
				// Phase 4 — live decoded-steps feed. Only paint while the
				// narrate stage is active; clear when we move on so the
				// synthesize/matrix screens don't show stale narrate detail.
				if (res.compile.stage === 'narrate' && res.compile.recentNarrations) {
					setDecodedSteps(res.compile.recentNarrations);
				} else if (res.compile.stage !== 'narrate' && decodedSteps.length > 0) {
					setDecodedSteps([]);
				}
				if (res.flowStatus === 'ready' && res.compile.stage === 'done') {
					void startAutoMatrix(mode.flowId, mode.userEmail);
					return;
				}
				if (res.compile.stage === 'failed') {
					setMode({
						kind: 'failed',
						userEmail: mode.userEmail,
						reason: res.compile.error ?? 'compile failed',
					});
					return;
				}
			} catch (err) {
				console.warn('[Flowlens] compile-status poll failed', err);
			}
		};
		const handle = setInterval(() => void tick(), 1000);
		void tick();
		return () => {
			cancelled = true;
			clearInterval(handle);
		};
		// `decodedSteps` is intentionally NOT in the dep array — we read
		// `decodedSteps.length` inside `tick` only as a clear-once guard,
		// and re-creating the interval every time the buffer mutates would
		// reset the 1s polling cadence on every server-side update.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [mode, setMode, toast]);

	if (mode.kind !== 'compiling') return null;

	const activeKey = STAGE_ALIASES[rawStage.toLowerCase()] ?? STAGE_ORDER[0]?.id ?? 'stitching';
	const activeIdx = STAGE_ORDER.findIndex((s) => s.id === activeKey);
	const isDone = rawStage === 'done' && autoPhase === 'idle';
	const stages: ProgressStage[] = STAGE_ORDER.map((s, i) => {
		let state: ProgressStage['state'] = 'pending';
		if (i < activeIdx) state = 'done';
		else if (i === activeIdx) state = isDone ? 'done' : 'active';
		const stage: ProgressStage = { id: s.id, label: s.label, state };
		if (state === 'active' && detail) stage.detail = detail;
		return stage;
	});

	const cancel = () => setMode({ kind: 'idle', userEmail: mode.userEmail });

	const headline =
		autoPhase === 'matrix-gen'
			? 'Generating test matrix'
			: autoPhase === 'batch-start'
				? 'Launching cloud sessions'
				: 'Making sense of your recording';

	const subhead =
		autoPhase === 'matrix-gen' || autoPhase === 'batch-start'
			? 'Auto-running edge cases — no click required.'
			: 'AI works in the open — every stage is visible.';

	const pillVariant = autoPhase === 'idle' ? 'warn' : 'success';
	const pillText = autoPhase === 'idle' ? 'compiling' : 'auto-running';

	return (
		<PageShell
			motionKey="compiling"
			header={
				<PanelHeader>
					<div className="flex min-w-0 items-center gap-2">
						<Wordmark />
						<Pill size="xs" variant={pillVariant} dot>
							{pillText}
						</Pill>
					</div>
					<span className="text-fl-gray font-mono text-[10px] tabular-nums">{pct}%</span>
				</PanelHeader>
			}
		>
			<section className="px-4 py-5 text-center">
				<div className="text-fl-cta mx-auto inline-flex h-10 w-10 items-center justify-center">
					<Cpu size={28} aria-hidden="true" />
				</div>
				<h1 className="font-serif text-fl-black mt-2 text-[22px] leading-tight tracking-tight">
					{headline}
				</h1>
				<p className="text-fl-gray mt-1 text-[11px]">{subhead}</p>
			</section>

			<section className="px-3.5">
				<Card padding="md">
					<ProgressBar value={pct} />
					<div className="text-fl-gray mt-2 flex items-baseline justify-between text-[10px]">
						<span className="font-mono uppercase tracking-wider">{rawStage}</span>
						<span className="text-fl-gray">{detail || 'working…'}</span>
					</div>
					<div className="border-fl-light mt-3 border-t pt-3">
						<ProgressStages stages={stages} />
					</div>
				</Card>
			</section>

			{decodedSteps.length > 0 && rawStage === 'narrate' && (
				<section className="px-3.5 pt-3">
					<Card padding="sm" tone="info">
						<div className="text-fl-gray font-mono text-[9px] uppercase tracking-wider">
							What the AI just decoded
						</div>
						<ol className="mt-1.5 space-y-1">
							{decodedSteps.map((s, i) => (
								<li
									key={`${s.stepIndex}-${i}`}
									className="flex items-baseline gap-1.5 text-[11px] leading-snug"
								>
									<span className="text-fl-gray font-mono text-[9px] tabular-nums shrink-0 w-5">
										{String(s.stepIndex + 1).padStart(2, '0')}
									</span>
									<span className="text-fl-black flex-1">
										<span className="text-fl-gray text-[10px] uppercase tracking-wider mr-1">
											{s.actionType}
										</span>
										{s.intent}
										{s.isCritical && (
											<span className="text-fl-cta ml-1 text-[9px] uppercase tracking-wider">
												·critical
											</span>
										)}
									</span>
								</li>
							))}
						</ol>
						<div className="text-fl-gray mt-2 font-mono text-[9px] uppercase tracking-wider">
							{decodedSteps.length} step{decodedSteps.length === 1 ? '' : 's'} so far · live from
							gpt-5.4-mini vision
						</div>
					</Card>
				</section>
			)}

			{(autoPhase === 'matrix-gen' || autoPhase === 'batch-start') && flowPreview && (
				<section className="px-3.5 pt-3">
					<Card padding="sm" tone="info">
						<button
							type="button"
							onClick={() => setPreviewOpen((v) => !v)}
							className="flex w-full items-start justify-between gap-2 text-left"
							aria-expanded={previewOpen}
						>
							<div className="min-w-0">
								<div className="text-fl-gray font-mono text-[9px] uppercase tracking-wider">
									What we understood from your recording
								</div>
								<div className="text-fl-black mt-0.5 text-[12px] font-semibold leading-tight">
									{flowPreview.name}
								</div>
							</div>
							{previewOpen ? (
								<ChevronDown size={14} className="text-fl-gray shrink-0" aria-hidden="true" />
							) : (
								<ChevronRight size={14} className="text-fl-gray shrink-0" aria-hidden="true" />
							)}
						</button>
						{previewOpen && (
							<div className="mt-2 space-y-2">
								{flowPreview.description && (
									<p className="text-fl-black text-[11px] leading-relaxed">
										<Sparkles
											size={10}
											className="text-fl-cta mr-1 -mt-0.5 inline-block"
											aria-hidden="true"
										/>
										{flowPreview.description}
									</p>
								)}
								<ol className="space-y-1">
									{flowPreview.steps.map((s) => (
										<li
											key={s.index}
											className="flex items-baseline gap-1.5 text-[11px] leading-snug"
										>
											<span className="text-fl-gray font-mono text-[9px] tabular-nums shrink-0 w-5">
												{String(s.index + 1).padStart(2, '0')}
											</span>
											<span className="text-fl-black flex-1">
												<span className="text-fl-gray text-[10px] uppercase tracking-wider mr-1">
													{s.action}
												</span>
												{s.intent}
												{s.isCritical && (
													<span className="text-fl-cta ml-1 text-[9px] uppercase tracking-wider">
														·critical
													</span>
												)}
											</span>
										</li>
									))}
								</ol>
							</div>
						)}
					</Card>
				</section>
			)}

			<section className="px-3.5 py-3">
				<p className="text-fl-gray text-[10px]">
					{autoPhase === 'idle'
						? 'This usually takes 5–15 seconds. We narrate each step using your screenshots and the DOM context.'
						: 'Spinning up isolated cloud browsers. You can walk away — results will appear in the next screen.'}
				</p>
			</section>

			<div className="flex-1" />
			<PanelFooter>
				<Button block variant="ghost" size="md" onClick={cancel}>
					cancel
				</Button>
			</PanelFooter>
		</PageShell>
	);
}
