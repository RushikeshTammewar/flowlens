import { cn } from './cn';

interface SkeletonProps {
	className?: string;
	width?: number | string;
	height?: number | string;
	rounded?: boolean;
}

export function Skeleton({ className, width, height, rounded }: SkeletonProps) {
	const style: React.CSSProperties = {};
	if (width !== undefined) style.width = typeof width === 'number' ? `${width}px` : width;
	if (height !== undefined) style.height = typeof height === 'number' ? `${height}px` : height;
	return (
		<div
			aria-hidden="true"
			className={cn('fl-shimmer block', rounded ? 'rounded-full' : '', className)}
			style={style}
		/>
	);
}

export function SkeletonRow({ lines = 2 }: { lines?: number }) {
	return (
		<div className="space-y-1.5">
			{Array.from({ length: lines }).map((_, i) => (
				<Skeleton key={i} className="h-3 w-full" />
			))}
		</div>
	);
}

export function FlowCardSkeleton() {
	return (
		<div className="border-fl-light space-y-2 border p-2.5">
			<div className="flex items-center justify-between">
				<Skeleton className="h-3 w-1/2" />
				<Skeleton className="h-3 w-12" />
			</div>
			<Skeleton className="h-2 w-2/3" />
		</div>
	);
}
