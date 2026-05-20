import { Check } from 'lucide-react';
import { motion } from 'framer-motion';
import { cn } from './cn';

interface DeterminateProps {
	value: number;
	className?: string;
	tone?: 'default' | 'success' | 'danger' | 'amber';
}

const toneClasses = {
	default: 'bg-fl-cta',
	success: 'bg-fl-green',
	danger: 'bg-fl-red',
	amber: 'bg-fl-amber',
};

export function ProgressBar({ value, className, tone = 'default' }: DeterminateProps) {
	const pct = Math.max(0, Math.min(100, value));
	return (
		<div
			role="progressbar"
			aria-valuemin={0}
			aria-valuemax={100}
			aria-valuenow={Math.round(pct)}
			className={cn('bg-fl-light relative h-1 w-full overflow-hidden', className)}
		>
			<motion.div
				className={cn('h-full', toneClasses[tone])}
				initial={false}
				animate={{ width: `${pct}%` }}
				transition={{ duration: 0.32, ease: [0.22, 1, 0.36, 1] }}
			/>
		</div>
	);
}

export interface ProgressStage {
	id: string;
	label: string;
	state: 'pending' | 'active' | 'done';
	detail?: string;
}

interface SegmentedProps {
	stages: ReadonlyArray<ProgressStage>;
	className?: string;
}

export function ProgressStages({ stages, className }: SegmentedProps) {
	return (
		<ol className={cn('space-y-2', className)}>
			{stages.map((s) => (
				<li key={s.id} className="flex items-start gap-2 text-[11px]">
					<StageDot state={s.state} />
					<div className="min-w-0 flex-1">
						<div
							className={cn(
								'flex items-baseline justify-between gap-2 font-mono tracking-tight',
								s.state === 'pending' && 'text-fl-gray',
								s.state === 'active' && 'text-fl-black',
								s.state === 'done' && 'text-fl-gray line-through decoration-fl-gray/40',
							)}
						>
							<span className="truncate">{s.label}</span>
							{s.state === 'active' && s.detail && (
								<span className="text-fl-amber shrink-0 text-[10px]">{s.detail}</span>
							)}
							{s.state === 'done' && (
								<Check size={12} className="text-fl-green shrink-0" aria-hidden="true" />
							)}
						</div>
					</div>
				</li>
			))}
		</ol>
	);
}

function StageDot({ state }: { state: ProgressStage['state'] }) {
	if (state === 'done') {
		return (
			<span className="bg-fl-green mt-1 inline-flex h-2 w-2 shrink-0 items-center justify-center rounded-full" />
		);
	}
	if (state === 'active') {
		return (
			<span className="relative mt-1 inline-flex h-2 w-2 shrink-0 items-center justify-center">
				<span className="bg-fl-amber/40 absolute inline-flex h-full w-full animate-ping rounded-full" />
				<span className="bg-fl-amber relative inline-flex h-2 w-2 rounded-full" />
			</span>
		);
	}
	return <span className="bg-fl-line mt-1 inline-block h-2 w-2 shrink-0 rounded-full" />;
}
