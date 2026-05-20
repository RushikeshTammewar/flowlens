# @flowlens/replay-worker

Python sidecar that hosts `browser-use` for the Flowlens v3 replay engine.
The TS web app talks to it over HTTP; the worker drives a Browser Use Cloud
session via `cdp_url`. See [LLD §5.5](../../docs/v3/LLD.md#55-browser-use-configuration--selector-resolution)
and [§6](../../docs/v3/LLD.md#6-replay-engine-algorithm) for the full architecture.

## Endpoints

| Method | Path        | Auth | Description                                                                           |
| ------ | ----------- | ---- | ------------------------------------------------------------------------------------- |
| GET    | `/healthz`  | none | Liveness probe. Returns `{ ok, version, browserUseAvailable, openaiAvailable }`.      |
| POST   | `/run`      | bearer | Stream a full replay as SSE events (step_started, step_finished, run_paused, run_complete). |
| POST   | `/resolve`  | bearer | Resolve `HardenedSelectors` against the live DOM at `cdp_url`. Returns found/missing. |

## Auth

Every protected endpoint requires `Authorization: Bearer $REPLAY_WORKER_SHARED_SECRET`.
`apps/web` (TS replay-engine) signs requests with the same secret. Mismatched or
missing secrets return `401`.

Generate locally:

```bash
openssl rand -hex 32
```

In production, mount via:

- **AWS App Runner** → AWS Secrets Manager + IAM task role
- **Azure Container Apps** → Azure Key Vault + Managed Identity

## Local dev

```bash
cd apps/replay-worker
python -m venv .venv && source .venv/bin/activate
pip install -e '.[dev]'
cp .env.example .env.local

# fill in OPENAI_API_KEY and REPLAY_WORKER_SHARED_SECRET in .env.local
uvicorn app.main:app --reload --port 8000

# in another shell:
curl -s http://localhost:8000/healthz | python -m json.tool
```

## Tests

```bash
pip install -e '.[dev]'
pytest -v
mypy app
ruff check app tests
```

## Docker build

```bash
docker build -t flowlens-replay-worker:latest .
docker run --rm -p 8000:8000 \
  -e OPENAI_API_KEY=sk-... \
  -e REPLAY_WORKER_SHARED_SECRET=... \
  -e BROWSER_USE_API_KEY=bu_... \
  flowlens-replay-worker:latest
```

Multi-stage Dockerfile produces a ~150MB image; cold start <10s on AWS App Runner / Azure Container Apps.

## Deploy

See [`deploy/README.md`](deploy/README.md). Both AWS App Runner and Azure
Container Apps pipelines are scaffolded; pick one at deploy time based on
which credit pool you're drawing from.

## What lives here vs apps/web

| Concern                              | Where     |
| ------------------------------------ | --------- |
| `browser_use.Agent` loop             | here      |
| `tools.act()` direct CDP execution   | here      |
| Selector → `backend_node_id` resolve | here      |
| Auth-wall detection (URL / DOM probe) | here     |
| Run lifecycle / persistence          | apps/web  |
| BU Cloud session create / stop       | apps/web  |
| Cookie vault encryption              | apps/web  |
| T1 deterministic (HTTP / console)    | apps/web  |
| Compile pipeline                     | apps/web  |
| User-facing API endpoints            | apps/web  |

Worker is **stateless across requests**. One `/run` holds one BU Cloud session in memory
for the run's duration; nothing persists between calls. Container can scale up/down freely.
