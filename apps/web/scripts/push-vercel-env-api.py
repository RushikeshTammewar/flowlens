#!/usr/bin/env python3
"""Push env vars to Vercel via the REST API directly.

The `vercel env add` CLI hangs intermittently for 5+ minutes per call (probably
rate-limited or stuck on a TLS handshake). Going around the CLI:

    POST /v10/projects/:projectId/env
        body: { key, value, type, target, gitBranch? }

Reads token from ~/Library/Application Support/com.vercel.cli/auth.json and
project id from apps/web/.vercel/project.json — both written by `vercel login`
+ `vercel link`. Doesn't echo any secrets.

Usage:
    ./scripts/push-vercel-env-api.py [--target production|preview|development|all]
                                     [--git-branch v3-foundations]
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent  # apps/web/
ENV_LOCAL = ROOT / ".env.local"
PROJECT_JSON = ROOT / ".vercel" / "project.json"
AUTH_JSON = Path.home() / "Library/Application Support/com.vercel.cli/auth.json"

VARS = [
    "DATABASE_URL",
    "DATABASE_URL_UNPOOLED",
    "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY",
    "CLERK_SECRET_KEY",
    "OPENAI_API_KEY",
    "BROWSER_USE_API_KEY",
    "FLOWLENS_VAULT_SECRET",
    "REPLAY_WORKER_SHARED_SECRET",
    "BLOB_READ_WRITE_TOKEN",
    "BLOB_PUBLIC_BASE_URL",
    "UPSTASH_REDIS_REST_URL",
    "UPSTASH_REDIS_REST_TOKEN",
    "REPLAY_WORKER_URL",
]


def load_env_local() -> dict[str, str]:
    out: dict[str, str] = {}
    for line in ENV_LOCAL.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if "=" not in line:
            continue
        k, _, v = line.partition("=")
        if (v.startswith('"') and v.endswith('"')) or (v.startswith("'") and v.endswith("'")):
            v = v[1:-1]
        out[k] = v
    return out


def api(token: str, method: str, path: str, body: dict | None = None) -> tuple[int, dict]:
    url = f"https://api.vercel.com{path}"
    data = json.dumps(body).encode() if body else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Authorization", f"Bearer {token}")
    if body:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return resp.status, json.loads(resp.read() or b"{}")
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read() or b"{}")
        except json.JSONDecodeError:
            return e.code, {"error": str(e)}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--target",
        choices=["production", "preview", "development", "all"],
        default="all",
    )
    parser.add_argument("--git-branch", default="v3-foundations")
    args = parser.parse_args()

    targets = (
        ["production", "preview", "development"]
        if args.target == "all"
        else [args.target]
    )

    auth = json.loads(AUTH_JSON.read_text())
    token = auth["token"]
    project = json.loads(PROJECT_JSON.read_text())
    project_id = project["projectId"]
    team_id = project.get("orgId")

    env_vars = load_env_local()

    base_path = f"/v10/projects/{project_id}/env"
    if team_id:
        base_path += f"?teamId={team_id}"
    sep = "&" if "?" in base_path else "?"

    # Snapshot existing env vars so we know what to delete first.
    status, existing = api(token, "GET", f"/v9/projects/{project_id}/env{('?teamId=' + team_id) if team_id else ''}")
    if status != 200:
        print(f"Failed to list existing envs: {status} {existing}")
        return 1
    existing_envs = existing.get("envs", [])

    ok = 0
    fail: list[tuple[str, str, str]] = []
    skipped: list[str] = []
    for var in VARS:
        val = env_vars.get(var, "")
        if not val:
            skipped.append(var)
            print(f"[{var}] SKIP (empty in .env.local)")
            continue

        for target in targets:
            # Find existing matching env (same key, target, and branch for preview)
            for ex in existing_envs:
                if ex["key"] != var:
                    continue
                ex_target = ex.get("target") or []
                if isinstance(ex_target, str):
                    ex_target = [ex_target]
                if target not in ex_target:
                    continue
                if target == "preview" and ex.get("gitBranch") != args.git_branch:
                    continue
                # Match — delete it before re-adding so we update cleanly.
                ex_id = ex["id"]
                del_path = f"/v9/projects/{project_id}/env/{ex_id}"
                if team_id:
                    del_path += f"?teamId={team_id}"
                api(token, "DELETE", del_path)

            body: dict = {
                "key": var,
                "value": val,
                "type": "encrypted",
                "target": [target],
            }
            if target == "preview":
                body["gitBranch"] = args.git_branch

            status, resp = api(token, "POST", base_path, body)
            if status in (200, 201):
                print(f"[{var}/{target}{'/' + args.git_branch if target == 'preview' else ''}] OK")
                ok += 1
            else:
                msg = resp.get("error", {}).get("message") if isinstance(resp.get("error"), dict) else resp.get("error", str(resp))
                print(f"[{var}/{target}] FAIL {status}: {msg}")
                fail.append((var, target, str(msg)))
            time.sleep(0.1)  # gentle throttling

    print()
    print("=== summary ===")
    print(f"OK:      {ok}")
    print(f"SKIP:    {len(skipped)}")
    print(f"FAIL:    {len(fail)}")
    if fail:
        for var, tgt, err in fail:
            print(f"  - {var}/{tgt}: {err}")
    return 0 if not fail else 1


if __name__ == "__main__":
    sys.exit(main())
