"""Selector → live `backend_node_id` resolution.

Implements the 4-tier strategy from LLD §4 + §5.5:
  1. testid       (data-testid / data-test / data-cy / id / data-flowlens-id)
  2. role+name    (ARIA role + accessible name)
  3. css          (document.querySelector via CDP Runtime.evaluate)
  4. xpath        (document.evaluate via CDP)

We never persist the live `backend_node_id`. It changes on DOM rebuild; the
return value is only valid until the next page mutation cycle.
"""
from __future__ import annotations

import asyncio
from typing import TYPE_CHECKING, Any

from .contracts import HardenedSelectors, ResolveResultFound, ResolveResultMissing

if TYPE_CHECKING:
    # browser_use types live behind ignore_missing_imports in mypy.ini
    pass


_SETTLE_TIMEOUT_MS = 3_000
_RETRY_DELAY_MS = 1_000


async def resolve_backend_node_id(
    cdp_url: str,
    selectors: HardenedSelectors,
) -> ResolveResultFound | ResolveResultMissing:
    """Resolve hardened selectors against the live DOM at `cdp_url`.

    Strategy: try each tier in order. If a tier returns 0 matches, try next.
    If a tier returns >1 matches, mark ambiguous and try next (an Agent step
    upstream will disambiguate). If we never find a unique match, return
    `no_match` so the caller falls through to the Agent loop.
    """
    from browser_use import BrowserSession  # type: ignore[import-not-found]

    session = BrowserSession(cdp_url=cdp_url, keep_alive=True)
    await session.start()
    try:
        # Wait briefly for the page to settle before first attempt.
        await _safe_wait_idle(session, timeout_ms=_SETTLE_TIMEOUT_MS)

        # Two attempts: the first uses the live DOM, the second waits a beat
        # and tries again (catches "page not settled" cases).
        for attempt in range(2):
            if attempt == 1:
                await asyncio.sleep(_RETRY_DELAY_MS / 1000)
                await _safe_wait_idle(session, timeout_ms=_SETTLE_TIMEOUT_MS)

            for tier in ("flowlens-id", "testid", "role-name", "css", "xpath"):
                node_id = await _try_tier(session, selectors, tier)
                if node_id is not None:
                    return ResolveResultFound(backendNodeId=node_id, via=tier)  # type: ignore[arg-type]

        return ResolveResultMissing(reason="no_match")
    finally:
        # Don't stop the session — the caller's run loop owns its lifecycle.
        # We started it again here only because BU Cloud BrowserSession is
        # idempotent across `.start()` calls when keep_alive=True.
        pass


async def _safe_wait_idle(session: Any, *, timeout_ms: int) -> None:
    try:
        if hasattr(session, "wait_for_idle"):
            await session.wait_for_idle(timeout=timeout_ms / 1000)
        else:
            await asyncio.sleep(min(timeout_ms, 1500) / 1000)
    except Exception:
        # browser-use signals "no idle reached" via a few different exception
        # shapes. Resolution is best-effort; we move on.
        pass


async def _try_tier(
    session: Any, selectors: HardenedSelectors, tier: str
) -> int | None:
    """Return a single matching `backend_node_id` for the given tier, else None.

    We use CDP Runtime.evaluate for css/xpath because that gives us an
    objectId we can resolve to backend_node_id. For testid/role+name we walk
    browser-use's serialized DOM and match attributes there.
    """
    summary = await _safe_get_state(session)
    if summary is None:
        return None
    selector_map = getattr(summary, "selector_map", None) or {}

    # Strategy is per-tier — the matching is structurally similar so we keep
    # it inline rather than dispatching to separate functions for each.
    matches: list[int] = []

    for backend_node_id, node in selector_map.items():
        attrs = getattr(node, "attributes", {}) or {}
        text = (getattr(node, "text", "") or "").strip()
        role = attrs.get("role") or _implicit_role(getattr(node, "tag_name", ""))
        name = (
            attrs.get("aria-label")
            or attrs.get("name")
            or text
            or attrs.get("placeholder")
            or attrs.get("alt")
            or ""
        ).strip()

        match = False
        if tier == "flowlens-id" and selectors.flowlensId:
            match = attrs.get("data-flowlens-id") == selectors.flowlensId
        elif tier == "testid" and selectors.testid:
            match = (
                attrs.get("data-testid") == selectors.testid
                or attrs.get("data-test") == selectors.testid
                or attrs.get("data-cy") == selectors.testid
                or attrs.get("id") == selectors.testid
            )
        elif tier == "role-name" and (selectors.role or selectors.accessibleName):
            ok_role = selectors.role is None or role == selectors.role
            ok_name = selectors.accessibleName is None or name == selectors.accessibleName
            match = ok_role and ok_name and (selectors.role is not None or selectors.accessibleName is not None)
        elif tier == "css" and selectors.css:
            match = await _css_match(session, selectors.css, backend_node_id)
        elif tier == "xpath" and selectors.xpath:
            match = await _xpath_match(session, selectors.xpath, backend_node_id)

        if match:
            matches.append(int(backend_node_id))

    if len(matches) == 1:
        return matches[0]
    return None  # 0 or >1 → caller tries next tier


_IMPLICIT_ROLE = {
    "a": "link",
    "button": "button",
    "input": "textbox",
    "textarea": "textbox",
    "select": "combobox",
    "form": "form",
    "nav": "navigation",
    "header": "banner",
    "footer": "contentinfo",
    "main": "main",
    "dialog": "dialog",
}


def _implicit_role(tag_name: str) -> str:
    return _IMPLICIT_ROLE.get((tag_name or "").lower(), "")


async def _safe_get_state(session: Any) -> Any:
    try:
        # browser-use exposes state summaries under different names across
        # 0.12.x → 0.13.x. Probe the two we know about.
        for fn_name in ("get_browser_state_summary", "get_state_summary", "get_dom_state"):
            fn = getattr(session, fn_name, None)
            if fn is not None:
                return await fn(include_screenshot=False)
        return None
    except Exception:
        return None


async def _css_match(session: Any, css: str, backend_node_id: int) -> bool:
    js = (
        "(() => {"
        f"const el = document.querySelector({_js_str(css)});"
        "if (!el) return null;"
        "return el;"
        "})()"
    )
    return await _evaluate_match(session, js, backend_node_id)


async def _xpath_match(session: Any, xpath: str, backend_node_id: int) -> bool:
    js = (
        "(() => {"
        f"const r = document.evaluate({_js_str(xpath)}, document, null, "
        "XPathResult.FIRST_ORDERED_NODE_TYPE, null);"
        "return r.singleNodeValue;"
        "})()"
    )
    return await _evaluate_match(session, js, backend_node_id)


async def _evaluate_match(session: Any, js: str, backend_node_id: int) -> bool:
    """Evaluate a JS expression and ask CDP whether the resolved node matches
    the given backend_node_id. Implementation varies between browser-use
    versions; we probe.
    """
    try:
        evaluator = getattr(session, "evaluate", None) or getattr(session, "execute_javascript", None)
        if evaluator is None:
            return False
        node = await evaluator(js)
        if node is None:
            return False
        # browser-use returns either a CDP RemoteObjectId or a primitive.
        # We rely on it returning a backend_node_id directly when targeted at
        # a node; if it returns the element representation, we compare ids.
        if isinstance(node, dict):
            candidate = node.get("backend_node_id") or node.get("backendNodeId")
            return candidate is not None and int(candidate) == backend_node_id
        return False
    except Exception:
        return False


def _js_str(value: str) -> str:
    """JSON-encode a string for safe embedding in a JS expression."""
    import json
    return json.dumps(value)
