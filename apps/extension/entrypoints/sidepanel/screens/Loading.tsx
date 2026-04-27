import { motion } from 'framer-motion';
import { Wordmark } from '../../../components/ui';

export function Loading() {
	return (
		<motion.div
			initial={{ opacity: 0 }}
			animate={{ opacity: 1 }}
			exit={{ opacity: 0 }}
			transition={{ duration: 0.18 }}
			className="flex min-h-screen flex-col items-center justify-center gap-2"
		>
			<Wordmark />
			<p className="text-fl-gray text-[10px] uppercase tracking-wider">connecting…</p>
		</motion.div>
	);
}
