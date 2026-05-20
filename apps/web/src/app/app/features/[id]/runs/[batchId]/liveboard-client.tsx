/**
 * Phase 4 / Tier 4 v3.1 — Web Liveboard render mode (UX §7.6, LLD §6.7).
 *
 * Renders a 2- or 3-wide responsive grid of BU Cloud `liveUrl` iframes
 * (one per running variant) at 600×400 minimum so the user can actually
 * read what each cloud browser is doing in parallel — the side panel's
 * 400px column is too narrow for this.
 *
 * Polls `GET /api/batches/:id` every 2.5s using the demo bearer (when
 * FLOWLENS_DEMO_MODE) or the user's Clerk session cookie (otherwise).
 * Same data source as the side panel's MatrixRunning so the two
 * surfaces stay in sync.
 *
 * Self-promotion: when the polled response shows
 * `batch.status === 'completed'` (or 'errored'), we drop the `?live=1`
 * query param via `router.replace`. The server component re-renders
 * with `isLiveMode === false` and the Run Report layout takes over —
 * same URL, same tab, no nav visible to the user.
 */
'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';

interface LiveVariant {
	id: string;
	name: string;
	mode: 'verify' | 'edge' | 'stress' | 'adversarial' | 'invariant' | null;
	family: string;
	status: string;
	liveUrl: string | null;
}

interface PollResponse {
	batch: {
		id: string;
		status: 'queued' | 'running' | 'completed' | 'errored';
	};
	variants: Array<{
		variant: {
			id: string;
			name: string;
			mode: LiveVariant['mode'];
			family: string;
		};
		run: { status: string; liveUrl: string | null } | null;
	}>;
	counts: {
		total: number;
		passed: number;
		failed: number;
		errored: number;
		running: number;
		queued: number;
	};
}

const POLL_INTERVAL_MS = 2_500;

export function LiveboardClient({
	batchId,
	flowId: _flowId,
	initialVariants,
}: {
	batchId: string;
	flowId: string;
	initialVariants: LiveVariant[];
}) {
	const router = useRouter();
	const [variants, setVariants] = useState<LiveVariant[]>(initialVariants);
	const [counts, setCounts] = useState<PollResponse['counts'] | null>(null);
	const [batchStatus, setBatchStatus] = useState<PollResponse['batch']['status']>('running');
	const [pollErr, setPollErr] = useState<string | null>(null);

	useEffect(() => {
		let stopped = false;
		const tick = async () => {
			try {
				const res = await fetch(`/api/batches/${batchId}`, {
					credentials: 'include', // for Clerk cookie session
					cache: 'no-store',
				});
				if (!res.ok) {
					setPollErr(`poll ${res.status}`);
					return;
				}
				const body = (await res.json()) as PollResponse;
				if (stopped) return;
				setBatchStatus(body.batch.status);
				setCounts(body.counts);
				setVariants(
					body.variants.map((v) => ({
						id: v.variant.id,
						name: v.variant.name,
						mode: v.variant.mode,
						family: v.variant.family,
						status: v.run?.status ?? 'queued',
						liveUrl: v.run?.liveUrl ?? null,
					})),
				);
				setPollErr(null);
				// Self-promote: batch terminal → strip ?live=1, server
				// re-renders into Run Report mode automatically.
				if (body.batch.status === 'completed' || body.batch.status === 'errored') {
					stopped = true;
					router.replace(`/app/features/${_flowId}/runs/${batchId}`);
				}
			} catch (err) {
				setPollErr((err as Error).message);
			}
		};
		void tick();
		const handle = setInterval(() => void tick(), POLL_INTERVAL_MS);
		return () => {
			stopped = true;
			clearInterval(handle);
		};
	}, [batchId, _flowId, router]);

	const runningOrQueued = useMemo(
		() => variants.filter((v) => v.status !== 'passed' && v.status !== 'failed' && v.status !== 'errored'),
		[variants],
	);
	const finished = useMemo(
		() => variants.filter((v) => v.status === 'passed' || v.status === 'failed' || v.status === 'errored'),
		[variants],
	);

	return (
		<>
			<section className="mb-6">
				<div className="border-fl-line bg-fl-soft border p-3 text-sm">
					<div className="flex items-baseline gap-3">
						<span className="font-semibold">Live</span>
						{counts && (
							<span className="text-fl-gray text-xs">
								{counts.running} running · {counts.queued} queued ·{' '}
								{counts.passed} passed · {counts.failed} failed ·{' '}
								{counts.errored} errored
							</span>
						)}
						{pollErr && (
							<span className="text-fl-red text-xs ml-auto">poll: {pollErr}</span>
						)}
					</div>
					<p className="text-fl-gray mt-1 text-xs">
						This page becomes the full Run Report (verdict + per-variant
						evidence + cluster summary) the moment the batch completes. No
						page reload — the layout flips in place.
					</p>
				</div>
			</section>

			<section className="mb-8">
				<h2 className="text-fl-gray mb-3 text-xs uppercase tracking-wider">
					Live cloud browsers
					<span className="ml-2 normal-case text-fl-gray/70">
						(click ↗ on any tile to open at full window size)
					</span>
				</h2>
				{runningOrQueued.length === 0 ? (
					<div className="border-fl-line bg-fl-soft text-fl-gray border p-6 text-center text-sm">
						All variants finished — promoting to Run Report…
					</div>
				) : (
					<div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
						{runningOrQueued.map((v) => (
							<LiveTile key={v.id} variant={v} />
						))}
					</div>
				)}
			</section>

			{finished.length > 0 && (
				<section className="mb-8">
					<h2 className="text-fl-gray mb-3 text-xs uppercase tracking-wider">
						Already finished ({finished.length})
					</h2>
					<div className="grid grid-cols-2 gap-2 md:grid-cols-4 xl:grid-cols-6">
						{finished.map((v) => (
							<FinishedChip key={v.id} variant={v} />
						))}
					</div>
				</section>
			)}
		</>
	);
}

function LiveTile({ variant }: { variant: LiveVariant }) {
	const isRunning = variant.status === 'running';
	const liveUrl = variant.liveUrl;
	// Memoize iframe `src` so the 2.5s poll-driven re-render of the
	// parent doesn't reload the BU Cloud session and visibly flicker.
	const iframeNode = useMemo(() => {
		if (!liveUrl) return null;
		return (
			<iframe
				src={liveUrl}
				title={`Live · ${variant.name}`}
				className="block h-[400px] w-full border-0 bg-fl-white"
				sandbox="allow-scripts allow-same-origin"
			/>
		);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [liveUrl]);

	return (
		<div className="border-fl-line border bg-fl-black/95 overflow-hidden">
			<header className="bg-fl-soft border-fl-line text-fl-gray flex items-center justify-between border-b px-2 py-1.5 text-[10px] uppercase tracking-wider">
				<span className="flex min-w-0 items-center gap-1.5">
					{isRunning ? (
						<>
							<span className="bg-fl-red inline-block h-1.5 w-1.5 rounded-full animate-pulse" />
							<span className="text-fl-black">live</span>
						</>
					) : (
						<>
							<span className="bg-fl-line inline-block h-1.5 w-1.5 rounded-full" />
							<span>{variant.status}</span>
						</>
					)}
					<span className="text-fl-line">·</span>
					<span className="text-fl-black truncate normal-case tracking-normal text-xs font-semibold">
						{variant.mode ?? variant.family} · {variant.name}
					</span>
				</span>
				{liveUrl && (
					<a
						href={liveUrl}
						target="_blank"
						rel="noreferrer"
						className="text-fl-gray hover:text-fl-black shrink-0 ml-2"
						title="Open this variant's cloud browser at full window size"
					>
						↗
					</a>
				)}
			</header>
			{isRunning && iframeNode ? (
				iframeNode
			) : (
				<div className="bg-fl-soft text-fl-gray flex h-[140px] items-center justify-center text-xs">
					{variant.status === 'queued'
						? 'queued — waiting for a slot'
						: liveUrl
							? 'connecting to cloud browser…'
							: 'no live url'}
				</div>
			)}
		</div>
	);
}

function FinishedChip({ variant }: { variant: LiveVariant }) {
	const tone =
		variant.status === 'passed'
			? 'border-fl-green text-fl-green bg-fl-green/5'
			: 'border-fl-red text-fl-red bg-fl-red/5';
	const glyph = variant.status === 'passed' ? '✓' : '✗';
	return (
		<div className={`border ${tone} px-2 py-1.5 text-xs`}>
			<div className="font-mono uppercase tracking-wider text-[10px]">
				{variant.mode ?? variant.family} {glyph} {variant.status}
			</div>
			<div className="text-fl-black mt-0.5 text-[11px] truncate">{variant.name}</div>
		</div>
	);
}
