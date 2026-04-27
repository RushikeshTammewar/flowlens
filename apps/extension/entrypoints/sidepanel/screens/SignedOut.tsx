import { useState } from 'react';
import { motion } from 'framer-motion';
import { ArrowUpRight, Lock, KeyRound } from 'lucide-react';
import { useAppState } from '../../../lib/state';
import { APP_CONFIG } from '../../../app.config';
import {
	Button,
	Card,
	PageShell,
	PanelHeader,
	Pill,
	Wordmark,
	useToast,
} from '../../../components/ui';

export function SignedOut() {
	const setMode = useAppState((s) => s.setMode);
	const toast = useToast();
	const [pasted, setPasted] = useState('');
	const [busy, setBusy] = useState(false);
	const [err, setErr] = useState('');

	const openSignIn = () => {
		void chrome.tabs.create({ url: `${APP_CONFIG.flowlensWebUrl}/extension-callback` });
	};

	const submitPasted = async () => {
		if (!pasted.trim()) return;
		setBusy(true);
		setErr('');
		try {
			const probe = await fetch(`${APP_CONFIG.apiUrl}/api/health`, {
				headers: { Authorization: `Bearer ${pasted.trim()}` },
			});
			if (!probe.ok) throw new Error(`API health probe failed: ${probe.status}`);
			await chrome.storage.local.set({
				flowlens_auth_token: pasted.trim(),
				flowlens_user_email: 'Signed in',
			});
			toast.push({ tone: 'success', title: 'Signed in' });
			setMode({ kind: 'idle', userEmail: 'Signed in' });
		} catch (e) {
			const msg = (e as Error).message;
			setErr(msg);
			toast.push({ tone: 'error', title: 'Sign-in failed', body: msg });
		} finally {
			setBusy(false);
		}
	};

	return (
		<PageShell
			motionKey="signed_out"
			header={
				<PanelHeader>
					<Wordmark version="3" />
					<Pill size="xs" variant="default">
						sign in
					</Pill>
				</PanelHeader>
			}
		>
			<section className="flex-1 px-4 py-5">
				<motion.div
					initial={{ opacity: 0, y: 6 }}
					animate={{ opacity: 1, y: 0 }}
					transition={{ delay: 0.05, duration: 0.28 }}
				>
					<h1 className="font-serif text-fl-black text-[26px] leading-tight tracking-tight">
						Record a flow once.
					</h1>
					<h2 className="font-serif text-fl-cta text-[26px] leading-tight tracking-tight">
						We test it forever.
					</h2>
					<p className="text-fl-gray mt-3 max-w-[42ch] text-[11px]">
						Demonstrate a flow on any site. We narrate every step, save the cookies (encrypted),
						and re-run it on a schedule.
					</p>
				</motion.div>

				<div className="mt-6 space-y-2">
					<Button block size="lg" onClick={openSignIn} rightIcon={<ArrowUpRight size={13} />}>
						Sign in via flowlens.in
					</Button>
				</div>

				<Card
					className="mt-6"
					tone="neutral"
					padding="md"
					title={
						<span className="flex items-center gap-1.5">
							<KeyRound size={11} className="text-fl-gray" /> Paste extension token
						</span>
					}
					subtitle="After signing in on the web, copy the token shown on the callback page."
				>
					<textarea
						value={pasted}
						onChange={(e) => setPasted(e.target.value)}
						placeholder="paste extension token…"
						aria-label="Extension token"
						className="border-fl-line bg-fl-white text-fl-black placeholder:text-fl-gray mt-1 block w-full resize-none border p-2 font-mono text-[10px] focus:outline-none"
						rows={3}
					/>
					<Button
						className="mt-2"
						block
						variant="primary"
						size="md"
						loading={busy}
						disabled={!pasted.trim()}
						onClick={submitPasted}
					>
						Use this token
					</Button>
					{err && <p className="text-fl-red mt-2 break-words text-[10px]">{err}</p>}
				</Card>

				<div className="border-fl-light mt-5 border-t pt-3">
					<p className="text-fl-gray flex items-start gap-1.5 text-[10px]">
						<Lock size={11} className="mt-px shrink-0" aria-hidden="true" />
						<span>
							Cookies are encrypted in the browser before they leave it. We only access sites you
							record on.
						</span>
					</p>
				</div>
			</section>
		</PageShell>
	);
}
