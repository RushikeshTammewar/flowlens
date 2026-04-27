# @flowlens/web

Flowlens v3 web dashboard + API on Next.js 16.

## Local dev

```bash
cp .env.example .env.local
# fill in DATABASE_URL, BROWSER_USE_API_KEY, etc.

pnpm install
pnpm db:push        # push schema to dev Postgres
pnpm dev            # serves on http://localhost:3000
```

## Endpoints (phase 1)

- `GET /api/health` — env + reachability smoke test
- `GET /` — placeholder landing

## Endpoints (phase 2+)

See [`docs/v3/LLD.md` §3](../../docs/v3/LLD.md#3-api-contracts).

## Deploy

Linked to Vercel via `vercel.json` (root of the monorepo).
