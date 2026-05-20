/**
 * In-memory compile-status map.
 *
 * Phase 3.5a: the actual durable execution lives in `apps/web/src/workflows/compile-recording.ts`
 * (Vercel Workflow Devkit). This file is only the cache that backs
 * `GET /api/flows/:id/compile-status` so the extension's polling-based
 * Compiling screen can render a progress bar without subscribing to SSE.
 *
 * Limitation: the Map is per-function-instance. After Vercel's autoscaler
 * spins up a second instance, polls hitting that one will see no status.
 * Phase 4 will replace this with Upstash Redis so the cache survives
 * autoscaling. The SSE bus (`@/lib/sse-bus`) is the durable signal.
 */
import type { CompileProgressEvent } from '@flowlens/flow-doc';

export interface CompileStatus {
	flowId: string;
	stage: CompileProgressEvent['stage'] | 'queued' | 'done' | 'failed';
	pct: number;
	detail?: string;
	error?: string;
	updatedAt: number;
	/**
	 * Phase 4 / UX §1 — rolling buffer of the most recently decoded
	 * narrate-stage steps, surfaced by the compile pipeline. The
	 * extension's Compiling screen renders this as a live "what the
	 * AI just figured out" feed during the narrate stage. Reset (cleared)
	 * once the pipeline moves on to synthesize.
	 */
	recentNarrations?: CompileProgressEvent['recentNarrations'];
}

const STATUS = new Map<string, CompileStatus>();

export function getCompileStatus(flowId: string): CompileStatus | null {
	return STATUS.get(flowId) ?? null;
}

export function setCompileStatus(s: CompileStatus): void {
	STATUS.set(s.flowId, { ...s, updatedAt: Date.now() });
}
