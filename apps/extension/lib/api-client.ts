/**
 * Typed Flowlens API client used by both the side panel and the service worker.
 * Reads the auth token from chrome.storage.local (key: `flowlens_auth_token`).
 */
import { APP_CONFIG } from '../app.config.js';

export interface StartRecordingRequest {
	siteOrigin: string;
	displayName: string;
	viewport: { w: number; h: number; dpr: number };
	userAgent: string;
}
export interface StartRecordingResponse {
	recordingId: string;
	flowId: string;
	siteId: string;
	uploadKeyPrefix: string;
}

async function getToken(): Promise<string | null> {
	const res = await chrome.storage.local.get('flowlens_auth_token');
	const v = res.flowlens_auth_token;
	return typeof v === 'string' && v.length > 0 ? v : null;
}

async function authedFetch(path: string, init?: RequestInit): Promise<Response> {
	const token = await getToken();
	const headers = new Headers(init?.headers);
	headers.set('Content-Type', headers.get('Content-Type') ?? 'application/json');
	if (token) headers.set('Authorization', `Bearer ${token}`);
	return fetch(`${APP_CONFIG.apiUrl}${path}`, { ...init, headers });
}

export const api = {
	async health(): Promise<unknown> {
		const res = await fetch(`${APP_CONFIG.apiUrl}/api/health`);
		return res.json();
	},
	async startRecording(input: StartRecordingRequest): Promise<StartRecordingResponse> {
		const res = await authedFetch('/api/recordings/start', { method: 'POST', body: JSON.stringify(input) });
		if (!res.ok) throw new Error(`startRecording failed: ${res.status} ${await res.text()}`);
		return (await res.json()) as StartRecordingResponse;
	},
	async putChunk(input: {
		recordingId: string;
		ordinal: number;
		gzipped?: Uint8Array;
		screenshots?: Array<{ actionIndex: number; pngBase64: string }>;
	}): Promise<{ ordinal: number; bytesStored: number; screenshotsStored: number }> {
		const token = await getToken();
		const fd = new FormData();
		fd.set('ordinal', String(input.ordinal));
		if (input.gzipped) {
			fd.set('rrweb', new Blob([input.gzipped as BlobPart], { type: 'application/octet-stream' }));
		}
		for (const ss of input.screenshots ?? []) {
			const blob = await base64PngToBlob(ss.pngBase64);
			fd.set(`screenshot.${ss.actionIndex}`, blob, `screenshot-${ss.actionIndex}.png`);
		}
		const headers: HeadersInit = {};
		if (token) headers.Authorization = `Bearer ${token}`;
		const res = await fetch(`${APP_CONFIG.apiUrl}/api/recordings/${input.recordingId}/chunks`, {
			method: 'PUT',
			headers,
			body: fd,
		});
		if (!res.ok) throw new Error(`putChunk failed: ${res.status} ${await res.text()}`);
		return res.json();
	},
	async finishRecording(input: {
		recordingId: string;
		payload: unknown;
	}): Promise<{ flowId: string; cookieSnapshotId: string }> {
		const res = await authedFetch(`/api/recordings/${input.recordingId}/finish`, {
			method: 'POST',
			body: JSON.stringify(input.payload),
		});
		if (!res.ok) throw new Error(`finishRecording failed: ${res.status} ${await res.text()}`);
		return res.json();
	},
	async getCompileStatus(flowId: string): Promise<{
		flowStatus: 'draft' | 'compiling' | 'ready' | 'archived';
		compile: { stage: string; pct: number; detail?: string; error?: string };
	}> {
		const res = await authedFetch(`/api/flows/${flowId}/compile-status`);
		if (!res.ok) throw new Error(`compile-status failed: ${res.status}`);
		return res.json();
	},
	async getFlow(flowId: string): Promise<{ flow: unknown }> {
		const res = await authedFetch(`/api/flows/${flowId}`);
		if (!res.ok) throw new Error(`getFlow failed: ${res.status}`);
		return res.json();
	},
	async listFlows(query: { siteId?: string; status?: string }): Promise<{ flows: unknown[] }> {
		const params = new URLSearchParams();
		if (query.siteId) params.set('siteId', query.siteId);
		if (query.status) params.set('status', query.status);
		const qs = params.toString() ? `?${params.toString()}` : '';
		const res = await authedFetch(`/api/flows${qs}`);
		if (!res.ok) throw new Error(`listFlows failed: ${res.status}`);
		return res.json();
	},
	async startRun(flowId: string, mode: 'hybrid' | 'fast' | 'full_llm' = 'hybrid'): Promise<{ runId: string }> {
		const res = await authedFetch(`/api/flows/${flowId}/runs`, {
			method: 'POST',
			body: JSON.stringify({ mode }),
		});
		if (!res.ok) throw new Error(`startRun failed: ${res.status} ${await res.text()}`);
		return res.json();
	},
	async getRun(runId: string): Promise<{ run: { liveUrl: string | null; status: string; summary: string; healthScore: number | null }; stepResults: unknown[] }> {
		const res = await authedFetch(`/api/runs/${runId}`);
		if (!res.ok) throw new Error(`getRun failed: ${res.status}`);
		return res.json();
	},
	async cancelRun(runId: string): Promise<void> {
		const res = await authedFetch(`/api/runs/${runId}/cancel`, { method: 'POST' });
		if (!res.ok) throw new Error(`cancelRun failed: ${res.status}`);
	},
	async refreshCookies(input: {
		siteOrigin: string;
		cookies: unknown[];
		storage: { localStorage: Record<string, string>; sessionStorage: Record<string, string> };
		triggeredByRunId?: string;
	}): Promise<{ cookieSnapshotId: string; buProfileUpdated: boolean; runResumed: boolean }> {
		const res = await authedFetch(`/api/cookies/refresh`, {
			method: 'POST',
			body: JSON.stringify(input),
		});
		if (!res.ok) throw new Error(`refreshCookies failed: ${res.status} ${await res.text()}`);
		return res.json();
	},
};

async function base64PngToBlob(b64: string): Promise<Blob> {
	const cleaned = b64.startsWith('data:') ? b64.slice(b64.indexOf(',') + 1) : b64;
	const bin = atob(cleaned);
	const bytes = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
	return new Blob([bytes], { type: 'image/png' });
}
