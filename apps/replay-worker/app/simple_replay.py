"""Direct-CDP replay path that bypasses browser-use's Agent loop.

# Why this exists

browser-use 0.12.6's `Agent.run()` and `tools.act()` rely on a global
event bus + DOMWatchdog whose handlers return `None` when invoked
across multiple `BrowserSession` instances inside a single Python
process. Symptom: every parallel BU Cloud session past the first
fails on `BrowserStateRequestEvent` with "Expected at least one
handler to return a non-None result, but none did", which the Agent
then bails out on after 2 retries.

The matrix runner runs N variants in parallel by design — that's the
entire point of "test all flows in parallel". So we cannot rely on
the Agent loop. This module implements the small set of step actions
the matrix needs (navigate / click / input / keypress / wait /
scroll / assert) using raw CDP via the BU Cloud session's
`cdp_client`.

# What we don't lose

* T3 judge still runs on critical steps (separate code path, just
  needs a screenshot URL — handled by the caller).
* Cookies are still injected via Storage.setCookies (cookie_inject.py).
* Auth-wall detection is preserved (auth_wall.py reads the URL +
  password-input probe via `session.evaluate`).

# What we do lose

* Vision-based fallback when a recorded selector no longer resolves
  on the live DOM. For the matrix demo this is fine — we deliberately
  use stable selectors (Wikipedia's `input[name="search"]` is rock-
  solid) and the variants only mutate INPUT VALUES, not selectors.
  When/if an Agent fallback is needed we can re-introduce it here.
"""
from __future__ import annotations

import asyncio
import json
import re
import time
from typing import Any

from .contracts import FlowStep
from .telemetry import log


class SimpleReplayError(RuntimeError):
    pass


async def _evaluate(session: Any, expression: str) -> Any:
    """Evaluate a JS expression on the current target via raw CDP.

    Returns the unwrapped value (parsed from CDP's `result.value`).
    Raises on JS-side errors (`result.subtype == 'error'`).
    """
    cdp_session = await session.get_or_create_cdp_session(target_id=None)
    res = await cdp_session.cdp_client.send.Runtime.evaluate(
        params={
            "expression": expression,
            "returnByValue": True,
            "awaitPromise": True,
        },
        session_id=cdp_session.session_id,
    )
    if "exceptionDetails" in res:
        raise SimpleReplayError(
            f"JS exception: {res['exceptionDetails'].get('text', 'unknown')}"
        )
    obj = res.get("result", {})
    return obj.get("value")


async def _navigate(session: Any, url: str) -> None:
    """Navigate the active target to `url` and wait briefly for the DOM
    to settle (we don't have document-ready events plumbed)."""
    cdp_session = await session.get_or_create_cdp_session(target_id=None)
    await cdp_session.cdp_client.send.Page.navigate(
        params={"url": url},
        session_id=cdp_session.session_id,
    )
    # Page.navigate doesn't await load — give it a beat. We poll
    # document.readyState rather than sleeping a fixed time.
    for _ in range(40):
        try:
            ready = await _evaluate(session, "document.readyState")
        except Exception:
            ready = None
        if ready in ("interactive", "complete"):
            break
        await asyncio.sleep(0.25)


def _js_str(value: str) -> str:
    """JSON-encode a string so it can be embedded in a JS expression."""
    return json.dumps(value)


def _selector_expression(step: FlowStep) -> str:
    """Build a JS expression that returns the target element (or null).

    Order: testid → role+name → css → xpath. We match the same priority
    as the resolver in `resolve.py` so behavior is consistent.
    """
    sel = step.selectors
    parts: list[str] = []
    if sel.testid:
        t = _js_str(sel.testid)
        # Build the css attribute selector at JS-side using the literal value
        # so we don't have to triple-escape inside the f-string here.
        snippet = (
            "(() => { const t = " + t + ";"
            " const css = '[data-testid=' + JSON.stringify(t) + ']'"
            "          + ',[data-test='   + JSON.stringify(t) + ']'"
            "          + ',[data-cy='     + JSON.stringify(t) + ']'"
            "          + ',[id='          + JSON.stringify(t) + ']'"
            "          + ',[name='        + JSON.stringify(t) + ']';"
            " return document.querySelector(css); })()"
        )
        parts.append(snippet)
    if sel.css:
        parts.append("document.querySelector(" + _js_str(sel.css) + ")")
    if sel.role or sel.accessibleName:
        r = _js_str(sel.role or "")
        n = _js_str(sel.accessibleName or "")
        parts.append(
            "(() => {"
            " const role = " + r + "; const name = " + n + ";"
            " const all = document.querySelectorAll('[role], a, button, input, textarea, select, summary, [tabindex]');"
            " for (const el of all) {"
            "  const tag = el.tagName;"
            "  const implicit = ({A:'link',BUTTON:'button',INPUT:(el.type==='submit'?'button':'textbox'),TEXTAREA:'textbox',SELECT:'combobox'})[tag] || '';"
            "  const r2 = el.getAttribute('role') || implicit;"
            "  if (role && r2 !== role) continue;"
            "  const aria = el.getAttribute('aria-label') || el.getAttribute('name') || (el.innerText||'').trim() || el.placeholder || el.alt || '';"
            "  if (!name || aria.toLowerCase().includes(name.toLowerCase())) return el;"
            " }"
            " return null;"
            "})()"
        )
    if sel.xpath:
        parts.append(
            "document.evaluate(" + _js_str(sel.xpath)
            + ", document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue"
        )
    if not parts:
        return "null"
    return "(" + " || ".join("(" + p + ")" for p in parts) + ")"


async def _resolve_element_then(session: Any, step: FlowStep, action_js: str) -> Any:
    """Wait up to a few seconds for the selector to resolve, then run
    `action_js` against the resolved element (referenced as `el` inside
    the JS template)."""
    selector_expr = _selector_expression(step)
    js_template = (
        "(() => {"
        f"const el = {selector_expr};"
        "if (!el) return {ok: false, reason: 'no_match'};"
        f"{action_js}"
        "return {ok: true, info: el.tagName + ':' + (el.id||'') + ':' + (el.getAttribute('name')||'')};"
        "})()"
    )
    deadline = time.monotonic() + 6.0
    last_err: str | None = None
    while time.monotonic() < deadline:
        try:
            res = await _evaluate(session, js_template)
            if isinstance(res, dict) and res.get("ok"):
                return res
            last_err = (res or {}).get("reason", "no_match") if isinstance(res, dict) else "no_match"
        except Exception as e:
            last_err = str(e)
        await asyncio.sleep(0.4)
    raise SimpleReplayError(f"selector did not resolve: {last_err}")


async def _click(session: Any, step: FlowStep) -> Any:
    return await _resolve_element_then(
        session,
        step,
        "el.scrollIntoView({block:'center'});"
        "el.focus && el.focus();"
        "el.click();",
    )


async def _input(session: Any, step: FlowStep, value: str) -> Any:
    # Set value AND fire input/change events so React/Vue/MediaWiki update.
    js = (
        "el.scrollIntoView({block:'center'});"
        "el.focus && el.focus();"
        f"const v = {_js_str(value)};"
        "if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {"
        "  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value') ||"
        "                 Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value');"
        "  setter && setter.set ? setter.set.call(el, v) : (el.value = v);"
        "  el.dispatchEvent(new Event('input', {bubbles: true}));"
        "  el.dispatchEvent(new Event('change', {bubbles: true}));"
        "} else if (el.tagName === 'SELECT') {"
        "  el.value = v;"
        "  el.dispatchEvent(new Event('change', {bubbles: true}));"
        "} else {"
        "  el.textContent = v;"
        "  el.dispatchEvent(new Event('input', {bubbles: true}));"
        "}"
    )
    return await _resolve_element_then(session, step, js)


async def _keypress(session: Any, step: FlowStep, key: str) -> Any:
    """Best-effort keypress. We dispatch synthetic KeyboardEvents on the
    focused element. For Enter on a search form, we additionally call
    form.submit() so navigation actually happens.

    Real-world keyboard CDP (`Input.dispatchKeyEvent`) is more accurate
    but doesn't work consistently with React-controlled inputs. The
    JS path is good enough for the matrix demo against Wikipedia and
    MediaWiki-shaped sites.
    """
    js = (
        "el.scrollIntoView({block:'center'});"
        "el.focus && el.focus();"
        f"const key = {_js_str(key)};"
        "const opts = {key, bubbles: true, cancelable: true};"
        "el.dispatchEvent(new KeyboardEvent('keydown', opts));"
        "el.dispatchEvent(new KeyboardEvent('keypress', opts));"
        "el.dispatchEvent(new KeyboardEvent('keyup', opts));"
        "if (key === 'Enter') {"
        "  const form = el.closest && el.closest('form');"
        "  if (form && typeof form.requestSubmit === 'function') form.requestSubmit();"
        "  else if (form) form.submit();"
        "}"
    )
    return await _resolve_element_then(session, step, js)


async def _scroll(session: Any) -> None:
    await _evaluate(session, "window.scrollBy({top: window.innerHeight*0.8, behavior: 'instant'})")


async def capture_screenshot(session: Any) -> str | None:
    """Capture the current viewport as a base64 JPEG via raw CDP.

    Returns the base64 string with no data-URL prefix, or `None` if the
    screenshot failed for any reason. Never raises — a missing screenshot
    must not fail the surrounding step (we still want the step result).

    JPEG with quality=60 keeps each thumbnail well under ~80KB which is
    the soft budget the caller assumes for the SSE payload (5 parallel
    runs × N steps each round-tripping a base64 image). PNG was 5–10×
    larger on the same viewport. The field is still named
    `replayScreenshotPngB64` for wire compatibility — the bytes inside
    are JPEG and the TS uploader stamps the matching `image/jpeg`
    content-type when persisting to Vercel Blob.

    `captureBeyondViewport=False` keeps the image to the visible viewport
    only — full-page renders ballooned to multi-MB on long pages and
    pushed uploads past the SSE budget.
    """
    try:
        cdp_session = await session.get_or_create_cdp_session(target_id=None)
        res = await cdp_session.cdp_client.send.Page.captureScreenshot(
            params={
                "format": "jpeg",
                "quality": 60,
                "captureBeyondViewport": False,
            },
            session_id=cdp_session.session_id,
        )
        data = res.get("data") if isinstance(res, dict) else None
        if not isinstance(data, str) or not data:
            log.warning("[FLOWLENS:screenshot_empty]")
            return None
        return data
    except Exception as e:
        log.warning("[FLOWLENS:screenshot_failed]", error=str(e)[:200])
        return None


async def execute_simple(session: Any, step: FlowStep) -> dict[str, Any]:
    """Execute one step. Raises `SimpleReplayError` on failure.

    Returns a small dict with `via` (always 'cdp-simple'), `info` (DOM
    debug snippet when relevant), `urlAfter` (post-action URL).
    """
    info: Any = None
    if step.action == "navigate":
        url = step.url or step.recordedValue
        if not url:
            raise SimpleReplayError("navigate step missing url")
        await _navigate(session, url)
    elif step.action == "click":
        info = await _click(session, step)
    elif step.action == "input":
        if step.recordedValue is None:
            raise SimpleReplayError("input step missing recordedValue")
        info = await _input(session, step, step.recordedValue)
    elif step.action == "keypress":
        info = await _keypress(session, step, step.recordedValue or "Enter")
        # Keypress may trigger navigation — give it a brief moment.
        for _ in range(20):
            await asyncio.sleep(0.25)
            try:
                ready = await _evaluate(session, "document.readyState")
                if ready == "complete":
                    break
            except Exception:
                pass
    elif step.action == "wait":
        await asyncio.sleep(1.0)
    elif step.action == "scroll":
        await _scroll(session)
    elif step.action == "assert":
        # Pure assertions are validated outside this module.
        pass
    elif step.action == "select":
        if step.recordedValue is None:
            raise SimpleReplayError("select step missing recordedValue")
        info = await _input(session, step, step.recordedValue)
    else:
        raise SimpleReplayError(f"unsupported action {step.action}")

    url_after = await _evaluate(session, "location.href")
    title_after = await _evaluate(session, "document.title")
    log.info(
        "[FLOWLENS:simple_step]",
        action=step.action,
        index=step.index,
        info=str(info)[:120] if info else None,
        urlAfter=url_after,
        titleAfter=(title_after or "")[:80] if title_after else None,
    )
    return {"via": "cdp-simple", "info": info, "urlAfter": url_after, "titleAfter": title_after}


_AUTH_URL_RE = re.compile(r"/(login|signin|sign-in|sso|oauth|account)\b", re.IGNORECASE)


async def quick_auth_probe(session: Any) -> tuple[bool, str | None]:
    """Cheap auth-wall probe usable by the simple replay path. Mirrors
    the heuristics in `auth_wall.py` but uses raw CDP `Runtime.evaluate`
    so we don't depend on the browser-use BrowserSession event bus."""
    try:
        url = await _evaluate(session, "location.href")
        if isinstance(url, str) and _AUTH_URL_RE.search(url):
            return True, f"navigated to login URL {url}"
    except Exception:
        pass
    try:
        has_pwd = await _evaluate(
            session,
            "(() => { const el = document.querySelector('input[type=\"password\"]');"
            " return !!(el && (el.offsetWidth > 0 || el.offsetHeight > 0)); })()",
        )
        if has_pwd:
            return True, "visible password input detected"
    except Exception:
        pass
    return False, None
