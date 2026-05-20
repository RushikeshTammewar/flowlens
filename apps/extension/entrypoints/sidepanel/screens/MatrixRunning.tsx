import { useEffect, useMemo, useState } from 'react';
import { ArrowUpRight, ChevronDown, ChevronRight } from 'lucide-react';
import { useAppState } from '../../../lib/state';
import { APP_CONFIG } from '../../../app.config';
import {
	api,
	type BatchView,
	type BatchVariantRow,
	type Phase4Mode,
} from '../../../lib/api-client';
import {
	Card,
	PageShell,
	PanelHeader,
	Pill,
	Wordmark,
} from '../../../components/ui';

const MODE_ORDER: Phase4Mode[] = ['verify', 'edge', 'stress', 'adversarial', 'invariant'];
const MODE_LABEL: Record<Phase4Mode, string> = {
	verify: 'V',
	edge: 'E',
	stress: 'S',
	adversarial: 'A',
	invariant: 'I',
};

export function MatrixRunning() {
	const mode = useAppState((s) => s.mode);
	const setMode = useAppState((s) => s.setMode);
	const [data, setData] = useState<BatchView | null>(null);
	// Default the recorded-flow context card CLOSED so the page leads
	// with the live batch surface — the contract was already approved
	// on the previous screen, the user doesn't need to re-read step 30
	// of 32 here. They can expand on demand.
	const [flowOpen, setFlowOpen] = useState(false);
	// Phase 4 / UX §6.6 — featured iframe. The 400px side-panel can
	// only realistically watch ONE cloud browser at a time at a
	// readable size. We feature whichever variant the user clicked
	// (or the first running variant by default) at full panel width
	// + ~280px tall. The other 4 variants are status-only chips.
	const [featuredVariantId, setFeaturedVariantId] = useState<string | null>(null);

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

	// Phase 4 / Tier 4 — behavior × mode grid is the primary live progress
	// surface (UX §6.6). Build it iff at least one variant carries a Phase 4
	// `mode` column; older V1 variant batches still get the family/fragility
	// cards below as a fallback.
	const phase4Active = variants.some((v) => v.variant.mode);
	const grid = useMemo(() => buildGrid(variants), [variants]);

	// Auto-pick the featured variant: user's explicit pick wins; else the
	// first RUNNING variant (so the panel always has something live to
	// watch); else the first variant overall as a passive preview.
	const featuredVariant = useMemo(() => {
		if (featuredVariantId) {
			const m = variants.find((v) => v.variant.id === featuredVariantId);
			if (m) return m;
		}
		return (
			variants.find((v) => v.run?.status === 'running' && v.run?.liveUrl) ??
			variants.find((v) => v.run?.liveUrl) ??
			null
		);
	}, [variants, featuredVariantId]);

	const liveboardUrl = `${APP_CONFIG.flowlensWebUrl}/app/features/${mode.flowId}/runs/${mode.batchId}?live=1`;
	const openLiveboard = () => {
		// Chrome de-dupes by URL so re-clicking focuses the existing tab
		// instead of spawning duplicates. We use chrome.tabs.create
		// because window.open() can be blocked by Chrome in side-panel
		// contexts; the extension already has the "tabs" permission.
		try {
			void chrome.tabs.create({ url: liveboardUrl, active: true });
		} catch {
			window.open(liveboardUrl, '_blank', 'noopener,noreferrer');
		}
	};

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
			{/* Compact headline — counts + open-liveboard CTA. The wide
			   grid of liveUrl iframes lives on the web tab (auto-opened
			   on Approve in ContractReview); this CTA is the manual
			   re-open if the user closed the tab. */}
			<section className="px-4 py-3">
				<div className="flex items-start justify-between gap-2">
					<div className="min-w-0">
						<h1 className="font-serif text-fl-black text-[18px] leading-tight tracking-tight">
							{flow?.name ?? 'Test matrix'}
						</h1>
						<p className="text-fl-gray mt-1 text-[10.5px]">
							{counts.running} running · {counts.queued} queued ·{' '}
							{counts.failed + counts.errored} failed · {counts.passed} passed
						</p>
					</div>
					<button
						type="button"
						onClick={openLiveboard}
						className="border-fl-line bg-fl-soft text-fl-black hover:bg-fl-line/40 shrink-0 border px-2 py-1 text-[10px] font-mono uppercase tracking-wider"
					>
						Open Liveboard
						<ArrowUpRight size={10} className="ml-1 inline-block" aria-hidden="true" />
					</button>
				</div>
			</section>

			{phase4Active && grid.rows.length > 0 && (
				<section className="px-3.5 pb-3">
					<Card padding="sm" tone="neutral" title="By behavior">
						<BehaviorModeGrid rows={grid.rows} modesPresent={grid.modesPresent} />
						<div className="text-fl-gray mt-2 font-mono text-[9px] uppercase tracking-wider">
							V verify · E edge · S stress · A adversarial · I invariant
						</div>
						<div className="text-fl-gray mt-0.5 font-mono text-[9px]">
							✓ pass · ✗ fail · • running · ○ queued
						</div>
					</Card>
				</section>
			)}

			{/* ONE featured iframe at full panel width — readable size */}
			{featuredVariant && (
				<section className="px-3.5 pb-3">
					<FeaturedIframeCard
						row={featuredVariant}
						onOpenInTab={() => {
							const url = featuredVariant.run?.liveUrl;
							if (!url) return;
							try {
								void chrome.tabs.create({ url, active: true });
							} catch {
								window.open(url, '_blank', 'noopener,noreferrer');
							}
						}}
					/>
				</section>
			)}

			{/* Variant chips strip — click to feature; long-press / chip-↗
			   to open that variant's BU Cloud liveUrl in a fresh tab. */}
			{variants.length > 0 && (
				<section className="px-3.5 pb-3">
					<div className="text-fl-gray font-mono text-[9px] uppercase tracking-wider mb-1.5">
						Other variants ({variants.length})
					</div>
					<div className="flex flex-wrap gap-1">
						{variants.map((v) => (
							<VariantChip
								key={v.variant.id}
								row={v}
								active={v.variant.id === featuredVariant?.variant.id}
								onClick={() => setFeaturedVariantId(v.variant.id)}
							/>
						))}
					</div>
				</section>
			)}

			{/* Recorded-flow context card — collapsed by default. The user
			   already approved the contract, they don't need to re-read
			   30 step intents while the matrix is running. */}
			{flow && (
				<section className="px-3.5 pb-4">
					<Card padding="sm" tone="neutral">
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
								<div className="text-fl-black mt-0.5 text-[11px] font-semibold leading-tight truncate">
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
		</PageShell>
	);
}

// ──────────────────── Featured iframe + variant chip ──────────────────────

function FeaturedIframeCard({
	row,
	onOpenInTab,
}: {
	row: BatchVariantRow;
	onOpenInTab: () => void;
}) {
	const status = row.run?.status ?? 'queued';
	const liveUrl = row.run?.liveUrl ?? null;
	const showLive = status === 'running' && !!liveUrl;

	const iframeNode = useMemo(() => {
		if (!liveUrl) return null;
		return (
			<iframe
				src={liveUrl}
				title={`Featured live · ${row.variant.name}`}
				className="block h-[220px] w-full border-0 bg-fl-white"
				sandbox="allow-scripts allow-same-origin"
			/>
		);
		// liveUrl is the only thing that should retrigger the iframe
		// remount; row identity changes on every poll.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [liveUrl]);

	return (
		<div className="border-fl-line border bg-fl-black/95 overflow-hidden">
			<header className="bg-fl-soft border-fl-line text-fl-gray flex items-center justify-between border-b px-2 py-1 text-[9px] uppercase tracking-wider">
				<span className="flex min-w-0 items-center gap-1.5">
					{showLive ? (
						<>
							<span className="bg-fl-red inline-block h-1.5 w-1.5 rounded-full fl-stage-pulse" />
							<span className="text-fl-black">live</span>
						</>
					) : (
						<>
							<span className="bg-fl-line inline-block h-1.5 w-1.5 rounded-full" />
							<span>{status}</span>
						</>
					)}
					<span className="text-fl-line">·</span>
					<span className="text-fl-black truncate font-sans normal-case tracking-normal text-[10px] font-semibold">
						{row.variant.mode ?? row.variant.family}
						{' · '}
						{row.variant.name}
					</span>
				</span>
				{liveUrl && (
					<button
						type="button"
						onClick={onOpenInTab}
						className="text-fl-gray hover:text-fl-black flex items-center gap-0.5 shrink-0 ml-2"
						title="Open this variant's cloud browser in a new tab (full size)"
					>
						<span>tab</span>
						<ArrowUpRight size={9} aria-hidden="true" />
					</button>
				)}
			</header>
			{showLive ? (
				iframeNode
			) : (
				<div className="bg-fl-soft text-fl-gray flex h-[140px] items-center justify-center text-[10px]">
					{status === 'queued'
						? 'queued — will start when a slot frees up'
						: status === 'passed'
							? '✓ variant completed — pick another to feature'
							: status === 'failed' || status === 'errored'
								? `✗ variant ${status} — pick another to feature`
								: liveUrl
									? 'connecting to cloud browser…'
									: 'no live url'}
				</div>
			)}
		</div>
	);
}

function VariantChip({
	row,
	active,
	onClick,
}: {
	row: BatchVariantRow;
	active: boolean;
	onClick: () => void;
}) {
	const status = row.run?.status ?? 'queued';
	const mode = row.variant.mode ?? row.variant.family;
	const modeLabel =
		mode === 'verify'
			? 'V'
			: mode === 'edge'
				? 'E'
				: mode === 'stress'
					? 'S'
					: mode === 'adversarial'
						? 'A'
						: mode === 'invariant'
							? 'I'
							: '·';
	const glyph =
		status === 'passed'
			? '✓'
			: status === 'failed' || status === 'errored'
				? '✗'
				: status === 'running'
					? '•'
					: '○';
	const tone =
		status === 'passed'
			? 'border-fl-green text-fl-green'
			: status === 'failed' || status === 'errored'
				? 'border-fl-red text-fl-red'
				: status === 'running'
					? 'border-fl-amber text-fl-amber'
					: 'border-fl-line text-fl-gray';
	return (
		<button
			type="button"
			onClick={onClick}
			title={`${row.variant.name} · ${status}`}
			className={`flex items-center gap-1 border px-1.5 py-0.5 font-mono text-[10px] tabular-nums ${tone} ${active ? 'bg-fl-soft ring-1 ring-fl-cta' : 'bg-fl-white'}`}
		>
			<span className="text-fl-black">{modeLabel}</span>
			<span>{glyph}</span>
		</button>
	);
}

// ──────────────────── Phase 4 / Tier 4 — behavior × mode grid ─────────────

interface GridCell {
	mode: Phase4Mode;
	status: 'passed' | 'failed' | 'running' | 'queued' | 'errored' | 'inconclusive';
}
interface GridRow {
	behaviorId: string;
	label: string;
	cells: Record<Phase4Mode, GridCell[]>;
}

function buildGrid(variants: BatchVariantRow[]): {
	rows: GridRow[];
	modesPresent: Phase4Mode[];
} {
	const byBehavior = new Map<string, GridRow>();
	const modes = new Set<Phase4Mode>();
	for (const v of variants) {
		const mode = v.variant.mode;
		if (!mode) continue;
		modes.add(mode);
		const behaviorId = v.variant.behaviorId ?? `invariant-${v.variant.id.slice(0, 8)}`;
		const label = (() => {
			if (mode === 'invariant') {
				return v.variant.name.length > 28 ? v.variant.name.slice(0, 28) + '…' : v.variant.name;
			}
			// Pull a short title from the recorded variant name so the
			// row reads like "B1 Cat narrows" instead of the full GUID.
			const t = v.variant.name.split(' — ')[0] ?? v.variant.name;
			return t.length > 28 ? t.slice(0, 28) + '…' : t;
		})();
		const row: GridRow = byBehavior.get(behaviorId) ?? {
			behaviorId,
			label,
			cells: { verify: [], edge: [], stress: [], adversarial: [], invariant: [] },
		};
		const status: GridCell['status'] = (() => {
			const s = v.run?.status ?? 'queued';
			if (s === 'passed' || s === 'failed' || s === 'errored' || s === 'running' || s === 'queued')
				return s;
			return 'inconclusive';
		})();
		row.cells[mode].push({ mode, status });
		byBehavior.set(behaviorId, row);
	}
	const modesPresent = MODE_ORDER.filter((m) => modes.has(m));
	return { rows: [...byBehavior.values()], modesPresent };
}

function BehaviorModeGrid({
	rows,
	modesPresent,
}: {
	rows: GridRow[];
	modesPresent: Phase4Mode[];
}) {
	return (
		<div className="overflow-x-auto">
			<table className="w-full border-separate border-spacing-y-0.5 text-[11px]">
				<thead>
					<tr className="text-fl-gray font-mono text-[9px] uppercase tracking-wider">
						<th className="text-left font-normal pr-2">Behavior</th>
						{modesPresent.map((m) => (
							<th key={m} className="text-center font-normal w-7" title={m}>
								{MODE_LABEL[m]}
							</th>
						))}
					</tr>
				</thead>
				<tbody>
					{rows.map((row) => (
						<tr key={row.behaviorId}>
							<td className="text-fl-black truncate max-w-[180px] pr-2">{row.label}</td>
							{modesPresent.map((m) => {
								const cells = row.cells[m];
								return (
									<td key={m} className="text-center">
										<CellGroup cells={cells} />
									</td>
								);
							})}
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
}

function CellGroup({ cells }: { cells: GridCell[] }) {
	if (cells.length === 0) {
		return <span className="text-fl-gray">·</span>;
	}
	return (
		<span className="inline-flex items-center justify-center gap-0.5">
			{cells.map((c, i) => (
				<CellMark key={i} status={c.status} />
			))}
		</span>
	);
}

function CellMark({ status }: { status: GridCell['status'] }) {
	switch (status) {
		case 'passed':
			return <span className="text-fl-green inline-block w-3 text-center">✓</span>;
		case 'failed':
		case 'errored':
		case 'inconclusive':
			return <span className="text-fl-red inline-block w-3 text-center">✗</span>;
		case 'running':
			return (
				<span className="text-fl-amber inline-block h-2 w-2 rounded-full bg-current fl-stage-pulse" />
			);
		case 'queued':
			return <span className="text-fl-gray inline-block w-3 text-center">○</span>;
	}
}

