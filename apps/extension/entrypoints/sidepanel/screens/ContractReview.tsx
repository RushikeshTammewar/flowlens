/**
 * Phase 4 / Tier 4 — Contract Review (UX §6.5).
 *
 * Renders the structured FeatureContract synthesized at compile time
 * (inputs, behaviors with given/when/then, invariants) and the test
 * plan that matrix-gen will spawn. Single primary CTA — "Approve and
 * run tests" — kicks off matrix-gen + batch-start and lands the panel
 * on `matrix_running`.
 *
 * Falls back to the legacy `Reviewing` carousel via the back button if
 * the contract didn't synthesize (e.g. pre-Phase-4 flow re-compiled
 * with the flag off). Also surfaces the cookie/session metadata so the
 * user can see what state the cloud browser will start with.
 *
 * Logged under scope: [phase4:ui]
 */
import { useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, Cookie, Cpu, Lock, RefreshCw, ShieldCheck } from 'lucide-react';
import { useAppState } from '../../../lib/state';
import { api, type FeatureContractView, type FlowWithContractView } from '../../../lib/api-client';
import {
	Button,
	Card,
	PageShell,
	PanelFooter,
	PanelHeader,
	Pill,
	ProgressStages,
	type ProgressStage,
	Wordmark,
	useToast,
} from '../../../components/ui';

// Same auto-batch defaults used elsewhere in the panel — keeps cost
// predictable for the demo. The matrix endpoint accepts count ∈
// {5, 10, 20} only (Zod-validated server-side); 10 is the sweet spot
// for the senior-QA flow because the V2 matrix-gen distributes them
// across all 5 modes (verify/edge/stress/adversarial/invariant).
// Parallel BU sessions capped at 5 to stay inside the BU Cloud
// free-tier concurrency limit.
const APPROVE_VARIANT_COUNT: 5 | 10 | 20 = 10;
const APPROVE_PARALLELISM = 5;

type ApprovePhase = 'idle' | 'matrix-gen' | 'batch-start' | 'failed';

// Rotating "what the AI is thinking about right now" hints surfaced
// during the matrix-gen wait. Each takes ~5-10s of the ~60-180s
// matrix-gen call so the user gets a steady stream of detail. The
// last hint sticks until the model returns. Mirrors the same "AI
// works in the open" principle the Compiling screen uses (UX §1).
const MATRIX_GEN_HINTS = [
	'Reading the Feature Contract…',
	'Asking gpt-5.4 (high reasoning) to plan a 5-mode test matrix…',
	'Generating verify variants — happy paths with realistic data',
	'Generating edge variants — boundaries + near-miss values',
	'Generating stress variants — repeated/heavy-load inputs',
	'Generating adversarial variants — hostile payloads expected to be REJECTED',
	'Generating invariant variants — properties that must always hold',
	'Wiring deterministic assertions to each variant…',
	'Almost there — gpt-5.4 reasoning takes 2-5 min for rich features…',
];

const BATCH_START_HINTS = [
	'Allocating BU Cloud browser sessions…',
	'Decrypting cookies + UA / viewport / locale fingerprint…',
	'Spinning up parallel cloud browsers (max 5 concurrent)…',
];

export function ContractReview() {
	const mode = useAppState((s) => s.mode);
	const setMode = useAppState((s) => s.setMode);
	const toast = useToast();

	const [data, setData] = useState<FlowWithContractView | null>(null);
	const [loadErr, setLoadErr] = useState<string>('');
	const [phase, setPhase] = useState<ApprovePhase>('idle');
	const [openBehaviorId, setOpenBehaviorId] = useState<string | null>(null);
	// Index into MATRIX_GEN_HINTS / BATCH_START_HINTS, advanced every
	// ~7s while the in-flight phase is active. Reset whenever the phase
	// changes so each phase starts at hint[0].
	const [hintIdx, setHintIdx] = useState(0);
	const [phaseStartedAt, setPhaseStartedAt] = useState<number | null>(null);

	// Tick the hint cursor + elapsed timer while we're mid-flight. Tear
	// down on phase change OR unmount. Step interval is 7s — slow enough
	// to feel deliberate, fast enough that the user always has new copy
	// to read during the 60-180s matrix-gen wait.
	useEffect(() => {
		if (phase !== 'matrix-gen' && phase !== 'batch-start') {
			setHintIdx(0);
			setPhaseStartedAt(null);
			return;
		}
		setHintIdx(0);
		setPhaseStartedAt(Date.now());
		const hints =
			phase === 'matrix-gen' ? MATRIX_GEN_HINTS : BATCH_START_HINTS;
		const handle = setInterval(() => {
			setHintIdx((i) => Math.min(i + 1, hints.length - 1));
		}, 7000);
		return () => clearInterval(handle);
	}, [phase]);

	useEffect(() => {
		if (mode.kind !== 'contract_review') return;
		let cancelled = false;
		void api
			.getFlowWithContract(mode.flowId)
			.then((res) => {
				if (cancelled) return;
				setData(res.flow);
				if (!res.flow.featureContract) {
					console.warn('[phase4:ui] contract review opened with no contract');
				}
			})
			.catch((err: Error) => {
				if (cancelled) return;
				setLoadErr(err.message);
			});
		return () => {
			cancelled = true;
		};
	}, [mode]);

	if (mode.kind !== 'contract_review') return null;

	const contract: FeatureContractView | null = data?.featureContract ?? null;
	const cookieSnap = data?.cookieSnapshot ?? null;
	const flowName = data?.name ?? 'Loading…';

	const approve = async () => {
		setPhase('matrix-gen');
		try {
			// Reuse existing variants if any (e.g. user re-opens after a
			// previous matrix-gen succeeded). Mirrors the auto-run logic
			// in Compiling.tsx.
			const list = await api.listTestMatrix(mode.flowId);
			let variantIds = list.variants.map((v) => v.id);
			if (variantIds.length === 0) {
				const gen = await api.generateTestMatrix(mode.flowId, APPROVE_VARIANT_COUNT);
				variantIds = gen.variants.map((v) => v.id);
			}
			if (variantIds.length === 0) {
				throw new Error('matrix generation returned 0 variants');
			}
			setPhase('batch-start');
			const batch = await api.startBatchRun(mode.flowId, {
				variantIds: variantIds.slice(0, APPROVE_VARIANT_COUNT),
				parallelism: APPROVE_PARALLELISM,
			});
			setMode({
				kind: 'matrix_running',
				userEmail: mode.userEmail,
				flowId: mode.flowId,
				batchId: batch.batchId,
			});
		} catch (err) {
			setPhase('failed');
			const msg = err instanceof Error ? err.message : 'unknown error';
			console.error('[phase4:ui] approve&run failed', err);
			toast.push({
				tone: 'error',
				title: 'could not start matrix',
				body: msg,
			});
		}
	};

	const reRecord = () => setMode({ kind: 'idle', userEmail: mode.userEmail });

	const planSummary = (() => {
		if (!contract) return null;
		// Mirrors the test-plan distribution Tier 2 matrix-gen actually
		// produces — keep this in sync with USER_PROMPT_TEMPLATE_V2's
		// `targets` defaults in packages/flow-doc/src/generate-matrix.ts.
		// We approximate per-behavior coverage rather than asking
		// matrix-gen up-front (matrix-gen runs on Approve, not now).
		const behaviors = contract.expectedBehaviors.length;
		const invariants = contract.invariants.length;
		const verify = Math.min(behaviors, 3);
		const edge = Math.min(behaviors, 3);
		const stress = Math.min(behaviors, 2);
		const adv = Math.min(behaviors, 2);
		const inv = Math.min(invariants, 2);
		const total = verify + edge + stress + adv + inv;
		return { verify, edge, stress, adv, inv, total };
	})();

	return (
		<PageShell
			motionKey="contract_review"
			header={
				<PanelHeader>
					<div className="flex min-w-0 items-center gap-2">
						<Wordmark />
						<Pill size="xs" variant="success" dot>
							contract ready
						</Pill>
					</div>
				</PanelHeader>
			}
		>
			<section className="px-4 py-4">
				<button
					type="button"
					onClick={reRecord}
					className="text-fl-gray hover:text-fl-black mb-2 flex items-center gap-1 text-[10px] font-mono uppercase tracking-wider"
				>
					← Back
				</button>
				<h1 className="font-serif text-fl-black text-[22px] leading-tight tracking-tight">
					{flowName}
				</h1>
				{contract && (
					<p className="text-fl-gray mt-1 text-[11px] leading-relaxed">
						<span className="font-mono uppercase tracking-wider mr-1">AI understood:</span>
						{data?.description ?? '(no description)'}
					</p>
				)}
				{loadErr && (
					<p className="text-fl-red mt-2 text-[11px]">Failed to load: {loadErr}</p>
				)}
			</section>

			{!contract && data && (
				<section className="px-3.5 pb-3">
					<Card padding="sm" tone="info">
						<p className="text-fl-black text-[11px] leading-relaxed">
							No structured Feature Contract on this flow yet (compiled before
							Phase 4). Approve to run a legacy variant batch instead.
						</p>
					</Card>
				</section>
			)}

			{contract && (
				<>
					<section className="px-3.5 pb-3">
						<Card padding="sm" tone="neutral" title="Inputs">
							<ul className="space-y-1">
								{contract.inputs.length === 0 && (
									<li className="text-fl-gray text-[11px]">(none detected)</li>
								)}
								{contract.inputs.map((i) => (
									<li
										key={`${i.name}-${i.controlType}`}
										className="flex items-baseline gap-2 text-[11px]"
									>
										<span className="text-fl-black font-semibold">{i.name}</span>
										<span className="text-fl-gray font-mono text-[10px] uppercase tracking-wider">
											{i.controlType}
										</span>
										<span className="text-fl-gray text-[10px] truncate">
											{Array.isArray(i.domain)
												? `{${i.domain.slice(0, 5).join(', ')}${i.domain.length > 5 ? ', …' : ''}}`
												: i.domain}
										</span>
									</li>
								))}
							</ul>
						</Card>
					</section>

					<section className="px-3.5 pb-3">
						<Card padding="sm" tone="neutral" title="Expected behaviors">
							<ul className="space-y-1.5">
								{contract.expectedBehaviors.length === 0 && (
									<li className="text-fl-gray text-[11px]">(none extracted)</li>
								)}
								{contract.expectedBehaviors.map((b, idx) => {
									const open = openBehaviorId === b.id;
									return (
										<li key={b.id} className="border-fl-line border">
											<button
												type="button"
												onClick={() => setOpenBehaviorId(open ? null : b.id)}
												className="flex w-full items-start gap-2 px-2 py-1.5 text-left"
												aria-expanded={open}
											>
												{open ? (
													<ChevronDown size={12} className="text-fl-gray mt-0.5 shrink-0" aria-hidden="true" />
												) : (
													<ChevronRight size={12} className="text-fl-gray mt-0.5 shrink-0" aria-hidden="true" />
												)}
												<span className="text-fl-gray font-mono text-[10px] tabular-nums shrink-0">
													B{idx + 1}
												</span>
												<span className="text-fl-black flex-1 text-[11px] leading-tight">
													{b.then}
												</span>
												{b.importance === 'critical' && (
													<Pill size="xs" variant="warn">critical</Pill>
												)}
											</button>
											{open && (
												<div className="border-fl-line bg-fl-soft border-t px-2 py-1.5 text-[10.5px] leading-relaxed space-y-0.5">
													<div>
														<span className="text-fl-gray font-mono uppercase tracking-wider mr-1">given</span>
														<span className="text-fl-black">{b.given}</span>
													</div>
													<div>
														<span className="text-fl-gray font-mono uppercase tracking-wider mr-1">when</span>
														<span className="text-fl-black">{b.when}</span>
													</div>
													<div>
														<span className="text-fl-gray font-mono uppercase tracking-wider mr-1">then</span>
														<span className="text-fl-black">{b.then}</span>
													</div>
													<div className="border-fl-line border-t pt-1 mt-1">
														<span className="text-fl-gray font-mono uppercase tracking-wider mr-1">observable</span>
														<span className="text-fl-black">{b.observableOutcome}</span>
													</div>
												</div>
											)}
										</li>
									);
								})}
							</ul>
						</Card>
					</section>

					<section className="px-3.5 pb-3">
						<Card padding="sm" tone="neutral" title="Invariants">
							<ul className="space-y-1">
								{contract.invariants.length === 0 && (
									<li className="text-fl-gray text-[11px]">(none extracted)</li>
								)}
								{contract.invariants.map((inv, i) => (
									<li
										key={`inv-${i}`}
										className="flex items-baseline gap-2 text-[11px] leading-snug"
									>
										<span className="text-fl-gray font-mono text-[10px] tabular-nums shrink-0 w-5">
											{String(i + 1).padStart(2, '0')}
										</span>
										<span className="text-fl-black">{inv}</span>
									</li>
								))}
							</ul>
						</Card>
					</section>

					{planSummary && (
						<section className="px-3.5 pb-3">
							<Card padding="sm" tone="info">
								<div className="text-fl-gray font-mono text-[9px] uppercase tracking-wider">
									Test plan
								</div>
								<div className="text-fl-black mt-1 text-[12px] font-semibold">
									~{planSummary.total} variants
								</div>
								<div className="text-fl-gray mt-0.5 text-[10px]">
									{planSummary.verify} verify · {planSummary.edge} edge ·{' '}
									{planSummary.stress} stress · {planSummary.adv} adversarial ·{' '}
									{planSummary.inv} invariant
								</div>
								{contract.synthesizedByModel && (
									<div className="text-fl-gray mt-1 text-[9px] font-mono">
										synthesized by {contract.synthesizedByModel}
									</div>
								)}
							</Card>
						</section>
					)}
				</>
			)}

			{cookieSnap && (
				<section className="px-3.5 pb-3">
					<Card padding="sm" tone="neutral">
						<div className="text-fl-black flex items-center gap-2 text-[11px]">
							{cookieSnap.authDetected ? (
								<ShieldCheck size={14} className="text-fl-green" aria-hidden="true" />
							) : (
								<Cookie size={14} className="text-fl-gray" aria-hidden="true" />
							)}
							<span className="font-semibold">{cookieSnap.cookieCount} cookies captured</span>
							<Lock size={11} className="text-fl-gray" aria-hidden="true" />
							<span className="text-fl-gray text-[10px]">encrypted</span>
						</div>
						{cookieSnap.origin && (
							<div className="text-fl-gray mt-1 font-mono text-[10px] truncate">
								origin: {cookieSnap.origin}
							</div>
						)}
					</Card>
				</section>
			)}

			{(phase === 'matrix-gen' || phase === 'batch-start') && (
				<ApproveInFlight
					phase={phase}
					hintIdx={hintIdx}
					phaseStartedAt={phaseStartedAt}
				/>
			)}

			<div className="flex-1" />
			<PanelFooter>
				<div className="grid grid-cols-[1fr_auto] gap-2">
					<Button
						block
						size="md"
						variant="primary"
						onClick={approve}
						disabled={phase === 'matrix-gen' || phase === 'batch-start'}
					>
						{phase === 'matrix-gen'
							? 'Generating test plan…'
							: phase === 'batch-start'
								? 'Spinning up cloud sessions…'
								: '✓ Approve and run tests'}
					</Button>
					<Button
						size="md"
						variant="ghost"
						onClick={reRecord}
						disabled={phase === 'matrix-gen' || phase === 'batch-start'}
					>
						<RefreshCw size={12} className="mr-1 inline-block" aria-hidden="true" />
						Re-record
					</Button>
				</div>
			</PanelFooter>
		</PageShell>
	);
}

// ───────────────────────── In-flight progress card ──────────────────────────

function ApproveInFlight({
	phase,
	hintIdx,
	phaseStartedAt,
}: {
	phase: 'matrix-gen' | 'batch-start';
	hintIdx: number;
	phaseStartedAt: number | null;
}) {
	const [tick, setTick] = useState(0);
	useEffect(() => {
		const h = setInterval(() => setTick((t) => t + 1), 1000);
		return () => clearInterval(h);
	}, []);
	const elapsedSec = phaseStartedAt
		? Math.floor((Date.now() - phaseStartedAt) / 1000)
		: 0;
	// `tick` exists only to force a re-render every second; not read.
	void tick;

	const hints = phase === 'matrix-gen' ? MATRIX_GEN_HINTS : BATCH_START_HINTS;
	const hint = hints[Math.min(hintIdx, hints.length - 1)];

	const stages: ProgressStage[] = [
		{
			id: 'matrix-gen',
			label: 'Generate test plan (gpt-5.4)',
			state:
				phase === 'matrix-gen'
					? 'active'
					: phase === 'batch-start'
						? 'done'
						: 'pending',
			...(phase === 'matrix-gen' && hint ? { detail: hint } : {}),
		},
		{
			id: 'batch-start',
			label: 'Spawn cloud browsers',
			state: phase === 'batch-start' ? 'active' : 'pending',
			...(phase === 'batch-start' && hint ? { detail: hint } : {}),
		},
	];

	const headline =
		phase === 'matrix-gen'
			? 'AI senior QA is planning your test matrix'
			: 'Allocating cloud browsers';

	return (
		<section className="px-3.5 pb-3">
			<Card padding="md" tone="info">
				<div className="flex items-start gap-2">
					<div className="text-fl-cta shrink-0 fl-stage-pulse">
						<Cpu size={18} aria-hidden="true" />
					</div>
					<div className="min-w-0 flex-1">
						<div className="text-fl-black text-[12px] font-semibold leading-tight">
							{headline}
						</div>
						<div className="text-fl-gray mt-1 text-[10.5px] leading-snug">
							{hint}
						</div>
						<div className="border-fl-line mt-2 border-t pt-2">
							<ProgressStages stages={stages} />
						</div>
						<div className="text-fl-gray mt-2 flex items-center justify-between font-mono text-[9px] uppercase tracking-wider">
							<span>{phase === 'matrix-gen' ? 'thinking' : 'launching'}</span>
							<span>elapsed {elapsedSec}s</span>
						</div>
					</div>
				</div>
			</Card>
		</section>
	);
}
