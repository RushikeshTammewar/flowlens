import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { Lock, ShieldCheck, Square } from 'lucide-react';
import { useAppState } from '../../../lib/state';
import {
	Button,
	Card,
	KeyValue,
	KeyValueList,
	PageShell,
	PanelFooter,
	PanelHeader,
	Pill,
	RecordIndicator,
	Wordmark,
	useToast,
} from '../../../components/ui';

export function Recording() {
	const mode = useAppState((s) => s.mode);
	const setMode = useAppState((s) => s.setMode);
	const toast = useToast();
	const [busy, setBusy] = useState(false);
	const [err, setErr] = useState('');
	const [elapsedSec, setElapsedSec] = useState(0);
	const [sensitive, setSensitive] = useState(false);

	const startedAt = useState(() => Date.now())[0];

	useEffect(() => {
		const id = setInterval(() => setElapsedSec(Math.floor((Date.now() - startedAt) / 1000)), 1000);
		return () => clearInterval(id);
	}, [startedAt]);

	if (mode.kind !== 'recording') return null;

	const stop = async () => {
		setBusy(true);
		setErr('');
		try {
			const res = (await chrome.runtime.sendMessage({ type: 'stop_recording' })) as {
				ok: boolean;
				flowId?: string;
				reason?: string;
			};
			if (!res?.ok || !res.flowId) {
				throw new Error(res?.reason ?? 'stop failed');
			}
			toast.push({ tone: 'info', title: 'Recording stopped', body: 'compiling now…' });
			setMode({
				kind: 'compiling',
				userEmail: mode.userEmail,
				flowId: res.flowId,
				pct: 0,
				stage: 'queued',
			});
		} catch (e) {
			const msg = (e as Error).message;
			setErr(msg);
			toast.push({ tone: 'error', title: 'Stop failed', body: msg });
		} finally {
			setBusy(false);
		}
	};

	const minutes = Math.floor(elapsedSec / 60);
	const seconds = elapsedSec % 60;

	return (
		<PageShell
			motionKey="recording"
			header={
				<PanelHeader>
					<div className="flex min-w-0 items-center gap-2">
						<Wordmark />
						<Pill size="xs" variant="danger" dot>
							rec
						</Pill>
					</div>
					<span className="text-fl-gray font-mono text-[10px] tabular-nums">
						{String(minutes).padStart(2, '0')}:{String(seconds).padStart(2, '0')}
					</span>
				</PanelHeader>
			}
		>
			<section className="px-4 py-5 text-center">
				<motion.div
					initial={{ scale: 0.85, opacity: 0 }}
					animate={{ scale: 1, opacity: 1 }}
					transition={{ duration: 0.3, ease: [0.34, 1.36, 0.64, 1] }}
					className="mx-auto"
				>
					<RecordIndicator size={28} className="mx-auto" />
				</motion.div>
				<h1 className="font-serif text-fl-black mt-3 text-[22px] leading-tight tracking-tight">
					Recording in progress
				</h1>
				<p className="text-fl-gray mt-1 text-[11px]">{hostFromOrigin(mode.siteOrigin)}</p>
			</section>

			<section className="px-3.5">
				<Card padding="md">
					<KeyValueList>
						<KeyValue
							label="actions"
							value={
								<motion.span
									key={mode.actionsCaptured}
									initial={{ y: -6, opacity: 0 }}
									animate={{ y: 0, opacity: 1 }}
									transition={{ duration: 0.18 }}
									className="text-fl-black inline-block text-[14px] tabular-nums"
								>
									{mode.actionsCaptured}
								</motion.span>
							}
						/>
						<KeyValue
							label="elapsed"
							value={`${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`}
						/>
						<KeyValue label="site" value={hostFromOrigin(mode.siteOrigin)} />
					</KeyValueList>
				</Card>
			</section>

			<section className="px-3.5 pt-3">
				<Card
					padding="md"
					tone="neutral"
					title={
						<span className="flex items-center gap-1.5">
							<span className="bg-fl-red inline-block h-1.5 w-1.5 rounded-full fl-stage-pulse" />
							latest action
						</span>
					}
				>
					<div className="bg-fl-soft border-fl-line aspect-[4/3] w-full border" aria-hidden="true">
						<div className="flex h-full w-full items-center justify-center text-[10px] text-fl-gray">
							waiting for next action…
						</div>
					</div>
					<p className="text-fl-gray mt-2 text-[10px]">
						We capture clicks, typing, and navigation. Sensitive fields are encrypted before they leave
						your browser.
					</p>
				</Card>
			</section>

			<section className="px-3.5 pt-3">
				<button
					onClick={() => setSensitive((v) => !v)}
					className="text-fl-gray hover:text-fl-black w-full text-left text-[10px]"
				>
					[ tap to {sensitive ? 'hide' : 'simulate'} sensitive-data warning ]
				</button>
				{sensitive && (
					<motion.div
						initial={{ opacity: 0, y: -4, height: 0 }}
						animate={{ opacity: 1, y: 0, height: 'auto' }}
						exit={{ opacity: 0, y: -4, height: 0 }}
						className="mt-2 overflow-hidden"
					>
						<div className="border-fl-amber/40 bg-fl-amber-bg flex items-start gap-2 border px-2.5 py-2 text-[10px]">
							<Lock size={12} className="text-fl-amber mt-px shrink-0" aria-hidden="true" />
							<div>
								<div className="text-fl-black font-semibold">password-like value detected</div>
								<div className="text-fl-gray">
									it&apos;s been encrypted and won&apos;t be shown.
								</div>
							</div>
						</div>
					</motion.div>
				)}
				<p className="text-fl-gray mt-3 flex items-start gap-1.5 text-[10px]">
					<ShieldCheck size={11} className="mt-px shrink-0 text-fl-green" aria-hidden="true" />
					<span>
						Tip — you can close this panel any time; recording continues in the background.
					</span>
				</p>
			</section>

			<div className="flex-1" />

			<PanelFooter>
				<Button
					block
					size="lg"
					variant="dark"
					onClick={stop}
					loading={busy}
					leftIcon={!busy ? <Square size={12} aria-hidden="true" /> : undefined}
				>
					stop recording
				</Button>
				{err && <p className="text-fl-red mt-2 text-[10px]">{err}</p>}
			</PanelFooter>
		</PageShell>
	);
}

function hostFromOrigin(origin: string): string {
	try {
		return new URL(origin).host;
	} catch {
		return origin;
	}
}
