import { useEffect, useState } from 'react';
import { Sparkles } from 'lucide-react';
import { Button, Modal } from '../../../components/ui';

interface Suggestion {
	id: string;
	title: string;
	description: string;
	costEstimate: string;
}

const DEFAULT_SUGGESTIONS: ReadonlyArray<Suggestion> = [
	{
		id: 'duplicate',
		title: 'Sign up with already-used email',
		description: 'Tests the duplicate-account error path.',
		costEstimate: '~$0.30',
	},
	{
		id: 'login-after',
		title: 'Sign up, then sign out, then sign in',
		description: 'Tests login after signup.',
		costEstimate: '~$0.30',
	},
	{
		id: 'weak-password',
		title: 'Sign up with weak password',
		description: 'Tests password-strength validation.',
		costEstimate: '~$0.30',
	},
];

interface Props {
	open: boolean;
	onClose: () => void;
	onConfirm: (ids: string[]) => void;
	onSkip: () => void;
	suggestions?: ReadonlyArray<Suggestion>;
}

export function SiblingsModal({
	open,
	onClose,
	onConfirm,
	onSkip,
	suggestions = DEFAULT_SUGGESTIONS,
}: Props) {
	const [selected, setSelected] = useState<Set<string>>(() => new Set(['duplicate', 'login-after']));

	useEffect(() => {
		if (open) setSelected(new Set(['duplicate', 'login-after']));
	}, [open]);

	useEffect(() => {
		if (!open) return;
		const onKey = (e: KeyboardEvent) => {
			if (e.key === 'Enter' && selected.size > 0) onConfirm(Array.from(selected));
		};
		window.addEventListener('keydown', onKey);
		return () => window.removeEventListener('keydown', onKey);
	}, [open, selected, onConfirm]);

	const toggle = (id: string) =>
		setSelected((prev) => {
			const next = new Set(prev);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});

	return (
		<Modal
			open={open}
			onClose={onClose}
			title={
				<span className="flex items-center gap-1.5">
					<Sparkles size={12} className="text-fl-cta" aria-hidden="true" /> flow saved
				</span>
			}
			subtitle="Want us to also test these variants? AI-only — no recording needed."
			footer={
				<>
					<Button variant="ghost" onClick={onSkip}>
						skip
					</Button>
					<Button
						variant="primary"
						disabled={selected.size === 0}
						onClick={() => onConfirm(Array.from(selected))}
					>
						run selected ({selected.size})
					</Button>
				</>
			}
		>
			<ul className="space-y-1.5">
				{suggestions.map((s) => {
					const isOn = selected.has(s.id);
					return (
						<li key={s.id}>
							<button
								onClick={() => toggle(s.id)}
								className={`group block w-full border px-2.5 py-2 text-left transition-colors duration-150 ${
									isOn
										? 'bg-fl-cta/5 border-fl-cta/40'
										: 'border-fl-line hover:border-fl-black/30 hover:bg-fl-soft'
								}`}
							>
								<div className="flex items-start gap-2">
									<span
										className={`mt-0.5 inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center border ${
											isOn ? 'border-fl-cta bg-fl-cta text-fl-white' : 'border-fl-line bg-fl-white'
										}`}
										aria-hidden="true"
									>
										{isOn && (
											<svg
												width="9"
												height="9"
												viewBox="0 0 12 12"
												fill="none"
												xmlns="http://www.w3.org/2000/svg"
											>
												<path
													d="M2.5 6.5l2.5 2.5 4.5-5"
													stroke="currentColor"
													strokeWidth="1.6"
													strokeLinecap="round"
													strokeLinejoin="round"
												/>
											</svg>
										)}
									</span>
									<div className="min-w-0 flex-1">
										<div className="text-fl-black text-[11px] font-semibold">{s.title}</div>
										<div className="text-fl-gray mt-0.5 text-[10px]">{s.description}</div>
									</div>
									<span className="text-fl-gray font-mono text-[10px] shrink-0">{s.costEstimate}</span>
								</div>
							</button>
						</li>
					);
				})}
			</ul>
			<p className="text-fl-gray mt-2 text-[10px]">
				Each variant runs once on the cloud browser. You can re-run them later from the web dashboard.
			</p>
		</Modal>
	);
}
