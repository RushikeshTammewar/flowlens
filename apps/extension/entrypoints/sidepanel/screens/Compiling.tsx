import { useEffect, useState } from 'react';
import { Cpu } from 'lucide-react';
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
} from '../../../components/ui';

const STAGE_ORDER: ReadonlyArray<{ id: string; label: string }> = [
	{ id: 'stitching', label: 'Stitching the recording' },
	{ id: 'narrating', label: 'Narrating each step' },
	{ id: 'synthesizing', label: 'Synthesizing the flow' },
	{ id: 'siblings', label: 'Suggesting related flows' },
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
};

export function Compiling() {
	const mode = useAppState((s) => s.mode);
	const setMode = useAppState((s) => s.setMode);
	const [pct, setPct] = useState(0);
	const [rawStage, setRawStage] = useState<string>('queued');
	const [detail, setDetail] = useState<string>('');

	useEffect(() => {
		if (mode.kind !== 'compiling') return;
		let cancelled = false;
		const tick = async () => {
			try {
				const res = await api.getCompileStatus(mode.flowId);
				if (cancelled) return;
				setPct(res.compile.pct);
				setRawStage(res.compile.stage);
				setDetail(res.compile.detail ?? '');
				if (res.flowStatus === 'ready' && res.compile.stage === 'done') {
					setMode({ kind: 'reviewing', userEmail: mode.userEmail, flowId: mode.flowId });
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
	}, [mode, setMode]);

	if (mode.kind !== 'compiling') return null;

	const activeKey = STAGE_ALIASES[rawStage.toLowerCase()] ?? STAGE_ORDER[0]?.id ?? 'stitching';
	const activeIdx = STAGE_ORDER.findIndex((s) => s.id === activeKey);
	const isDone = rawStage === 'done';
	const stages: ProgressStage[] = STAGE_ORDER.map((s, i) => {
		let state: ProgressStage['state'] = 'pending';
		if (i < activeIdx) state = 'done';
		else if (i === activeIdx) state = isDone ? 'done' : 'active';
		const stage: ProgressStage = { id: s.id, label: s.label, state };
		if (state === 'active' && i === 1 && detail) stage.detail = detail;
		return stage;
	});

	const cancel = () => setMode({ kind: 'idle', userEmail: mode.userEmail });

	return (
		<PageShell
			motionKey="compiling"
			header={
				<PanelHeader>
					<div className="flex min-w-0 items-center gap-2">
						<Wordmark />
						<Pill size="xs" variant="warn" dot>
							compiling
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
					Making sense of your recording
				</h1>
				<p className="text-fl-gray mt-1 text-[11px]">
					AI works in the open — every stage is visible.
				</p>
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

			<section className="px-3.5 py-3">
				<p className="text-fl-gray text-[10px]">
					This usually takes 5–15 seconds. We narrate each step using your screenshots and the
					DOM context.
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
