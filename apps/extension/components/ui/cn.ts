import { clsx, type ClassValue } from 'clsx';

/**
 * Tiny class-name combiner used by every component.
 * Kept separate so we can swap to tailwind-merge later if needed.
 */
export function cn(...inputs: ClassValue[]): string {
	return clsx(inputs);
}
