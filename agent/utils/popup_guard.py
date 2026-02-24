"""Mid-flow popup and overlay dismissal.

Runs before every flow step to ensure the page is interactable.
Handles cookie banners, newsletter modals, chat widgets, GDPR dialogs,
login prompts, and generic modals.
"""

from __future__ import annotations

from playwright.async_api import Page


_DETECT_OVERLAYS_JS = """() => {
    const overlays = [];

    // Check for full-screen or large overlays
    const candidates = document.querySelectorAll(
        '[class*="overlay"], [class*="modal"], [class*="popup"], [class*="dialog"], ' +
        '[class*="cookie"], [class*="consent"], [class*="banner"], [class*="gdpr"], ' +
        '[class*="newsletter"], [role="dialog"], [role="alertdialog"], ' +
        '[class*="chat-widget"], [class*="intercom"], [class*="drift"]'
    );

    for (const el of candidates) {
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') continue;

        const rect = el.getBoundingClientRect();
        if (rect.width < 50 || rect.height < 50) continue;

        // Find close/dismiss/accept buttons inside
        const buttons = el.querySelectorAll(
            'button, [role="button"], a[class*="close"], [class*="dismiss"], [class*="accept"]'
        );
        const closeButtons = [];
        for (const btn of buttons) {
            const text = (btn.textContent || btn.getAttribute('aria-label') || '').toLowerCase().trim();
            const cls = (btn.className || '').toLowerCase();
            const isClose = text.includes('close') || text.includes('dismiss') || text.includes('accept') ||
                           text.includes('got it') || text.includes('ok') || text.includes('agree') ||
                           text.includes('reject') || text.includes('no thanks') || text.includes('deny') ||
                           text.includes('continue') || text.includes('×') || text === 'x' ||
                           cls.includes('close') || cls.includes('dismiss') || cls.includes('accept');
            if (isClose) {
                let selector = '';
                if (btn.id) selector = '#' + CSS.escape(btn.id);
                else if (btn.getAttribute('data-testid')) selector = `[data-testid="${btn.getAttribute('data-testid')}"]`;
                else {
                    const parent = btn.parentElement;
                    if (parent) {
                        const siblings = [...parent.children].filter(c => c.tagName === btn.tagName);
                        const idx = siblings.indexOf(btn) + 1;
                        selector = `${btn.tagName.toLowerCase()}:nth-of-type(${idx})`;
                    }
                }
                closeButtons.push({selector, text: text.substring(0, 50)});
            }
        }

        const className = (el.className || '').toLowerCase();
        let overlayType = 'generic';
        if (className.includes('cookie') || className.includes('consent') || className.includes('gdpr')) overlayType = 'cookie';
        else if (className.includes('modal') || className.includes('dialog')) overlayType = 'modal';
        else if (className.includes('newsletter') || className.includes('subscribe')) overlayType = 'newsletter';
        else if (className.includes('chat') || className.includes('intercom') || className.includes('drift')) overlayType = 'chat';
        else if (className.includes('popup') || className.includes('banner')) overlayType = 'popup';

        if (closeButtons.length > 0) {
            overlays.push({type: overlayType, closeButtons});
        }
    }

    return overlays;
}"""


async def dismiss_overlays(page: Page) -> list[str]:
    """Detect and dismiss any visible overlays/modals/banners.

    Returns list of overlay types that were dismissed.
    """
    dismissed = []

    try:
        overlays = await page.evaluate(_DETECT_OVERLAYS_JS)
    except Exception:
        return dismissed

    for overlay in overlays:
        for btn_info in overlay.get("closeButtons", []):
            try:
                sel = btn_info.get("selector", "")
                if not sel:
                    continue
                btn = await page.query_selector(sel)
                if btn and await btn.is_visible():
                    await btn.click()
                    await page.wait_for_timeout(300)
                    dismissed.append(overlay.get("type", "generic"))
                    break
            except Exception:
                continue

    # Fallback: try common close button patterns globally
    if not dismissed:
        fallback_selectors = [
            'button[aria-label*="close" i]',
            'button[aria-label*="accept" i]',
            'button[aria-label*="dismiss" i]',
            '[id*="cookie"] button',
            '[id*="consent"] button',
        ]
        for sel in fallback_selectors:
            try:
                el = await page.query_selector(sel)
                if el and await el.is_visible():
                    await el.click()
                    await page.wait_for_timeout(300)
                    dismissed.append("fallback")
                    break
            except Exception:
                continue

    return dismissed
