import { forwardRef, type HTMLAttributes, type ReactNode } from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from './cn';

const card = cva(
	[
		'block bg-fl-white border border-fl-light',
		'transition-[border-color,box-shadow,transform] duration-200 ease-out',
	],
	{
		variants: {
			tone: {
				neutral: '',
				success: 'border-fl-green/30 bg-fl-green-bg',
				warn: 'border-fl-amber/30 bg-fl-amber-bg',
				danger: 'border-fl-red/30 bg-fl-red-bg',
				info: 'border-fl-blue/30 bg-fl-blue-bg',
			},
			padding: {
				none: 'p-0',
				sm: 'p-2.5',
				md: 'p-3',
				lg: 'p-4',
			},
			interactive: {
				true: 'hover:border-fl-black/30 hover:shadow-[0_1px_2px_rgba(15,15,15,0.06),0_4px_12px_rgba(15,15,15,0.04)] cursor-pointer',
				false: '',
			},
		},
		defaultVariants: {
			tone: 'neutral',
			padding: 'md',
			interactive: false,
		},
	},
);

export interface CardProps
	extends Omit<HTMLAttributes<HTMLElement>, 'title'>,
		VariantProps<typeof card> {
	title?: ReactNode;
	subtitle?: ReactNode;
	headerRight?: ReactNode;
	as?: 'section' | 'article' | 'div';
}

export const Card = forwardRef<HTMLElement, CardProps>(function Card(
	{ as = 'section', className, tone, padding, interactive, title, subtitle, headerRight, children, ...rest },
	ref,
) {
	const Tag = as as 'section';
	return (
		<Tag
			ref={ref as unknown as React.Ref<HTMLElement>}
			className={cn(card({ tone, padding, interactive }), className)}
			{...rest}
		>
			{(title || subtitle || headerRight) && (
				<header className="mb-2 flex items-start justify-between gap-2">
					<div className="min-w-0">
						{title && (
							<div className="text-fl-black truncate text-[12px] font-semibold tracking-tight">
								{title}
							</div>
						)}
						{subtitle && <div className="text-fl-gray text-[11px]">{subtitle}</div>}
					</div>
					{headerRight && <div className="shrink-0">{headerRight}</div>}
				</header>
			)}
			{children}
		</Tag>
	);
});
