import { type ReactNode } from 'react';
import { cn } from './cn';

interface EmptyStateProps {
	icon: ReactNode;
	title: string;
	body?: ReactNode;
	cta?: ReactNode;
	className?: string;
}

export function EmptyState({ icon, title, body, cta, className }: EmptyStateProps) {
	return (
		<div
			className={cn(
				'flex flex-col items-center text-center',
				'border-fl-light bg-fl-white border border-dashed px-4 py-8',
				className,
			)}
		>
			<span className="text-fl-gray mb-3" aria-hidden="true">
				{icon}
			</span>
			<h3 className="text-fl-black font-mono text-[12px] font-semibold tracking-tight">{title}</h3>
			{body && <p className="text-fl-gray mt-1.5 max-w-[28ch] text-[11px]">{body}</p>}
			{cta && <div className="mt-3">{cta}</div>}
		</div>
	);
}
