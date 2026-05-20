import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from './cn';

const iconBtn = cva(
	[
		'inline-flex items-center justify-center',
		'transition-[background,color,box-shadow] duration-200 ease-out',
		'disabled:cursor-not-allowed disabled:opacity-50',
	],
	{
		variants: {
			variant: {
				ghost: 'text-fl-gray hover:text-fl-black hover:bg-fl-soft',
				outline:
					'border border-fl-line text-fl-black hover:border-fl-black/40 hover:bg-fl-soft',
				dark: 'bg-fl-black text-fl-white hover:bg-[#1c1c1c]',
			},
			size: {
				sm: 'h-6 w-6',
				md: 'h-8 w-8',
				lg: 'h-10 w-10',
			},
		},
		defaultVariants: {
			variant: 'ghost',
			size: 'md',
		},
	},
);

export interface IconButtonProps
	extends ButtonHTMLAttributes<HTMLButtonElement>,
		VariantProps<typeof iconBtn> {
	label: string;
	icon: ReactNode;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
	{ className, variant, size, label, icon, ...rest },
	ref,
) {
	return (
		<button
			ref={ref}
			aria-label={label}
			title={label}
			className={cn(iconBtn({ variant, size }), className)}
			{...rest}
		>
			{icon}
		</button>
	);
});
