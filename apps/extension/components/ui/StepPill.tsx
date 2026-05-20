import { type ReactNode } from 'react';
import {
	Check,
	X,
	CircleDashed,
	CircleDot,
	AlertTriangle,
	HelpCircle,
	SkipForward,
	Activity,
} from 'lucide-react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from './cn';

export type StepStatus =
	| 'pending'
	| 'running'
	| 'passed'
	| 'failed'
	| 'flaky'
	| 'blocked'
	| 'inconclusive'
	| 'skipped';

const pill = cva(
	[
		'inline-flex items-center gap-1.5 border px-1.5 h-5',
		'font-mono text-[10px] tracking-tight',
	],
	{
		variants: {
			status: {
				pending: 'border-fl-line text-fl-gray bg-fl-white',
				running: 'border-fl-amber/40 text-fl-amber bg-fl-amber-bg',
				passed: 'border-fl-green/40 text-fl-green bg-fl-green-bg',
				failed: 'border-fl-red/40 text-fl-red bg-fl-red-bg',
				flaky: 'border-fl-amber/40 text-fl-amber bg-fl-amber-bg',
				blocked: 'border-fl-amber/40 text-fl-amber bg-fl-amber-bg',
				inconclusive: 'border-fl-line text-fl-gray bg-fl-soft',
				skipped: 'border-fl-line text-fl-gray bg-fl-white',
			},
		},
		defaultVariants: {
			status: 'pending',
		},
	},
);

const iconFor: Record<StepStatus, ReactNode> = {
	pending: <CircleDashed size={10} aria-hidden="true" />,
	running: <Activity size={10} aria-hidden="true" />,
	passed: <Check size={10} aria-hidden="true" />,
	failed: <X size={10} aria-hidden="true" />,
	flaky: <AlertTriangle size={10} aria-hidden="true" />,
	blocked: <AlertTriangle size={10} aria-hidden="true" />,
	inconclusive: <HelpCircle size={10} aria-hidden="true" />,
	skipped: <SkipForward size={10} aria-hidden="true" />,
};

const labelFor: Record<StepStatus, string> = {
	pending: 'pending',
	running: 'running',
	passed: 'passed',
	failed: 'failed',
	flaky: 'flaky',
	blocked: 'blocked',
	inconclusive: 'inconclusive',
	skipped: 'skipped',
};

export interface StepPillProps extends VariantProps<typeof pill> {
	status: StepStatus;
	index?: number;
	reason?: string;
	className?: string;
	compact?: boolean;
}

export function StepPill({ status, index, reason, className, compact }: StepPillProps) {
	const title = reason ? `${labelFor[status]} — ${reason}` : labelFor[status];
	return (
		<span className={cn(pill({ status }), className)} title={title}>
			<span className={status === 'running' ? 'fl-stage-pulse' : ''}>{iconFor[status]}</span>
			{!compact && (
				<>
					{typeof index === 'number' && <span className="tabular-nums">{index + 1}</span>}
					<span className="uppercase">{labelFor[status]}</span>
				</>
			)}
		</span>
	);
}

/**
 * A tiny status indicator (just dot+icon) used in dense step strips.
 */
export function StepDot({ status, index }: { status: StepStatus; index?: number }) {
	const colorMap: Record<StepStatus, string> = {
		pending: 'bg-fl-line text-fl-gray',
		running:
			'bg-fl-amber-bg border border-fl-amber/40 text-fl-amber shadow-[0_0_0_3px_rgba(180,83,9,0.18)]',
		passed: 'bg-fl-green text-fl-white',
		failed: 'bg-fl-red text-fl-white',
		flaky: 'bg-fl-amber text-fl-white',
		blocked: 'bg-fl-amber-bg border border-fl-amber/40 text-fl-amber',
		inconclusive: 'bg-fl-soft border border-fl-line text-fl-gray',
		skipped: 'bg-fl-white border border-fl-line text-fl-gray',
	};
	return (
		<span
			className={cn(
				'inline-flex h-5 min-w-5 items-center justify-center px-1 font-mono text-[9px] tabular-nums',
				colorMap[status],
				status === 'running' && 'fl-stage-pulse',
			)}
			title={labelFor[status]}
		>
			{typeof index === 'number' ? index + 1 : iconFor[status]}
		</span>
	);
}
