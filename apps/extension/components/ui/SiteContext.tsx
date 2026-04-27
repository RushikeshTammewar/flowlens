import { ChevronDown, Globe } from 'lucide-react';
import { cn } from './cn';

interface Props {
	host: string | null;
	onSwitch?: () => void;
	indicator?: React.ReactNode;
	className?: string;
}

/**
 * Site context row used in headers — favicon glyph + origin + caret.
 */
export function SiteContext({ host, onSwitch, indicator, className }: Props) {
	const inner = (
		<>
			<span className="bg-fl-soft border-fl-line flex h-4 w-4 shrink-0 items-center justify-center border">
				<Globe size={9} className="text-fl-gray" aria-hidden="true" />
			</span>
			<span className="text-fl-black truncate font-mono text-[11px]">{host ?? 'no site'}</span>
			{indicator}
			{onSwitch && (
				<ChevronDown
					size={11}
					className="text-fl-gray shrink-0"
					aria-hidden="true"
				/>
			)}
		</>
	);
	if (!onSwitch) {
		return (
			<div className={cn('flex items-center gap-1.5', className)}>
				{inner}
			</div>
		);
	}
	return (
		<button
			onClick={onSwitch}
			className={cn(
				'group flex items-center gap-1.5 px-1 -mx-1 hover:bg-fl-soft transition-colors',
				className,
			)}
		>
			{inner}
		</button>
	);
}
