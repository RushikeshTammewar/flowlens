#!/usr/bin/env python3
"""Production /run smoke against the deployed App Runner sidecar.

Cost: ~$0.005 BU + ~$0.02 OpenAI (one Agent loop, 2 steps, 1 critical → judge).

Always stops the BU session in finally — verified via the bu-cloud
stopBrowserSession fix shipped in this PR.

Usage:
    python3 ./scripts/prod-smoke.py
"""
from __future__ import annotations

import http.client
import json
import ssl
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent  # apps/web/
ENV_LOCAL = ROOT / ".env.local"

BU_HOST = "api.browser-use.com"
BU_BASE = "https://api.browser-use.com/api/v2"
APP_RUNNER_URL = "https://ejiymmxysz.us-east-1.awsapprunner.com"


def load_env() -> dict[str, str]:
    out: dict[str, str] = {}
    for line in ENV_LOCAL.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, _, v = line.partition("=")
        if (v.startswith('"') and v.endswith('"')) or (
            v.startswith("'") and v.endswith("'")
        ):
            v = v[1:-1]
        out[k] = v
    return out


def bu_request(method: str, path: str, key: str, body: dict | None = None) -> tuple[int, dict]:
    url = f"{BU_BASE}{path}"
    data = json.dumps(body).encode() if body else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("X-Browser-Use-API-Key", key)
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


FLOW = {
    "id": "smoke-prod",
    "name": "Smoke: navigate to example.com, find heading",
    "siteOrigin": "https://example.com",
    "steps": [
        {
            "index": 0,
            "action": "navigate",
            "intent": "Open https://example.com",
            "expectedOutcome": 'Page loads with heading "Example Domain"',
            "isCritical": True,
            "selectors": {"css": "h1"},
            "recordedValue": None,
            "isSensitive": False,
            "recordedScreenshotKey": "",
            "url": "https://example.com",
        },
        {
            "index": 1,
            "action": "click",
            "intent": 'Click the "More information..." link',
            "expectedOutcome": "Navigated to iana.org",
            "isCritical": False,
            "selectors": {
                "role": "link",
                "accessibleName": "More information...",
                "css": "a",
            },
            "recordedValue": None,
            "isSensitive": False,
            "recordedScreenshotKey": "",
            "url": None,
        },
    ],
}


def stream_run(cdp_url: str, live_url: str, bearer: str) -> dict:
    """POST /run, drain SSE for up to 90s, return summary."""
    body = {
        "runId": f"smoke-prod-{int(time.time())}",
        "flow": FLOW,
        "cdpUrl": cdp_url,
        "liveUrl": live_url,
        "mode": {"name": "hybrid"},
        "recordedScreenshotsByIndex": {},
        "sensitiveData": {},
    }

    req = urllib.request.Request(
        f"{APP_RUNNER_URL}/run",
        data=json.dumps(body).encode(),
        method="POST",
    )
    req.add_header("Authorization", f"Bearer {bearer}")
    req.add_header("Content-Type", "application/json")
    req.add_header("Accept", "text/event-stream")

    events: list[dict] = []
    deadline = time.time() + 90.0
    step_started_count = 0
    step_finished_count = 0
    step_finished_passed = 0
    run_complete: dict | None = None
    run_paused: dict | None = None

    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            print(f"  POST /run → HTTP {resp.status}")
            print(f"  content-type: {resp.headers.get('content-type')}")
            # Use readline() — SSE is line-oriented and read(n) blocks for n bytes.
            # readline() returns each line as soon as it arrives.
            current_block: list[bytes] = []
            while time.time() < deadline:
                line = resp.readline()
                if not line:
                    print("  [stream EOF]")
                    break
                stripped = line.rstrip(b"\r\n")
                if stripped == b"":
                    # End of an SSE event — process accumulated lines
                    for raw in current_block:
                        if not raw.startswith(b"data:"):
                            continue
                        payload = raw[5:].strip()
                        if not payload:
                            continue
                        try:
                            ev = json.loads(payload)
                        except json.JSONDecodeError:
                            continue
                        events.append(ev)
                        et = ev.get("type", "?")
                        if et == "step_finished":
                            r = ev.get("result", {})
                            snippet = (
                                f"step_finished idx={r.get('stepIndex')} "
                                f"status={r.get('status')} via={r.get('selectorResolvedVia')} "
                                f"cost_micro={r.get('llmCostUsdMicro')}"
                            )
                            step_finished_count += 1
                            if r.get("status") in ("passed", "inconclusive"):
                                step_finished_passed += 1
                        elif et == "step_started":
                            snippet = f"step_started idx={ev.get('stepIndex')}"
                            step_started_count += 1
                        elif et == "run_complete":
                            snippet = (
                                f"run_complete status={ev.get('status')} "
                                f"health={ev.get('healthScore')} "
                                f"summary={(ev.get('summary') or '')[:140]}"
                            )
                            run_complete = ev
                        elif et == "run_paused":
                            snippet = f"run_paused reason={ev.get('reason')} hint={ev.get('hint')}"
                            run_paused = ev
                        else:
                            snippet = json.dumps(ev)[:200]
                        print(f"  · {snippet}")
                    current_block = []
                    if run_complete or run_paused:
                        break
                else:
                    current_block.append(stripped)
    except urllib.error.HTTPError as e:
        body_txt = e.read().decode("utf-8", errors="replace")[:300]
        return {
            "ok": False,
            "error": f"HTTP {e.code}",
            "body": body_txt,
            "events": events,
        }
    except Exception as e:
        return {
            "ok": False,
            "error": str(e),
            "events": events,
        }

    return {
        "ok": True,
        "events": events,
        "step_started": step_started_count,
        "step_finished": step_finished_count,
        "step_finished_passed_or_inconclusive": step_finished_passed,
        "run_complete": run_complete,
        "run_paused": run_paused,
    }


def main() -> int:
    env = load_env()
    bu_key = env.get("BROWSER_USE_API_KEY")
    bearer = env.get("REPLAY_WORKER_SHARED_SECRET")
    if not bu_key or not bearer:
        print("ERROR: BROWSER_USE_API_KEY or REPLAY_WORKER_SHARED_SECRET missing in .env.local")
        return 2

    print("=== 1. Create BU session ===")
    status, sess = bu_request(
        "POST",
        "/browsers",
        bu_key,
        {"proxyCountryCode": "us", "stealthMode": False},
    )
    if status not in (200, 201):
        print(f"BU create failed: {status} {sess}")
        return 3
    sid = sess["id"]
    cdp = sess.get("cdpUrl") or ""
    live = sess.get("liveUrl") or ""
    print(f"  session.id      = {sid}")
    print(f"  hasCdp          = {bool(cdp)}")
    print(f"  hasLive         = {bool(live)}")

    result: dict = {}
    try:
        print()
        print("=== 2. POST /run + stream SSE ===")
        result = stream_run(cdp, live, bearer)

        print()
        print("=== 3. Verdict ===")
        if not result.get("ok"):
            print(f"❌ FAIL — {result.get('error')}: {result.get('body', '')}")
            return 4

        n_started = result["step_started"]
        n_finished = result["step_finished"]
        complete = result["run_complete"]
        paused = result["run_paused"]
        passed_or_inconclusive = result["step_finished_passed_or_inconclusive"]

        if n_started >= 1 and n_finished >= 1 and (complete is not None or paused is not None):
            print(f"✅ PASS — {n_started} step_started, {n_finished} step_finished "
                  f"({passed_or_inconclusive} passed/inconclusive), "
                  f"terminal={'run_complete:' + complete['status'] if complete else 'run_paused:' + paused['reason']}")
            return 0
        else:
            print(f"❌ FAIL — incomplete event sequence: started={n_started}, "
                  f"finished={n_finished}, complete={bool(complete)}, paused={bool(paused)}")
            return 5
    finally:
        print()
        print("=== 4. Stop BU session (finally) ===")
        s2, _ = bu_request("PATCH", f"/browsers/{sid}", bu_key, {"action": "stop"})
        print(f"  PATCH /browsers/{sid[:8]}… → HTTP {s2}")

        # Approximate cost
        ev = result.get("events") or []
        total_micro = 0
        for e in ev:
            if e.get("type") == "step_finished":
                total_micro += e.get("result", {}).get("llmCostUsdMicro", 0)
        print()
        print("=== 5. Cost ===")
        print(f"  OpenAI cost (sidecar-reported): ~${total_micro / 1_000_000:.5f}")
        print(f"  BU billed: ~$0.06/hr × elapsed (≤2 min for this smoke ≈ $0.002)")


if __name__ == "__main__":
    sys.exit(main())
