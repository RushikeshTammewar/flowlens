# Flowlens

> AI QA via record + replay. Install the extension, demonstrate a flow once, we test it forever on Browser Use Cloud.

## Repository layout

This is a hybrid mono-repo: existing v2 (Python + EC2) and new v3 (TypeScript monorepo on Vercel) coexist while v3 is built. v2 will be archived in `legacy/` once v3 ships.

```text
flowlens/
  docs/v3/                    Design docs for v3 (HLD, LLD, UX) — read these first
  apps/
    extension/                v3 Chrome extension (WXT + React + Tailwind v4)
    web/                      v3 Next.js 16 dashboard + API
    replay-worker/            v3 Python sidecar for browser-use (Phase 3)
  packages/
    schema/                   Shared Zod + Drizzle types
    bu-cloud-client/          Typed Browser Use Cloud v2 client
    design-tokens/            Single-source-of-truth color / type / spacing
  agent/                      v2 Python QA agent (legacy)
  backend/                    v2 FastAPI (legacy, runs on EC2)
  frontend/                   v2 Next.js (legacy, served from Vercel)
  scan.py                     v2 CLI entrypoint (legacy)
  infra/                      v2 EC2 setup scripts (legacy)
  pnpm-workspace.yaml
  package.json
  vercel.json                 links the v3 monorepo to Vercel
```

## Quick start (v3)

```bash
pnpm install
cp apps/web/.env.example apps/web/.env.local       # fill in DATABASE_URL etc.
cp apps/extension/.env.example apps/extension/.env.local

pnpm -F @flowlens/web dev                          # web on :3000
pnpm -F @flowlens/extension dev                    # extension hot-reload
pnpm typecheck                                     # all workspaces
```

## Common scripts

| Run                                | What it does                                                                       |
| ---------------------------------- | ---------------------------------------------------------------------------------- |
| `pnpm dev`                         | Run all apps in parallel watch mode                                                |
| `pnpm -F @flowlens/web dev`        | Web only (port 3000)                                                               |
| `pnpm -F @flowlens/extension dev`  | Extension hot reload (loads from `apps/extension/.output/chrome-mv3-dev`)          |
| `pnpm -F @flowlens/web build`      | Production web build                                                               |
| `pnpm -F @flowlens/extension build`| Production extension build → `apps/extension/.output/chrome-mv3`                   |
| `pnpm -F @flowlens/extension zip`  | Bundle for Chrome Web Store                                                        |
| `pnpm -F @flowlens/web db:push`    | Apply Drizzle schema to your dev Postgres                                          |
| `pnpm -F @flowlens/web db:studio`  | Drizzle Studio (DB inspector)                                                      |
| `pnpm typecheck`                   | Typecheck every workspace                                                          |

## Required env vars (per [LLD §16](docs/v3/LLD.md#16-security-considerations))

| Var | Where | Notes |
|---|---|---|
| `DATABASE_URL` | apps/web | Neon Postgres URL |
| `BROWSER_USE_API_KEY` | apps/web | https://cloud.browser-use.com/new-api-key |
| `OPENAI_API_KEY` | apps/web | Sole LLM provider (centralized in `apps/web/src/lib/models.ts`) |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | apps/web + extension | Clerk dashboard |
| `CLERK_SECRET_KEY` | apps/web | Clerk dashboard |
| `BLOB_READ_WRITE_TOKEN` | apps/web | Vercel Marketplace integration |
| `FLOWLENS_VAULT_SECRET` | apps/web | 64-byte hex; signs per-org cookie keypairs |

Per-stage model overrides (all optional, sensible defaults in code):
`FLOWLENS_MODEL_NARRATE`, `FLOWLENS_MODEL_SYNTHESIZE`, `FLOWLENS_MODEL_REPLAY_AGENT`, `FLOWLENS_MODEL_JUDGE`, `FLOWLENS_MODEL_INVESTIGATOR`, `FLOWLENS_MODEL_SITE_MODEL`, `FLOWLENS_MODEL_DATA_GEN`, `FLOWLENS_MODEL_SIBLING_GEN`, `FLOWLENS_MODEL_DRIFT`, `FLOWLENS_MODEL_SENSITIVE`.

## Loading the extension into Chrome (dev)

```bash
pnpm -F @flowlens/extension dev
# In Chrome:
# 1. chrome://extensions
# 2. Enable "Developer mode"
# 3. Click "Load unpacked"
# 4. Select  apps/extension/.output/chrome-mv3-dev
# 5. Pin Flowlens to the toolbar; click it to open the side panel
```

## v3 design docs

Start here if you're new to the v3 architecture:

- [`docs/v3/HLD.md`](docs/v3/HLD.md) — vision, end-to-end user journey, system architecture, tech stack rationale, phasing, costs, risks
- [`docs/v3/LLD.md`](docs/v3/LLD.md) — implementation: data models, API contracts, recording protocol, replay engine algorithm, browser-use config, edge cases, execution traces
- [`docs/v3/UX.md`](docs/v3/UX.md) — design principles, journey maps, ASCII wireframes for every state, microcopy

## Phases

- **Phase 1** (shipped): foundations. Monorepo, schema package, BU Cloud client, design tokens, OpenAI client + centralized `MODELS`, extension + web scaffolds, `/api/health` smoke test. ✅
- **Phase 1.5**: real Clerk auth (replaces stub in extension side panel).
- **Phase 2**: recording pipeline (rrweb + screenshots + cookies → Flow document via OpenAI).
- **Phase 3**: hybrid replay engine on BU Cloud (`tools.act()` CDP-direct + Python sidecar Agent loop) + auth refresh loop.
- **Phase 4**: web dashboard + regression diff (Pro tier) + scheduling + Chrome Web Store + EC2 decommission.

See [HLD §10 Phased delivery](docs/v3/HLD.md#10-phased-delivery-4-weeks).

## Deploy

The Next.js web app deploys via [`vercel.json`](vercel.json) at the repo root — connect this repo to a Vercel project and set the env vars above. The Python replay sidecar (Phase 3) deploys to Fly.io / Railway / Vercel Sandbox as a separate service. The extension is built locally (`pnpm -F @flowlens/extension zip`) and uploaded to the Chrome Web Store in Phase 4.

## v2 docs (legacy)

- [`CONTEXT.md`](CONTEXT.md) — v2 single source of truth (no longer current; refer to docs/v3 for new work)
- [`docs/ARCHITECTURE_V2.md`](docs/ARCHITECTURE_V2.md) — v2 Python+EC2 architecture
