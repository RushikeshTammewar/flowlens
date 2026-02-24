"""Condition-based waiting that replaces fixed timeouts.

Detects spinners, skeleton screens, pending XHR, unstable DOM, and
unloaded images. Falls back to a fixed timeout if condition-based
waiting times out, so callers never hang indefinitely.
"""

from __future__ import annotations

from playwright.async_api import Page


_STABLE_PAGE_JS = """() => {
    // 1. No visible spinners / skeleton screens / loading indicators
    const loadingSelectors = [
        '.spinner', '.loading', '[class*="skeleton"]', '[class*="shimmer"]',
        '[class*="loader"]', '[aria-busy="true"]', '[class*="progress"]',
        '.placeholder', '[class*="loading"]', '[class*="spin"]',
    ];
    for (const sel of loadingSelectors) {
        try {
            const els = document.querySelectorAll(sel);
            for (const el of els) {
                const r = el.getBoundingClientRect();
                if (r.width > 0 && r.height > 0) {
                    const style = window.getComputedStyle(el);
                    if (style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0') {
                        return false;
                    }
                }
            }
        } catch {}
    }

    // 2. All images either loaded or errored (no pending)
    const imgs = document.querySelectorAll('img[src]');
    for (const img of imgs) {
        const r = img.getBoundingClientRect();
        if (r.width > 0 && r.height > 0 && !img.complete) {
            return false;
        }
    }

    // 3. No active fetch/XHR (tracked via monkey-patch below)
    if (window.__flowlens_pending_requests > 0) {
        return false;
    }

    return true;
}"""


_INSTALL_REQUEST_TRACKER_JS = """() => {
    if (window.__flowlens_request_tracker_installed) return;
    window.__flowlens_pending_requests = 0;
    window.__flowlens_request_tracker_installed = true;

    const origFetch = window.fetch;
    window.fetch = function(...args) {
        window.__flowlens_pending_requests++;
        return origFetch.apply(this, args).finally(() => {
            window.__flowlens_pending_requests = Math.max(0, window.__flowlens_pending_requests - 1);
        });
    };

    const origOpen = XMLHttpRequest.prototype.open;
    const origSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function(...args) {
        this.__flowlens_tracked = true;
        return origOpen.apply(this, args);
    };
    XMLHttpRequest.prototype.send = function(...args) {
        if (this.__flowlens_tracked) {
            window.__flowlens_pending_requests++;
            this.addEventListener('loadend', () => {
                window.__flowlens_pending_requests = Math.max(0, window.__flowlens_pending_requests - 1);
            }, {once: true});
        }
        return origSend.apply(this, args);
    };
}"""


async def install_request_tracker(page: Page):
    """Install the XHR/fetch tracker on a page. Call once after navigation."""
    try:
        await page.evaluate(_INSTALL_REQUEST_TRACKER_JS)
    except Exception:
        pass


async def wait_for_stable_page(page: Page, timeout_ms: int = 10000, poll_ms: int = 300):
    """Wait until the page is visually and network-stable.

    Checks: no spinners, no skeleton screens, images loaded, no pending XHR.
    Falls back to a short fixed wait if the condition never stabilizes.
    """
    try:
        await page.wait_for_function(_STABLE_PAGE_JS, timeout=timeout_ms)
    except Exception:
        await page.wait_for_timeout(min(1500, timeout_ms))


async def wait_for_navigation_or_dom_change(page: Page, timeout_ms: int = 5000):
    """Wait for either a URL change or significant DOM mutation."""
    try:
        await page.wait_for_function("""(startUrl) => {
            return window.location.href !== startUrl ||
                   (window.__flowlens_mutations && window.__flowlens_mutations > 10);
        }""", arg=page.url, timeout=timeout_ms)
    except Exception:
        await page.wait_for_timeout(min(1000, timeout_ms))


async def wait_for_element(page: Page, selector: str, timeout_ms: int = 5000) -> bool:
    """Wait for a specific element to appear and be visible."""
    try:
        await page.wait_for_selector(selector, state="visible", timeout=timeout_ms)
        return True
    except Exception:
        return False
