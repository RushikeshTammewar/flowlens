"""Inject decrypted cookies into a freshly-spawned BU Cloud BrowserSession.

# Why this is the entire authentication story

Phase 3.x's `run-batch-inline.ts` decrypted the snapshot but only put the
cookies in browser-use's `sensitive_data` map (a name→value placeholder
substitution table for the LLM-driven Agent). That never reached the
browser. The session loaded the target site logged-out, the auth wall
detector tripped on every variant, and the matrix scored 0/N on step 0.

This module fixes the gap: it speaks raw CDP at the BU Cloud session,
calls `Storage.setCookies` with the full cookie array, then reports the
post-injection state so the caller can log a clean `cookies.injected`
event.

# Why CDP `Storage.setCookies` (and not `Network.setCookie`)

`Storage.setCookies` is browser-scoped — the cookies persist for any
target spawned afterwards, including new tabs from `Page.navigate`.
`Network.setCookie` is per-target and disappears as soon as the
DevTools session detaches. We want the cookies bound to the browser
profile for the whole replay.
"""
from __future__ import annotations

from typing import Any, Iterable

from .contracts import CookieParam
from .telemetry import log


def _to_cdp_cookie(c: CookieParam) -> dict[str, Any]:
    """Convert a Flowlens-shape ChromeCookie into a CDP CookieParam dict.

    CDP `Storage.setCookies` rejects:
      - `sameSite: 'unspecified'` — strip it.
      - `expires: null` for non-session cookies — drop the key.
    """
    out: dict[str, Any] = {
        "name": c.name,
        "value": c.value,
        "domain": c.domain,
        "path": c.path or "/",
        "secure": bool(c.secure),
        "httpOnly": bool(c.httpOnly),
    }
    if c.sameSite in ("Strict", "Lax", "None"):
        out["sameSite"] = c.sameSite
    if c.expires is not None:
        out["expires"] = float(c.expires)
    return out


async def inject_cookies(session: Any, cookies: Iterable[CookieParam]) -> dict[str, Any]:
    """Push `cookies` into `session` via CDP `Storage.setCookies`.

    Returns a small report `{count, injected, errors}` so the caller can log
    a single line per run. Never raises — failure is treated as 0 injections
    so the run can still proceed (and the auth-wall detector will catch the
    consequence).
    """
    cookie_list = list(cookies)
    report: dict[str, Any] = {"count": len(cookie_list), "injected": 0, "errors": []}
    if not cookie_list:
        log.info("[FLOWLENS:cookie_inject] no_cookies_in_request")
        return report

    try:
        cdp_session = await session.get_or_create_cdp_session(target_id=None)
    except Exception as e:
        log.error("[FLOWLENS:cookie_inject] cdp_session_acquire_failed", error=str(e))
        report["errors"].append(f"cdp_session: {e}")
        return report

    cdp_cookies = [_to_cdp_cookie(c) for c in cookie_list]

    # Send in one batch. CDP accepts up to a few thousand at once; we'll
    # never approach that limit with browser-extension snapshots.
    try:
        await cdp_session.cdp_client.send.Storage.setCookies(
            params={"cookies": cdp_cookies},  # type: ignore[arg-type]
            session_id=cdp_session.session_id,
        )
        report["injected"] = len(cdp_cookies)
        log.info(
            "[FLOWLENS:cookie_inject] success",
            count=report["injected"],
            domains=sorted({c["domain"] for c in cdp_cookies}),
            sample_names=[c["name"] for c in cdp_cookies[:5]],
        )
    except Exception as e:
        # If the batch fails, retry one-at-a-time so a single bad cookie
        # doesn't lose the whole set. This adds ~50 round-trips worst-case
        # but the SLA is unchanged because we only do this on retry.
        log.warning(
            "[FLOWLENS:cookie_inject] batch_failed_retrying_per_cookie",
            error=str(e),
            count=len(cdp_cookies),
        )
        for c in cdp_cookies:
            try:
                await cdp_session.cdp_client.send.Storage.setCookies(
                    params={"cookies": [c]},  # type: ignore[arg-type]
                    session_id=cdp_session.session_id,
                )
                report["injected"] += 1
            except Exception as ie:
                report["errors"].append(f"{c['name']}@{c['domain']}: {ie}")
        log.info(
            "[FLOWLENS:cookie_inject] per_cookie_done",
            injected=report["injected"],
            errors=len(report["errors"]),
        )

    return report


async def navigate_with_cookies(session: Any, url: str) -> dict[str, Any]:
    """Navigate to `url` and report the post-navigation URL so the caller
    can detect "did we land on the protected page or get bounced to login".

    Returns `{requestedUrl, finalUrl, success, error}`.
    """
    out: dict[str, Any] = {"requestedUrl": url, "finalUrl": None, "success": False, "error": None}
    try:
        await session.navigate_to(url)
    except Exception as e:
        out["error"] = f"navigate_to failed: {e}"
        log.warning("[FLOWLENS:nav_after_inject] navigate_failed", url=url, error=str(e))
        return out

    try:
        final_url = await session.get_current_page_url()
        out["finalUrl"] = final_url
        out["success"] = isinstance(final_url, str) and len(final_url) > 0
        log.info("[FLOWLENS:nav_after_inject] landed", requestedUrl=url, finalUrl=final_url)
    except Exception as e:
        out["error"] = f"get_current_page_url failed: {e}"
        log.warning("[FLOWLENS:nav_after_inject] url_probe_failed", error=str(e))

    return out
