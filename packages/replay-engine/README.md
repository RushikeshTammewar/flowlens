# @flowlens/replay-engine

TS-side orchestration for the Python replay worker (`apps/replay-worker`).

## Surface

```ts
import { createReplayWorkerClient } from '@flowlens/replay-engine';

const worker = createReplayWorkerClient(); // reads env: REPLAY_WORKER_URL + REPLAY_WORKER_SHARED_SECRET

// Stream a full run; yields well-typed events.
for await (const event of worker.streamRun({
  runId: '...',
  flow: { id, name, siteOrigin, steps },
  cdpUrl: 'wss://browser-use-cloud.../...',
  recordedScreenshotsByIndex: { 0: 'https://...', 1: 'https://...' },
  sensitiveData: { 'password.shop.example.com': '<decrypted>' },
})) {
  switch (event.type) {
    case 'step_started': /* emit SSE upstream */ break;
    case 'step_finished': /* persist step_results row */ break;
    case 'run_paused': /* checkpoint workflow, send notification */ break;
    case 'run_complete': /* persist run row, end workflow */ break;
  }
}

// Selector probe without running a full step.
const resolved = await worker.resolve({ cdpUrl, selectors });
```

## Auth

Bearer token in `Authorization`. Both ends share `REPLAY_WORKER_SHARED_SECRET` via env.

## What this package is NOT

- It does NOT spin up a BU Cloud session. That's `@flowlens/bu-cloud-client` in the workflow handler.
- It does NOT persist anything. That's the workflow handler in `apps/web/workflows/run-flow.ts`.
- It does NOT call OpenAI directly. The Python worker does that.

This package is the typed boundary between TS-orchestration and Python-execution. Keep it thin.

## Wire contract

Every shape mirrors `apps/replay-worker/app/contracts.py` field-for-field. If
you change one side without the other, the next request 422s. We accept that
trade-off — codegen across two languages is more pain than the manual sync.
