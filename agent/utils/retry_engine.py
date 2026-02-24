"""Multi-strategy retry engine for element finding and action execution.

When the primary heuristic fails to find an element, the retry engine
tries progressively more expensive strategies before giving up.
"""

from __future__ import annotations

import asyncio
from playwright.async_api import Page, ElementHandle

from agent.utils.smart_wait import wait_for_stable_page


async def find_with_retry(
    page: Page,
    target_description: str,
    find_fn,
    ai_find_fn=None,
    max_retries: int = 3,
) -> tuple[ElementHandle | None, str]:
    """Try multiple strategies to find an element.

    Returns (element, method_used) where method_used is one of:
    "heuristic", "heuristic_retry", "scroll_retry", "ai_fallback", or "not_found".
    """
    # Strategy 1: Direct heuristic (already tried by caller usually)
    el = await find_fn(page, target_description)
    if el:
        return el, "heuristic"

    # Strategy 2: Wait for page to stabilize, then retry
    await wait_for_stable_page(page, timeout_ms=3000)
    el = await find_fn(page, target_description)
    if el:
        return el, "heuristic_retry"

    # Strategy 3: Scroll down to reveal hidden elements, then retry
    try:
        await page.evaluate("window.scrollBy(0, window.innerHeight)")
        await page.wait_for_timeout(500)
        el = await find_fn(page, target_description)
        if el:
            return el, "scroll_retry"
        await page.evaluate("window.scrollTo(0, 0)")
        await page.wait_for_timeout(300)
    except Exception:
        pass

    # Strategy 4: Try clicking any dismiss/close buttons that might be covering content
    await _try_dismiss_overlays(page)
    el = await find_fn(page, target_description)
    if el:
        return el, "overlay_dismiss_retry"

    # Strategy 5: AI fallback
    if ai_find_fn:
        el, ai_used = await ai_find_fn(target_description)
        if el:
            return el, "ai_fallback"

    return None, "not_found"


async def execute_with_retry(
    action_fn,
    max_retries: int = 2,
    delay_ms: int = 1000,
) -> tuple[bool, str | None]:
    """Retry an action function with exponential backoff.

    action_fn should raise on failure and return on success.
    Returns (success, error_message).
    """
    last_error = None
    for attempt in range(max_retries + 1):
        try:
            await action_fn()
            return True, None
        except Exception as e:
            last_error = str(e)[:300]
            if attempt < max_retries:
                await asyncio.sleep(delay_ms / 1000 * (attempt + 1))

    return False, last_error


async def _try_dismiss_overlays(page: Page):
    """Quick attempt to dismiss any visible overlays."""
    dismiss_selectors = [
        'button[aria-label*="close" i]',
        'button[aria-label*="dismiss" i]',
        'button[aria-label*="accept" i]',
        '[class*="cookie"] button',
        '[class*="consent"] button',
        '[class*="overlay"] button[class*="close"]',
        '[class*="modal"] button[class*="close"]',
        '[class*="banner"] button[class*="close"]',
        '[class*="popup"] button[class*="close"]',
        'button[class*="close"]',
    ]
    for sel in dismiss_selectors:
        try:
            el = await page.query_selector(sel)
            if el and await el.is_visible():
                await el.click()
                await page.wait_for_timeout(300)
                return
        except Exception:
            continue
