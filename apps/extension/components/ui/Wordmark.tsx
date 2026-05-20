import { cn } from './cn';

interface Props {
	className?: string;
	version?: string;
}

/**
 * Flowlens wordmark — terminal star + monospace logotype.
 * Mirrors the brand mark used on flowlens.in.
 */
export function Wordmark({ className, version }: Props) {
	return (
		<div className={cn('flex items-baseline gap-1.5 font-mono text-[12px]', className)}>
			<span aria-hidden="true" className="text-fl-cta translate-y-[1px] text-[14px] leading-none">
				✦
			</span>
			<span className="text-fl-black font-semibold tracking-tight">flowlens</span>
			{version && <span className="text-fl-gray text-[10px]">v{version}</span>}
		</div>
	);
}
