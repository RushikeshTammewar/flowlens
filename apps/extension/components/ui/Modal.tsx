import { useEffect, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { X } from 'lucide-react';
import { IconButton } from './IconButton';
import { cn } from './cn';

interface Props {
	open: boolean;
	onClose: () => void;
	title?: ReactNode;
	subtitle?: ReactNode;
	children: ReactNode;
	footer?: ReactNode;
	dismissOnEscape?: boolean;
	className?: string;
}

/**
 * Lightweight modal anchored inside the side panel. Not a system dialog —
 * just a translucent scrim + framed sheet.
 */
export function Modal({
	open,
	onClose,
	title,
	subtitle,
	children,
	footer,
	dismissOnEscape = true,
	className,
}: Props) {
	useEffect(() => {
		if (!open || !dismissOnEscape) return;
		const onKey = (e: KeyboardEvent) => {
			if (e.key === 'Escape') onClose();
		};
		window.addEventListener('keydown', onKey);
		return () => window.removeEventListener('keydown', onKey);
	}, [open, dismissOnEscape, onClose]);

	return (
		<AnimatePresence>
			{open && (
				<motion.div
					key="scrim"
					initial={{ opacity: 0 }}
					animate={{ opacity: 1 }}
					exit={{ opacity: 0 }}
					transition={{ duration: 0.18 }}
					role="dialog"
					aria-modal="true"
					className="fixed inset-0 z-40 flex items-end justify-center bg-fl-black/40 sm:items-center"
					onClick={onClose}
				>
					<motion.div
						initial={{ y: 20, opacity: 0 }}
						animate={{ y: 0, opacity: 1 }}
						exit={{ y: 20, opacity: 0 }}
						transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
						onClick={(e) => e.stopPropagation()}
						className={cn(
							'bg-fl-white border-fl-line m-2 w-[calc(100%-16px)] max-w-[420px] border shadow-[0_2px_6px_rgba(15,15,15,0.08),0_12px_32px_rgba(15,15,15,0.18)]',
							className,
						)}
					>
						{(title || subtitle) && (
							<header className="border-fl-light flex items-start justify-between gap-2 border-b px-3 py-2.5">
								<div className="min-w-0">
									{title && (
										<div className="text-fl-black truncate font-mono text-[12px] font-semibold tracking-tight">
											{title}
										</div>
									)}
									{subtitle && (
										<div className="text-fl-gray mt-0.5 text-[11px]">{subtitle}</div>
									)}
								</div>
								<IconButton
									label="Close"
									icon={<X size={14} aria-hidden="true" />}
									size="sm"
									onClick={onClose}
								/>
							</header>
						)}
						<div className="px-3 py-3">{children}</div>
						{footer && (
							<footer className="border-fl-light flex items-center justify-end gap-2 border-t px-3 py-2">
								{footer}
							</footer>
						)}
					</motion.div>
				</motion.div>
			)}
		</AnimatePresence>
	);
}
