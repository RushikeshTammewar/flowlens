import { motion } from 'framer-motion';
import { cn } from './cn';

export interface TabItem<T extends string = string> {
	id: T;
	label: string;
	count?: number;
}

interface TabsProps<T extends string = string> {
	items: ReadonlyArray<TabItem<T>>;
	value: T;
	onChange: (id: T) => void;
	className?: string;
}

export function Tabs<T extends string = string>({ items, value, onChange, className }: TabsProps<T>) {
	return (
		<div role="tablist" className={cn('relative flex items-center gap-1 text-[11px]', className)}>
			{items.map((item) => {
				const active = item.id === value;
				return (
					<button
						key={item.id}
						role="tab"
						aria-selected={active}
						onClick={() => onChange(item.id)}
						className={cn(
							'relative inline-flex h-7 items-center gap-1.5 px-2 font-mono uppercase tracking-wider transition-colors duration-150 ease-out',
							active ? 'text-fl-black' : 'text-fl-gray hover:text-fl-black',
						)}
					>
						<span>{item.label}</span>
						{typeof item.count === 'number' && (
							<span
								className={cn(
									'inline-flex h-4 min-w-4 items-center justify-center px-1 text-[9px]',
									active
										? 'bg-fl-black text-fl-white'
										: 'bg-fl-soft text-fl-gray',
								)}
							>
								{item.count}
							</span>
						)}
						{active && (
							<motion.span
								layoutId="fl-tab-underline"
								className="bg-fl-black absolute inset-x-0 -bottom-px h-px"
								transition={{ type: 'spring', stiffness: 400, damping: 35 }}
							/>
						)}
					</button>
				);
			})}
			<div className="bg-fl-light absolute inset-x-0 -bottom-px h-px" aria-hidden="true" />
		</div>
	);
}
