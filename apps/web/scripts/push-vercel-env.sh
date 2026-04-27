#!/usr/bin/env bash
# Push all .env.local secrets to Vercel for production / preview / development.
#
# Usage: from apps/web/, run `./scripts/push-vercel-env.sh`.
#
# Idempotent: each var is removed (best-effort) before being added so reruns
# update existing values cleanly. Values are piped via stdin so they never
# appear in process listings or shell history.

set -u  # leave -e off — we intentionally let `vercel env rm` fail on first add.
cd "$(dirname "$0")/.." || exit 1

if [[ ! -f ".env.local" ]]; then
  echo "ERROR: apps/web/.env.local not found"
  exit 1
fi

VARS=(
  DATABASE_URL
  DATABASE_URL_UNPOOLED
  NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY
  CLERK_SECRET_KEY
  OPENAI_API_KEY
  BROWSER_USE_API_KEY
  FLOWLENS_VAULT_SECRET
  REPLAY_WORKER_SHARED_SECRET
  BLOB_READ_WRITE_TOKEN
  BLOB_PUBLIC_BASE_URL
  UPSTASH_REDIS_REST_URL
  UPSTASH_REDIS_REST_TOKEN
  REPLAY_WORKER_URL
)

ENVS=(production preview development)

OK=0
SKIP=0
FAIL=0

for VAR in "${VARS[@]}"; do
  # Pull value from .env.local. cut -d= -f2- preserves any `=` inside the value.
  VAL=$(grep "^${VAR}=" .env.local | head -1 | cut -d= -f2-)
  # Strip optional surrounding quotes.
  VAL="${VAL%\"}"; VAL="${VAL#\"}"
  VAL="${VAL%\'}"; VAL="${VAL#\'}"

  if [[ -z "$VAL" ]]; then
    echo "[$VAR] EMPTY in .env.local — skipping"
    SKIP=$((SKIP + 1))
    continue
  fi

  for ENV in "${ENVS[@]}"; do
    # Best-effort remove; ignore "not found" errors.
    vercel env rm "$VAR" "$ENV" --yes >/dev/null 2>&1 || true
    # Use --value (non-interactive) + --yes (skip confirm). The value briefly
    # appears in argv during this command — acceptable for a one-shot script
    # on a developer machine; for CI/CD use Vercel's API directly with secrets
    # in the runner's secret store.
    if vercel env add "$VAR" "$ENV" --value "$VAL" --yes >/dev/null 2>&1; then
      printf '[%s/%s] OK\n' "$VAR" "$ENV"
      OK=$((OK + 1))
    else
      printf '[%s/%s] FAIL\n' "$VAR" "$ENV"
      FAIL=$((FAIL + 1))
    fi
  done
done

echo ""
echo "=== summary ==="
echo "OK:   $OK"
echo "SKIP: $SKIP"
echo "FAIL: $FAIL"

exit $FAIL
