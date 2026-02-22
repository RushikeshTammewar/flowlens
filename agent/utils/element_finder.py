"""Heuristic element finder by text description.

6-priority chain for locating interactive elements. Returns None when
heuristics fail so the caller can use AI fallback.
"""

from __future__ import annotations

import re
from playwright.async_api import Page, ElementHandle


def _extract_keywords(description: str) -> list[str]:
    """Extract searchable keywords from a target description."""
    # Normalize: lowercase, split on non-alphanumeric
    words = re.findall(r"[a-zA-Z0-9]+", description.lower())
    # Filter trivial words
    stop = {"the", "a", "an", "to", "on", "in", "at", "for", "of", "and", "or", "button", "link", "form"}
    return [w for w in words if len(w) > 1 and w not in stop]


async def find_element(page: Page, target_description: str) -> ElementHandle | None:
    """Find an element by text description using a 6-priority heuristic chain.

    Returns the first matching visible element, or None if not found.
    Caller should use AI fallback when None is returned.

    Special handling for:
    - "first X" -> finds first matching element of type X
    - "any X" -> finds any visible element of type X
    - content types: article, product, post, item, link, button
    """
    desc_lower = target_description.lower()

    # Handle "first X" or "any X" patterns for common content types
    if "first" in desc_lower or "any" in desc_lower:
        # Content type selectors
        content_selectors = {
            "article": "article, [role='article'], .article, .post",
            "product": ".product, [data-product], .item, [itemprop='product']",
            "post": ".post, article, [role='article']",
            "item": ".item, li, .list-item, [role='listitem']",
            "result": ".result, .search-result, [role='listitem']",
            "link": "a[href]",
            "button": "button, [role='button'], input[type='button'], input[type='submit']",
            "card": ".card, [role='article'], .item",
            "category": ".category, [data-category], nav a",
        }

        for content_type, selector in content_selectors.items():
            if content_type in desc_lower:
                try:
                    elements = await page.query_selector_all(selector)
                    for el in elements:
                        if await el.is_visible():
                            return el
                except Exception:
                    pass

    keywords = _extract_keywords(target_description)
    if not keywords:
        return None

    # Use the longest/most specific keyword for matching
    primary = max(keywords, key=len)

    # Priority 1: data-testid
    try:
        el = await page.query_selector(f'[data-testid*="{primary}" i]')
        if el and await el.is_visible():
            return el
    except Exception:
        pass

    # Priority 2: aria-label
    try:
        el = await page.query_selector(f'[aria-label*="{primary}" i]')
        if el and await el.is_visible():
            return el
    except Exception:
        pass

    # Priority 3: visible text (buttons, links)
    try:
        locator = page.get_by_text(primary, exact=False).first
        el = await locator.element_handle()
        if el and await el.is_visible():
            return el
    except Exception:
        pass

    # Priority 4: name/placeholder
    try:
        el = await page.query_selector(f'[name*="{primary}" i], [placeholder*="{primary}" i]')
        if el and await el.is_visible():
            return el
    except Exception:
        pass

    # Priority 5: role (button, link)
    for role in ("button", "link", "menuitem", "tab"):
        try:
            locator = page.get_by_role(role, name=re.compile(re.escape(primary), re.I)).first
            el = await locator.element_handle()
            if el and await el.is_visible():
                return el
        except Exception:
            pass

    # Priority 6: try full description as text
    if len(target_description) > 3:
        try:
            locator = page.get_by_text(target_description[:50], exact=False).first
            el = await locator.element_handle()
            if el and await el.is_visible():
                return el
        except Exception:
            pass

    return None


async def find_form(page: Page, form_description: str) -> str | None:
    """Find a form by description. Returns a CSS selector or None."""
    keywords = _extract_keywords(form_description)
    if not keywords:
        return None

    primary = max(keywords, key=len)

    # Try form with id/name
    el = await page.query_selector(f'form[id*="{primary}" i], form[name*="{primary}" i]')
    if el and await el.is_visible():
        return "form"

    # Try form containing input with matching name/placeholder
    el = await page.query_selector(f'form:has([name*="{primary}" i]), form:has([placeholder*="{primary}" i])')
    if el and await el.is_visible():
        return "form"

    # Fallback: first visible form
    el = await page.query_selector("form")
    if el and await el.is_visible():
        return "form"

    return None
