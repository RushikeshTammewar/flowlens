#!/usr/bin/env python3
"""Push a single env var to Vercel for production + preview + development.

Used after rotating one specific value (e.g. REPLAY_WORKER_URL after
deploying the App Runner sidecar). Reads the current value from
apps/web/.env.local and writes it to all three target environments.

Usage:
    ./scripts/push-one-vercel-env.py REPLAY_WORKER_URL [--git-branch v3-foundations]
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ENV_LOCAL = ROOT / ".env.local"
PROJECT_JSON = ROOT / ".vercel" / "project.json"
AUTH_JSON = Path.home() / "Library/Application Support/com.vercel.cli/auth.json"


def load_env_local() -> dict[str, str]:
    out: dict[str, str] = {}
    for line in ENV_LOCAL.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, _, v = line.partition("=")
        if (v.startswith('"') and v.endswith('"')) or (v.startswith("'") and v.endswith("'")):
            v = v[1:-1]
        out[k] = v
    return out


def api(token: str, method: str, path: str, body: dict | None = None):
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
    parser.add_argument("var", help="Env var name to update")
    parser.add_argument("--git-branch", default="v3-foundations")
    args = parser.parse_args()

    auth = json.loads(AUTH_JSON.read_text())
    project = json.loads(PROJECT_JSON.read_text())
    token, project_id, team_id = auth["token"], project["projectId"], project.get("orgId")
    env_vars = load_env_local()
    val = env_vars.get(args.var, "")
    if not val:
        print(f"{args.var}: empty in .env.local")
        return 1

    base_path = f"/v10/projects/{project_id}/env"
    if team_id:
        base_path += f"?teamId={team_id}"

    # Snapshot existing
    list_path = f"/v9/projects/{project_id}/env"
    if team_id:
        list_path += f"?teamId={team_id}"
    status, listing = api(token, "GET", list_path)
    existing = [e for e in listing.get("envs", []) if e["key"] == args.var]

    fail = 0
    for target in ("production", "preview", "development"):
        for ex in existing:
            ex_target = ex.get("target") or []
            if isinstance(ex_target, str):
                ex_target = [ex_target]
            if target not in ex_target:
                continue
            if target == "preview" and ex.get("gitBranch") != args.git_branch:
                continue
            del_path = f"/v9/projects/{project_id}/env/{ex['id']}"
            if team_id:
                del_path += f"?teamId={team_id}"
            api(token, "DELETE", del_path)

        body: dict = {"key": args.var, "value": val, "type": "encrypted", "target": [target]}
        if target == "preview":
            body["gitBranch"] = args.git_branch
        status, resp = api(token, "POST", base_path, body)
        if status in (200, 201):
            print(f"[{args.var}/{target}{'/' + args.git_branch if target == 'preview' else ''}] OK")
        else:
            print(f"[{args.var}/{target}] FAIL {status}: {resp}")
            fail += 1
    return 0 if not fail else 1


if __name__ == "__main__":
    sys.exit(main())
