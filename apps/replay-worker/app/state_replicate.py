"""Phase 4 / Tier 3 — additive session replication on top of cookie injection.

Cookies are still the headline auth story (`cookie_inject.py`). This
module handles the layers that ride alongside cookies:

  - **Web Storage** (`localStorage`, `sessionStorage`) — per-origin
    {key:value} sets the recorder snapshotted at recording start. We
    inject them right after the landing-URL navigate (Storage APIs are
    document-scoped, so they need a real document to write into).
  - **Browser fingerprint** — UA / viewport / device-pixel-ratio /
    timezone / locale via CDP `Emulation.*` overrides, applied BEFORE
    the first navigate so the very first request carries them.

What's deferred (LLD §8 — captured-but-not-yet-replayed):
  - IndexedDB databases (capture works; injection needs per-origin
    eval choreography that's not on the demo critical path)
  - Service Worker registrations (same reason)
  - Permissions (browser-level grants — needs a different CDP domain)

Logged under scope: [phase4:state]
"""
from __future__ import annotations

import json
from typing import Any
from urllib.parse import urlparse

from .contracts import FingerprintHints, SessionState, StorageItem
from .telemetry import log


async def apply_fingerprint(session: Any, hints: FingerprintHints | None) -> dict[str, Any]:
    """Apply UA / viewport / locale / timezone via CDP `Emulation.*`.

    Each call is independent — failure of one doesn't cancel the others.
    Returns a small report so the run logger can surface what got
    applied without the caller needing to grep CDP responses.

    Run BEFORE the landing-URL navigate so the first HTTP request
    already carries the overridden UA / Accept-Language headers.
    """
    report: dict[str, Any] = {"applied": [], "skipped": [], "errors": []}
    if hints is None:
        return report

    try:
        cdp_session = await session.get_or_create_cdp_session(target_id=None)
    except Exception as e:
        report["errors"].append(f"cdp_session: {e}")
        log.warning("[phase4:state] cdp_session_acquire_failed", error=str(e))
        return report

    sid = cdp_session.session_id
    client = cdp_session.cdp_client

    # Order matters: UA before viewport (UA influences server-driven
    # responsive renders) before locale before timezone.
    if hints.userAgent:
        try:
            await client.send.Emulation.setUserAgentOverride(
                params={"userAgent": hints.userAgent},
                session_id=sid,
            )
            report["applied"].append("userAgent")
        except Exception as e:
            report["errors"].append(f"userAgent: {e}")

    if hints.viewportWidth and hints.viewportHeight:
        try:
            await client.send.Emulation.setDeviceMetricsOverride(
                params={
                    "width": int(hints.viewportWidth),
                    "height": int(hints.viewportHeight),
                    "deviceScaleFactor": float(hints.deviceScaleFactor or 1.0),
                    "mobile": False,
                },
                session_id=sid,
            )
            report["applied"].append("viewport")
        except Exception as e:
            report["errors"].append(f"viewport: {e}")

    if hints.locale:
        try:
            await client.send.Emulation.setLocaleOverride(
                params={"locale": hints.locale},
                session_id=sid,
            )
            report["applied"].append("locale")
        except Exception as e:
            # Some Chromium builds reject locales they don't have data
            # for. Non-fatal — log and continue.
            report["errors"].append(f"locale: {e}")

    if hints.timezoneId:
        try:
            await client.send.Emulation.setTimezoneOverride(
                params={"timezoneId": hints.timezoneId},
                session_id=sid,
            )
            report["applied"].append("timezone")
        except Exception as e:
            report["errors"].append(f"timezone: {e}")

    log.info(
        "[phase4:state] fingerprint_applied",
        applied=report["applied"],
        errors=len(report["errors"]),
    )
    return report


async def apply_web_storage(
    session: Any,
    state: SessionState,
    landing_url: str,
) -> dict[str, Any]:
    """Inject `localStorage` + `sessionStorage` snapshots into the live
    document.

    Web Storage is document-scoped — Storage APIs require a same-origin
    document context, so this must be called AFTER the landing-URL
    navigate (cookie_inject + fingerprint go first).

    We pull the entry list for the landing URL's origin from the
    state map. Recorder may have captured multiple origins (e.g. an
    iframe's storage); we ignore those for now — only the top-level
    document's storage gets injected. Cross-origin storage is out of
    scope for the demo.

    Failure of one item doesn't cancel the others. Returns a report.
    """
    report: dict[str, Any] = {
        "localStorage": {"applied": 0, "errors": []},
        "sessionStorage": {"applied": 0, "errors": []},
    }
    parsed = urlparse(landing_url)
    if not parsed.scheme or not parsed.netloc:
        log.warning("[phase4:state] web_storage_skipped", reason="bad landing url", landing=landing_url)
        return report

    origin = f"{parsed.scheme}://{parsed.netloc}"
    local_items = state.localStorage.get(origin, [])
    session_items = state.sessionStorage.get(origin, [])

    if not local_items and not session_items:
        log.info("[phase4:state] web_storage_skipped", reason="no items for origin", origin=origin)
        return report

    if local_items:
        report["localStorage"] = await _set_storage(session, "localStorage", local_items)
    if session_items:
        report["sessionStorage"] = await _set_storage(session, "sessionStorage", session_items)

    log.info(
        "[phase4:state] web_storage_applied",
        origin=origin,
        local=report["localStorage"]["applied"],
        sessionItems=report["sessionStorage"]["applied"],
    )
    return report


async def _set_storage(
    session: Any,
    area: str,
    items: list[StorageItem],
) -> dict[str, Any]:
    """Write a list of {key, value} entries to `localStorage` or
    `sessionStorage` via Runtime.evaluate.

    We batch all entries into a single JS expression — N round-trips
    of `Runtime.evaluate` per item would multiply the latency cost
    (~30ms per call * 50 items = 1.5s per session). One eval handles
    the whole set.
    """
    try:
        cdp_session = await session.get_or_create_cdp_session(target_id=None)
    except Exception as e:
        return {"applied": 0, "errors": [f"cdp_session: {e}"]}

    payload = json.dumps([{"key": i.key, "value": i.value} for i in items])
    js = (
        "(() => {"
        f"  const items = {payload};"
        f"  const area = window.{area};"
        "  const out = { applied: 0, errors: [] };"
        "  if (!area) { out.errors.push('storage area unavailable'); return out; }"
        "  for (const it of items) {"
        "    try { area.setItem(it.key, it.value); out.applied++; }"
        "    catch (e) { out.errors.push(String(e).slice(0, 80)); }"
        "  }"
        "  return out;"
        "})()"
    )
    try:
        res = await cdp_session.cdp_client.send.Runtime.evaluate(
            params={"expression": js, "returnByValue": True, "awaitPromise": False},
            session_id=cdp_session.session_id,
        )
        value = (res.get("result") or {}).get("value") or {}
        return {
            "applied": int(value.get("applied", 0)),
            "errors": list(value.get("errors", []))[:5],
        }
    except Exception as e:
        return {"applied": 0, "errors": [f"runtime_evaluate: {e}"]}
