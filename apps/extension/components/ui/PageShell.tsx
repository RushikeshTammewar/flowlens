import { type ReactNode } from 'react';
import { motion } from 'framer-motion';
import { cn } from './cn';

interface Props {
	children: ReactNode;
	header?: ReactNode;
	footer?: ReactNode;
	className?: string;
	/** Animation key — lets AnimatePresence run a slide-in when the screen changes. */
	motionKey?: string;
}

/**
 * Standard side-panel page frame used by every screen.
 * Header is sticky at top; footer (if present) is sticky at bottom.
 */
export function PageShell({ children, header, footer, className, motionKey }: Props) {
	return (
		<motion.div
			key={motionKey}
			initial={{ opacity: 0, y: 4 }}
			animate={{ opacity: 1, y: 0 }}
			exit={{ opacity: 0, y: -4 }}
			transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
			className={cn('flex min-h-screen flex-col', className)}
		>
			{header}
			<div className="flex flex-1 flex-col">{children}</div>
			{footer}
		</motion.div>
	);
}

export function PanelHeader({
	children,
	className,
}: {
	children: ReactNode;
	className?: string;
}) {
	return (
		<header
			className={cn(
				'sticky top-0 z-10',
				'border-fl-light bg-fl-white/90 supports-[backdrop-filter]:bg-fl-white/70 border-b backdrop-blur',
				'flex items-center justify-between px-3.5 py-2',
				className,
			)}
		>
			{children}
		</header>
	);
}

export function PanelFooter({
	children,
	className,
}: {
	children: ReactNode;
	className?: string;
}) {
	return (
		<footer
			className={cn(
				'border-fl-light bg-fl-white/95 sticky bottom-0 z-10 border-t px-3.5 py-2.5 backdrop-blur',
				className,
			)}
		>
			{children}
		</footer>
	);
}
