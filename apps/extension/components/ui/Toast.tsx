/**
 * Toast component + provider.
 * Top-of-panel transient messages with auto-dismiss and a tiny queue.
 */
import {
	createContext,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useRef,
	useState,
	type ReactNode,
} from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { CheckCircle2, AlertTriangle, Info, X, XCircle } from 'lucide-react';
import { cn } from './cn';

export type ToastTone = 'success' | 'error' | 'info' | 'warn';

export interface Toast {
	id: number;
	tone: ToastTone;
	title: string;
	body?: string;
	durationMs?: number;
}

interface ToastContextValue {
	push: (t: Omit<Toast, 'id'>) => number;
	dismiss: (id: number) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export function useToast(): ToastContextValue {
	const ctx = useContext(ToastContext);
	if (!ctx) throw new Error('useToast must be used inside <ToastProvider>');
	return ctx;
}

const toneStyles: Record<ToastTone, { ring: string; icon: ReactNode }> = {
	success: {
		ring: 'border-fl-green/40 bg-fl-green-bg text-fl-black',
		icon: <CheckCircle2 size={14} className="text-fl-green" aria-hidden="true" />,
	},
	error: {
		ring: 'border-fl-red/40 bg-fl-red-bg text-fl-black',
		icon: <XCircle size={14} className="text-fl-red" aria-hidden="true" />,
	},
	warn: {
		ring: 'border-fl-amber/40 bg-fl-amber-bg text-fl-black',
		icon: <AlertTriangle size={14} className="text-fl-amber" aria-hidden="true" />,
	},
	info: {
		ring: 'border-fl-blue/40 bg-fl-blue-bg text-fl-black',
		icon: <Info size={14} className="text-fl-blue" aria-hidden="true" />,
	},
};

export function ToastProvider({ children }: { children: ReactNode }) {
	const [toasts, setToasts] = useState<Toast[]>([]);
	const counter = useRef(0);
	const timers = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());

	const dismiss = useCallback((id: number) => {
		setToasts((prev) => prev.filter((t) => t.id !== id));
		const handle = timers.current.get(id);
		if (handle) {
			clearTimeout(handle);
			timers.current.delete(id);
		}
	}, []);

	const push = useCallback(
		(t: Omit<Toast, 'id'>) => {
			counter.current += 1;
			const id = counter.current;
			const duration = t.durationMs ?? 3500;
			setToasts((prev) => [...prev, { id, ...t }].slice(-3));
			const handle = setTimeout(() => dismiss(id), duration);
			timers.current.set(id, handle);
			return id;
		},
		[dismiss],
	);

	useEffect(() => {
		const map = timers.current;
		return () => {
			for (const handle of map.values()) clearTimeout(handle);
			map.clear();
		};
	}, []);

	const value = useMemo<ToastContextValue>(() => ({ push, dismiss }), [push, dismiss]);

	return (
		<ToastContext.Provider value={value}>
			{children}
			<div className="pointer-events-none fixed inset-x-2 top-2 z-50 flex flex-col gap-1.5">
				<AnimatePresence initial={false}>
					{toasts.map((t) => {
						const tone = toneStyles[t.tone];
						return (
							<motion.div
								key={t.id}
								initial={{ opacity: 0, y: -8 }}
								animate={{ opacity: 1, y: 0 }}
								exit={{ opacity: 0, y: -8 }}
								transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
								role="status"
								className={cn(
									'pointer-events-auto flex items-start gap-2 border px-2.5 py-2 text-[11px] shadow-[0_1px_2px_rgba(15,15,15,0.06),0_4px_12px_rgba(15,15,15,0.04)]',
									tone.ring,
								)}
							>
								<span className="mt-px shrink-0">{tone.icon}</span>
								<div className="min-w-0 flex-1">
									<div className="font-mono text-[11px] font-semibold tracking-tight">{t.title}</div>
									{t.body && (
										<div className="text-fl-gray mt-0.5 break-words text-[10px]">{t.body}</div>
									)}
								</div>
								<button
									aria-label="Dismiss"
									onClick={() => dismiss(t.id)}
									className="text-fl-gray hover:text-fl-black -mr-1 -mt-1 shrink-0 p-1"
								>
									<X size={12} aria-hidden="true" />
								</button>
							</motion.div>
						);
					})}
				</AnimatePresence>
			</div>
		</ToastContext.Provider>
	);
}
