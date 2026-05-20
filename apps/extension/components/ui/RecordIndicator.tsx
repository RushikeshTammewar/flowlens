import { motion, useReducedMotion } from 'framer-motion';
import { cn } from './cn';

interface Props {
	className?: string;
	size?: number;
	label?: string;
}

/**
 * Pulsing red dot used for recording state.
 * Animation respects prefers-reduced-motion.
 */
export function RecordIndicator({ className, size = 10, label }: Props) {
	const reduce = useReducedMotion();
	return (
		<span
			role="status"
			aria-label={label ?? 'Recording'}
			className={cn('relative inline-flex shrink-0 items-center justify-center', className)}
			style={{ width: size, height: size }}
		>
			{!reduce && (
				<motion.span
					className="bg-fl-red/35 absolute inline-flex rounded-full"
					initial={{ scale: 0.6, opacity: 0.6 }}
					animate={{ scale: 1.7, opacity: 0 }}
					transition={{
						duration: 1.6,
						repeat: Infinity,
						ease: [0.22, 1, 0.36, 1],
					}}
					style={{ width: size, height: size }}
				/>
			)}
			<span
				className="bg-fl-red relative inline-flex rounded-full"
				style={{ width: size, height: size }}
			/>
		</span>
	);
}
