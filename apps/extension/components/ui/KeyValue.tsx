import { type ReactNode } from 'react';
import { cn } from './cn';

interface Props {
	label: ReactNode;
	value: ReactNode;
	mono?: boolean;
	className?: string;
	hint?: ReactNode;
}

export function KeyValue({ label, value, mono = true, className, hint }: Props) {
	return (
		<div
			className={cn(
				'border-fl-light flex items-baseline justify-between gap-3 border-b py-1.5 last:border-b-0',
				className,
			)}
		>
			<dt className="text-fl-gray shrink-0 text-[10px] uppercase tracking-wider">{label}</dt>
			<dd
				className={cn(
					'text-fl-black min-w-0 flex-1 break-words text-right text-[11px]',
					mono && 'font-mono',
				)}
			>
				{value}
				{hint && <div className="text-fl-gray mt-0.5 text-[10px]">{hint}</div>}
			</dd>
		</div>
	);
}

export function KeyValueList({ children, className }: { children: ReactNode; className?: string }) {
	return <dl className={cn('block', className)}>{children}</dl>;
}
