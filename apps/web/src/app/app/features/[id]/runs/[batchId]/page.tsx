/**
 * Phase 4 / Tier 4 — Run report deep view (UX §7.4).
 *
 * Server component. Lands here when the side panel "Open full report ↗"
 * CTA fires (`${flowlensWebUrl}/app/features/${flowId}/runs/${batchId}`).
 *
 * Surfaces everything the side panel had to truncate:
 *   - Two-axis verdict header (Correctness × Robustness)
 *   - AI cluster summary
 *   - Behavior × mode grid (same shape as the side panel — users learn
 *     it once)
 *   - Per-behavior verdict detail (failure reason, failing variants)
 *   - Per-variant evidence panel: assertion spec + result + recorded
 *     vs replay screenshot pair
 *
 * Auth: tryPageAuthContext() — uses live Clerk session if signed in,
 * falls back to demo org under FLOWLENS_DEMO_MODE=true, redirects to
 * /sign-in otherwise.
 *
 * Logged under scope: [phase4:web]
 */
import { redirect, notFound } from 'next/navigation';
import { eq, inArray } from 'drizzle-orm';
import Link from 'next/link';
import { db } from '@/lib/db';
import { tryPageAuthContext } from '@/lib/auth';
import {
	flows,
	runs,
	runBatches,
	stepResults,
	testVariants,
} from '@flowlens/schema/db';
import {
	type AssertionEval,
	type BehaviorVerdict,
	type FeatureContract,
	type FlowStep,
} from '@flowlens/schema';

interface PageProps {
	params: Promise<{ id: string; batchId: string }>;
}

const MODE_ORDER = ['verify', 'edge', 'stress', 'adversarial', 'invariant'] as const;
type Mode = (typeof MODE_ORDER)[number];
const MODE_LABEL: Record<Mode, string> = {
	verify: 'Verify',
	edge: 'Edge',
	stress: 'Stress',
	adversarial: 'Adv',
	invariant: 'Inv',
};

export default async function RunReportPage({ params }: PageProps) {
	const { id: flowId, batchId } = await params;

	const auth = await tryPageAuthContext();
	if (!auth) {
		// Encode return-url so it survives Clerk's sign-in roundtrip; cast
		// avoids Next typed-routes complaint about the dynamic suffix.
		const returnUrl = `/app/features/${flowId}/runs/${batchId}`;
		redirect(`/sign-in?returnUrl=${encodeURIComponent(returnUrl)}` as never);
	}

	const flow = await db.query.flows.findFirst({ where: eq(flows.id, flowId) });
	if (!flow || flow.orgId !== auth.org.id) {
		notFound();
	}

	const batch = await db.query.runBatches.findFirst({
		where: eq(runBatches.id, batchId),
	});
	if (!batch || batch.orgId !== auth.org.id || batch.flowId !== flowId) {
		notFound();
	}

	const childRuns = await db.query.runs.findMany({
		where: eq(runs.batchId, batchId),
	});
	const variantIds = batch.variantIds;
	const variants = variantIds.length
		? await db.query.testVariants.findMany({
				where: inArray(testVariants.id, variantIds),
			})
		: [];
	const runIds = childRuns.map((r) => r.id);
	const allSteps = runIds.length
		? await db.query.stepResults.findMany({
				where: inArray(stepResults.runId, runIds),
			})
		: [];

	const stepsByRun = new Map<string, typeof allSteps>();
	for (const s of allSteps) {
		const arr = stepsByRun.get(s.runId) ?? [];
		arr.push(s);
		stepsByRun.set(s.runId, arr);
	}

	const blobBase = process.env.BLOB_PUBLIC_BASE_URL ?? '';
	const contract = (flow.featureContract ?? null) as FeatureContract | null;
	const verdicts = (batch.behaviorVerdicts ?? []) as BehaviorVerdict[];
	const verdictById = new Map(verdicts.map((v) => [v.behaviorId, v]));

	const correctness = {
		verified: batch.correctnessVerifiedCount,
		total: batch.correctnessTotalCount,
	};
	const robustness = {
		verified: batch.robustnessVerifiedCount,
		total: batch.robustnessTotalCount,
	};

	const variantsView = variants.map((v) => {
		const run = childRuns.find((r) => r.variantId === v.id);
		const steps = run ? stepsByRun.get(run.id) ?? [] : [];
		const lastStep = [...steps].sort((a, b) => b.stepIndex - a.stepIndex)[0];
		const ae = lastStep ? ((lastStep.assertionEval ?? null) as AssertionEval | null) : null;
		return { variant: v, run, steps, assertionEval: ae };
	});

	const grid = buildReportGrid(variantsView);

	// Per-step screenshot URL helpers (recorded + replay).
	const recordedFlowSteps = (flow.steps as FlowStep[]) ?? [];
	const recordedScreenshotByIdx = new Map<number, string>();
	for (const s of recordedFlowSteps) {
		if (blobBase && s.recordedScreenshotKey) {
			recordedScreenshotByIdx.set(s.index, `${blobBase}/${s.recordedScreenshotKey}`);
		}
	}

	const startedAt = batch.startedAt ? new Date(batch.startedAt) : null;
	const finishedAt = batch.finishedAt ? new Date(batch.finishedAt) : null;
	const durationMs = startedAt && finishedAt ? finishedAt.getTime() - startedAt.getTime() : null;

	return (
		<main className="min-h-screen bg-fl-white text-fl-black">
			<div className="mx-auto max-w-5xl px-6 py-10">
				<div className="text-fl-gray mb-4 text-xs">
					<Link href="/" className="hover:underline">
						← Flowlens
					</Link>{' '}
					/ {flow.name}
				</div>

				<header className="mb-6 border-b border-fl-light pb-6">
					<h1 className="text-3xl font-semibold tracking-tight">{flow.name}</h1>
					<p className="text-fl-gray mt-1 text-sm">
						Run #{batch.id.slice(0, 8)} ·{' '}
						{startedAt ? startedAt.toLocaleString() : 'pending'}
						{durationMs ? ` · ${Math.round(durationMs / 1000)}s` : ''} ·{' '}
						{variantsView.length} variants ({variantsView.filter((v) => v.run?.status === 'passed').length}{' '}
						✓ · {variantsView.filter((v) => v.run?.status === 'failed').length} ✗)
					</p>
				</header>

				<section className="mb-8">
					<h2 className="text-fl-gray mb-3 text-xs uppercase tracking-wider">
						Two-axis verdict
					</h2>
					<div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
						<AxisCard label="Correctness" verified={correctness.verified} total={correctness.total} />
						<AxisCard label="Robustness" verified={robustness.verified} total={robustness.total} />
					</div>
				</section>

				{batch.aiClusterSummary && (
					<section className="mb-8">
						<h2 className="text-fl-gray mb-3 text-xs uppercase tracking-wider">
							AI debugging analysis
						</h2>
						<div className="border-fl-line bg-fl-soft border p-4">
							<p className="whitespace-pre-line text-sm leading-relaxed">
								{batch.aiClusterSummary}
							</p>
						</div>
					</section>
				)}

				{grid.rows.length > 0 && (
					<section className="mb-8">
						<h2 className="text-fl-gray mb-3 text-xs uppercase tracking-wider">
							Behaviors × Modes
						</h2>
						<div className="border-fl-line border overflow-x-auto">
							<table className="w-full text-sm">
								<thead className="bg-fl-soft">
									<tr className="text-fl-gray text-left text-xs uppercase tracking-wider">
										<th className="px-3 py-2 font-normal">Behavior</th>
										{grid.modesPresent.map((m) => (
											<th key={m} className="px-2 py-2 text-center font-normal w-16">
												{MODE_LABEL[m]}
											</th>
										))}
										<th className="px-2 py-2 text-center font-normal w-16">Cor</th>
										<th className="px-2 py-2 text-center font-normal w-16">Rob</th>
									</tr>
								</thead>
								<tbody className="divide-y divide-fl-light">
									{grid.rows.map((row) => {
										const verdict = verdictById.get(row.behaviorId);
										return (
											<tr key={row.behaviorId}>
												<td className="px-3 py-2">
													<div className="font-medium truncate max-w-md">{row.label}</div>
													{verdict?.failureSummary && (
														<div className="text-fl-gray mt-0.5 text-xs leading-snug">
															{verdict.failureSummary}
														</div>
													)}
												</td>
												{grid.modesPresent.map((m) => (
													<td key={m} className="px-2 py-2 text-center">
														<CellBadge cells={row.cells[m]} />
													</td>
												))}
												<td className="px-2 py-2 text-center">{axisMark(verdict, ['verify', 'edge'])}</td>
												<td className="px-2 py-2 text-center">{axisMark(verdict, ['stress', 'adversarial', 'invariant'])}</td>
											</tr>
										);
									})}
								</tbody>
							</table>
						</div>
					</section>
				)}

				<section className="mb-12">
					<h2 className="text-fl-gray mb-3 text-xs uppercase tracking-wider">
						Per-variant evidence
					</h2>
					<div className="space-y-3">
						{variantsView.map(({ variant, run, steps, assertionEval }) => (
							<VariantPanel
								key={variant.id}
								variant={variant}
								run={run ?? null}
								assertionEval={assertionEval}
								steps={steps}
								blobBase={blobBase}
								recordedScreenshotByIdx={recordedScreenshotByIdx}
							/>
						))}
					</div>
				</section>

				{contract && (
					<section className="mb-12 border-t border-fl-light pt-6">
						<h2 className="text-fl-gray mb-3 text-xs uppercase tracking-wider">
							Feature Contract
						</h2>
						<div className="text-sm">
							<div className="mb-3 font-semibold">{contract.featureName}</div>
							<details className="border-fl-line border bg-fl-soft p-3 text-xs">
								<summary className="cursor-pointer font-mono uppercase tracking-wider text-fl-gray">
									{contract.expectedBehaviors.length} behaviors · {contract.invariants.length} invariants ·{' '}
									{contract.inputs.length} inputs
								</summary>
								<pre className="mt-2 overflow-x-auto text-[11px] leading-snug">
									{JSON.stringify(contract, null, 2)}
								</pre>
							</details>
						</div>
					</section>
				)}

				<footer className="text-fl-gray border-t border-fl-light pt-4 text-xs">
					Flowlens v3 · {new Date().getFullYear()}
				</footer>
			</div>
		</main>
	);
}

function AxisCard({
	label,
	verified,
	total,
}: {
	label: string;
	verified: number;
	total: number;
}) {
	const pct = total > 0 ? Math.round((verified / total) * 100) : 0;
	const tone = total === 0 ? 'gray' : pct === 100 ? 'green' : pct >= 60 ? 'amber' : 'red';
	const barClass =
		tone === 'green'
			? 'bg-fl-green'
			: tone === 'amber'
				? 'bg-fl-amber'
				: tone === 'red'
					? 'bg-fl-red'
					: 'bg-fl-line';
	return (
		<div className="border-fl-line border p-4">
			<div className="flex items-baseline justify-between">
				<div className="font-semibold">{label}</div>
				<div className="text-fl-gray font-mono text-sm tabular-nums">
					{verified}/{total}
				</div>
			</div>
			<div className="bg-fl-soft border-fl-line mt-3 h-2 overflow-hidden border">
				<div className={barClass} style={{ height: '100%', width: `${pct}%` }} />
			</div>
			<div className="text-fl-gray mt-1 text-xs">{pct}% verified</div>
		</div>
	);
}

interface ReportGridRow {
	behaviorId: string;
	label: string;
	cells: Record<Mode, Array<'passed' | 'failed' | 'inconclusive' | 'queued' | 'running' | 'errored'>>;
}

interface VariantViewItem {
	variant: typeof testVariants.$inferSelect;
	run: typeof runs.$inferSelect | undefined;
	steps: Array<typeof stepResults.$inferSelect>;
	assertionEval: AssertionEval | null;
}

function buildReportGrid(
	variantsView: VariantViewItem[],
): { rows: ReportGridRow[]; modesPresent: Mode[] } {
	const byBehavior = new Map<string, ReportGridRow>();
	const modes = new Set<Mode>();
	for (const v of variantsView) {
		const m = (v.variant.mode ?? null) as Mode | null;
		if (!m) continue;
		modes.add(m);
		const behaviorId = v.variant.behaviorId ?? `invariant-${v.variant.id.slice(0, 8)}`;
		const label = (() => {
			if (m === 'invariant') return v.variant.name;
			const t = v.variant.name.split(' — ')[0] ?? v.variant.name;
			return t;
		})();
		const row: ReportGridRow = byBehavior.get(behaviorId) ?? {
			behaviorId,
			label,
			cells: { verify: [], edge: [], stress: [], adversarial: [], invariant: [] },
		};
		const status = v.run?.status ?? 'queued';
		const cell: ReportGridRow['cells'][Mode][number] = (() => {
			if (status === 'passed') return 'passed';
			if (status === 'failed' || status === 'errored' || status === 'canceled')
				return 'failed';
			if (status === 'running' || status === 'paused_auth' || status === 'paused_user')
				return 'running';
			return 'queued';
		})();
		row.cells[m].push(cell);
		byBehavior.set(behaviorId, row);
	}
	return { rows: [...byBehavior.values()], modesPresent: MODE_ORDER.filter((m) => modes.has(m)) };
}

function CellBadge({
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
							? 'text-fl-green font-semibold'
							: c === 'failed' || c === 'errored' || c === 'inconclusive'
								? 'text-fl-red font-semibold'
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

function axisMark(verdict: BehaviorVerdict | undefined, modes: Mode[]) {
	if (!verdict) return <span className="text-fl-gray">·</span>;
	const relevant = verdict.modes.filter((m) => modes.includes(m.mode as Mode));
	if (relevant.length === 0) return <span className="text-fl-gray">—</span>;
	const allPass = relevant.every((m) => m.variantsFailed === 0 && m.variantsTotal > 0);
	const anyFail = relevant.some((m) => m.variantsFailed > 0);
	if (allPass) return <span className="text-fl-green font-semibold">✓</span>;
	if (anyFail) return <span className="text-fl-red font-semibold">✗</span>;
	return <span className="text-fl-gray">·</span>;
}

function VariantPanel({
	variant,
	run,
	assertionEval,
	steps,
	blobBase,
	recordedScreenshotByIdx,
}: {
	variant: typeof testVariants.$inferSelect;
	run: typeof runs.$inferSelect | null;
	assertionEval: AssertionEval | null;
	steps: Array<typeof stepResults.$inferSelect>;
	blobBase: string;
	recordedScreenshotByIdx: Map<number, string>;
}) {
	const status = run?.status ?? 'queued';
	const lastStep = [...steps].sort((a, b) => b.stepIndex - a.stepIndex)[0];
	const replayUrl = blobBase && lastStep?.replayScreenshotKey
		? `${blobBase}/${lastStep.replayScreenshotKey}`
		: null;
	const recordedUrl = lastStep ? recordedScreenshotByIdx.get(lastStep.stepIndex) ?? null : null;
	const statusColor =
		status === 'passed'
			? 'bg-fl-green text-fl-white'
			: status === 'failed' || status === 'errored'
				? 'bg-fl-red text-fl-white'
				: status === 'running'
					? 'bg-fl-amber text-fl-white'
					: 'bg-fl-line text-fl-gray';

	return (
		<details className="border-fl-line border bg-fl-white">
			<summary className="cursor-pointer p-3">
				<div className="flex items-start justify-between gap-3">
					<div className="min-w-0 flex-1">
						<div className="flex items-center gap-2">
							{variant.mode && (
								<span className="text-fl-gray bg-fl-soft border-fl-line border px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider">
									{variant.mode}
								</span>
							)}
							<span className="text-fl-black font-semibold text-sm truncate">
								{variant.name}
							</span>
						</div>
						<div className="text-fl-gray mt-1 text-xs leading-snug">
							{variant.description}
						</div>
					</div>
					<span className={`shrink-0 px-2 py-1 text-xs font-medium ${statusColor}`}>
						{status}
					</span>
				</div>
			</summary>
			<div className="border-fl-line border-t p-3 text-xs space-y-3">
				{variant.riskHypothesis && (
					<KV label="Risk hypothesis" value={variant.riskHypothesis} />
				)}
				{variant.assertion && (
					<KV
						label="Assertion"
						value={
							<div>
								<div>
									<span className="font-mono text-[11px]">kind=</span>
									{(variant.assertion as { spec?: { kind?: string } }).spec?.kind ?? '—'}
								</div>
								<div className="text-fl-gray mt-0.5">
									{(variant.assertion as { fallbackPrompt?: string }).fallbackPrompt ?? ''}
								</div>
							</div>
						}
					/>
				)}
				{typeof variant.shouldPass === 'boolean' && (
					<KV
						label="Should pass"
						value={
							<span className="font-mono">
								{variant.shouldPass ? '✓ pass when assertion holds' : '✗ pass when app REJECTS the input'}
							</span>
						}
					/>
				)}
				{assertionEval && (
					<KV
						label="Assertion result"
						value={
							<div>
								<div className="font-medium">
									{assertionEval.passed ? '✓ assertion passed' : '✗ assertion failed'} · {assertionEval.evaluatedKind}
									{assertionEval.llmFallbackUsed ? ' (LLM fallback)' : ''}
								</div>
								<div className="text-fl-gray mt-0.5">{assertionEval.reason}</div>
							</div>
						}
					/>
				)}
				{run?.summary && <KV label="Run summary" value={run.summary} />}
				{(recordedUrl || replayUrl) && (
					<div>
						<div className="text-fl-gray mb-2 font-mono text-[10px] uppercase tracking-wider">
							Evidence — recorded vs replay
						</div>
						<div className="grid grid-cols-2 gap-2">
							<EvidenceImage label="Recorded" src={recordedUrl} />
							<EvidenceImage label="Replay" src={replayUrl} />
						</div>
					</div>
				)}
			</div>
		</details>
	);
}

function KV({ label, value }: { label: string; value: React.ReactNode }) {
	return (
		<div>
			<div className="text-fl-gray font-mono text-[10px] uppercase tracking-wider">
				{label}
			</div>
			<div className="text-fl-black mt-0.5">{value}</div>
		</div>
	);
}

function EvidenceImage({ label, src }: { label: string; src: string | null }) {
	if (!src) {
		return (
			<div className="border-fl-line bg-fl-soft text-fl-gray flex h-32 items-center justify-center border text-xs">
				{label}: no screenshot
			</div>
		);
	}
	return (
		<a
			href={src}
			target="_blank"
			rel="noreferrer"
			className="border-fl-line block overflow-hidden border bg-fl-soft hover:opacity-90"
		>
			<div className="text-fl-gray border-b border-fl-line bg-fl-white px-2 py-1 font-mono text-[10px] uppercase tracking-wider">
				{label}
			</div>
			<img src={src} alt={label} className="block max-h-64 w-full object-contain" />
		</a>
	);
}
