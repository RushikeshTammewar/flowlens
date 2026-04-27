import { type HTMLAttributes, type ReactNode } from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from './cn';

const pill = cva(
	[
		'inline-flex items-center gap-1.5',
		'border px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider',
		'whitespace-nowrap',
	],
	{
		variants: {
			variant: {
				default: 'border-fl-line text-fl-gray bg-fl-white',
				success: 'border-fl-green/40 text-fl-green bg-fl-green-bg',
				warn: 'border-fl-amber/40 text-fl-amber bg-fl-amber-bg',
				danger: 'border-fl-red/40 text-fl-red bg-fl-red-bg',
				info: 'border-fl-blue/40 text-fl-blue bg-fl-blue-bg',
				running: 'border-fl-amber/40 text-fl-amber bg-fl-amber-bg',
				solid: 'border-fl-black bg-fl-black text-fl-white',
			},
			size: {
				xs: 'h-4 px-1 text-[9px]',
				sm: 'h-5 px-1.5 text-[10px]',
				md: 'h-6 px-2 text-[11px]',
			},
		},
		defaultVariants: {
			variant: 'default',
			size: 'sm',
		},
	},
);

const dotColor: Record<NonNullable<VariantProps<typeof pill>['variant']>, string> = {
	default: 'bg-fl-gray',
	success: 'bg-fl-green',
	warn: 'bg-fl-amber',
	danger: 'bg-fl-red',
	info: 'bg-fl-blue',
	running: 'bg-fl-amber fl-stage-pulse',
	solid: 'bg-fl-white',
};

export interface PillProps
	extends HTMLAttributes<HTMLSpanElement>,
		VariantProps<typeof pill> {
	dot?: boolean;
	icon?: ReactNode;
}

export function Pill({ className, variant, size, dot, icon, children, ...rest }: PillProps) {
	const v = variant ?? 'default';
	return (
		<span className={cn(pill({ variant, size }), className)} {...rest}>
			{dot && <span className={cn('inline-block h-1.5 w-1.5 rounded-full', dotColor[v])} />}
			{icon}
			{children}
		</span>
	);
}
