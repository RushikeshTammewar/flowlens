import { type ReactNode } from 'react';
import { cn } from './cn';

interface Props {
	recordedSrc?: string | null;
	replaySrc?: string | null;
	recordedLabel?: ReactNode;
	replayLabel?: ReactNode;
	className?: string;
}

/**
 * Side-by-side recorded vs replay screenshots.
 * In the side panel we render thumbnails; the full diff lives on the web report.
 */
export function Diff({
	recordedSrc,
	replaySrc,
	recordedLabel = 'Recorded',
	replayLabel = 'Replay',
	className,
}: Props) {
	return (
		<div className={cn('grid grid-cols-2 gap-1.5', className)}>
			<DiffPane src={recordedSrc} label={recordedLabel} />
			<DiffPane src={replaySrc} label={replayLabel} />
		</div>
	);
}

function DiffPane({ src, label }: { src: string | null | undefined; label: ReactNode }) {
	return (
		<figure className="border-fl-line border bg-fl-white">
			<div className="bg-fl-soft text-fl-gray border-b border-fl-line flex items-center justify-between px-1.5 py-1 text-[9px] uppercase tracking-wider">
				<span>{label}</span>
			</div>
			<div className="bg-fl-soft relative aspect-[4/3] w-full overflow-hidden">
				{src ? (
					<img
						src={src}
						alt={typeof label === 'string' ? `${label} screenshot` : 'screenshot'}
						className="absolute inset-0 h-full w-full object-cover"
					/>
				) : (
					<div className="text-fl-gray flex h-full w-full items-center justify-center text-[10px]">
						no screenshot
					</div>
				)}
			</div>
		</figure>
	);
}

interface ThumbsProps {
	srcs: ReadonlyArray<string | null | undefined>;
	className?: string;
	onClickIndex?: (index: number) => void;
}

/**
 * Small grid of screenshot thumbnails. Useful for the run report's step strip.
 */
export function ThumbnailGrid({ srcs, className, onClickIndex }: ThumbsProps) {
	return (
		<div className={cn('grid grid-cols-4 gap-1', className)}>
			{srcs.map((src, i) => (
				<button
					key={i}
					type="button"
					onClick={() => onClickIndex?.(i)}
					className="border-fl-line bg-fl-soft relative block aspect-square overflow-hidden border transition-transform duration-150 ease-out hover:scale-[1.02]"
					aria-label={`Step ${i + 1}`}
				>
					{src ? (
						<img src={src} alt="" className="absolute inset-0 h-full w-full object-cover" />
					) : (
						<span className="text-fl-gray absolute inset-0 flex items-center justify-center text-[9px]">
							{i + 1}
						</span>
					)}
				</button>
			))}
		</div>
	);
}
