import { motion } from 'framer-motion';
import { ArrowLeft, RefreshCcw, XCircle } from 'lucide-react';
import { useAppState } from '../../../lib/state';
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

export function FailedScreen() {
	const mode = useAppState((s) => s.mode);
	const setMode = useAppState((s) => s.setMode);
	if (mode.kind !== 'failed') return null;
	const userEmail = mode.userEmail;

	const back = () => setMode({ kind: 'idle', userEmail });

	return (
		<PageShell
			motionKey="failed"
			header={
				<PanelHeader>
					<div className="flex min-w-0 items-center gap-2">
						<IconButton
							size="sm"
							label="Back"
							icon={<ArrowLeft size={13} aria-hidden="true" />}
							onClick={back}
						/>
						<Wordmark />
					</div>
					<Pill size="xs" variant="danger" dot>
						compile failed
					</Pill>
				</PanelHeader>
			}
		>
			<section className="px-4 py-5 text-center">
				<motion.span
					initial={{ scale: 0.85, opacity: 0 }}
					animate={{ scale: 1, opacity: 1 }}
					transition={{ duration: 0.28, ease: [0.34, 1.36, 0.64, 1] }}
					className="border-fl-red bg-fl-red-bg text-fl-red inline-flex h-9 w-9 items-center justify-center border"
				>
					<XCircle size={18} aria-hidden="true" />
				</motion.span>
				<h1 className="font-serif text-fl-black mt-2 text-[20px] leading-tight tracking-tight">
					We had trouble understanding the recording
				</h1>
				<p className="text-fl-gray mt-1 text-[11px]">
					This is usually a transient model issue — try again or save the raw recording.
				</p>
			</section>

			<section className="px-3.5 py-2">
				<Card tone="danger" padding="md" title="error detail">
					<p className="text-fl-black break-words text-[11px] leading-relaxed">{mode.reason}</p>
				</Card>
			</section>

			<div className="flex-1" />

			<PanelFooter>
				<div className="flex gap-2">
					<Button
						className="flex-1"
						variant="secondary"
						leftIcon={<RefreshCcw size={11} aria-hidden="true" />}
						onClick={back}
					>
						try again
					</Button>
					<Button className="flex-1" variant="dark" onClick={back}>
						back to flows
					</Button>
				</div>
			</PanelFooter>
		</PageShell>
	);
}
