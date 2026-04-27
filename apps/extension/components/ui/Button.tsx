import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { Loader2 } from 'lucide-react';
import { cn } from './cn';

const button = cva(
	[
		'relative inline-flex items-center justify-center gap-2',
		'font-mono uppercase tracking-wider',
		'transition-[background,color,box-shadow,transform] duration-200 ease-out',
		'select-none',
		'disabled:cursor-not-allowed disabled:opacity-60',
	],
	{
		variants: {
			variant: {
				primary: [
					'bg-fl-cta text-fl-white',
					'shadow-[0_1px_0_rgba(15,15,15,0.06)]',
					'bg-gradient-to-b from-[#1f6e37] to-[#174f27]',
					'hover:from-[#226f38] hover:to-[#185028]',
					'active:translate-y-px',
					'disabled:from-fl-light disabled:to-fl-light disabled:text-fl-gray',
				],
				secondary: [
					'bg-fl-white text-fl-black',
					'border border-fl-line',
					'hover:bg-fl-soft hover:border-fl-black/40',
					'active:translate-y-px',
				],
				ghost: [
					'bg-transparent text-fl-gray',
					'hover:bg-fl-soft hover:text-fl-black',
				],
				danger: [
					'bg-fl-red text-fl-white',
					'hover:bg-[#c1272a]',
					'active:translate-y-px',
				],
				dark: [
					'bg-fl-black text-fl-white',
					'hover:bg-[#1c1c1c]',
					'active:translate-y-px',
				],
			},
			size: {
				sm: 'h-7 px-2.5 text-[10px]',
				md: 'h-9 px-3 text-[11px]',
				lg: 'h-11 px-4 text-xs',
			},
			block: {
				true: 'w-full',
				false: '',
			},
		},
		defaultVariants: {
			variant: 'primary',
			size: 'md',
			block: false,
		},
	},
);

export interface ButtonProps
	extends ButtonHTMLAttributes<HTMLButtonElement>,
		VariantProps<typeof button> {
	loading?: boolean;
	leftIcon?: ReactNode;
	rightIcon?: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
	{ className, variant, size, block, loading, disabled, leftIcon, rightIcon, children, ...rest },
	ref,
) {
	return (
		<button
			ref={ref}
			disabled={disabled || loading}
			className={cn(button({ variant, size, block }), className)}
			{...rest}
		>
			{loading ? (
				<Loader2 size={size === 'sm' ? 11 : 13} className="animate-spin" aria-hidden="true" />
			) : (
				leftIcon
			)}
			<span className="truncate">{children}</span>
			{!loading && rightIcon}
		</button>
	);
});
