"""Tier 1 detector: JavaScript errors, broken images, missing viewport, mixed content.

v2: uses execute_javascript (CDP) instead of Playwright page events.
Error tracking is injected via JS and collected before detection runs.
"""

from __future__ import annotations

from typing import Any, Callable, Awaitable

from agent.models.types import BugFinding, Severity, Category, Confidence

ExecuteJS = Callable[[str], Awaitable[Any]]

_INJECT_ERROR_TRACKING = """(() => {
    if (window.__flowlens_attached) return;
    window.__flowlens_attached = true;
    window.__flowlens_console_errors = [];
    window.__flowlens_js_errors = [];

    const _origError = console.error;
    console.error = function() {
        window.__flowlens_console_errors.push({
            text: Array.from(arguments).map(String).join(' '),
            ts: Date.now()
        });
        _origError.apply(console, arguments);
    };

    window.addEventListener('error', function(e) {
        window.__flowlens_js_errors.push({
            message: e.message || '',
            filename: e.filename || '',
            lineno: e.lineno || 0
        });
    });

    window.addEventListener('unhandledrejection', function(e) {
        window.__flowlens_js_errors.push({
            message: 'Unhandled promise rejection: ' + (e.reason || ''),
            filename: '',
            lineno: 0
        });
    });
})()"""

_COLLECT_ERRORS = """(() => {
    return {
        console_errors: (window.__flowlens_console_errors || []).slice(-20),
        js_errors: (window.__flowlens_js_errors || []).slice(-20)
    };
})()"""

_BROKEN_IMAGES = """(() => {
    return [...document.images]
        .filter(img => img.src && (!img.complete || img.naturalWidth === 0))
        .map(img => ({ src: img.src, alt: img.alt || '' }));
})()"""

_HAS_VIEWPORT = "!!document.querySelector('meta[name=viewport]')"

_FAILED_RESOURCES = """(() => {
    try {
        return performance.getEntriesByType('resource')
            .filter(r => r.responseStatus && r.responseStatus >= 400)
            .map(r => ({url: r.name, status: r.responseStatus}))
            .slice(0, 10);
    } catch { return []; }
})()"""

_DEAD_LINKS = """(() => {
    const dead = [];
    const anchors = document.querySelectorAll('a[href]');
    for (const a of anchors) {
        try {
            const href = a.href;
            if (!href || href.startsWith('javascript:') || href.startsWith('mailto:') || href.startsWith('tel:')) continue;
            if (href.includes('#') && !href.split('#')[1]) continue;
            const hashTarget = href.split('#')[1];
            if (hashTarget && href.startsWith(location.origin)) {
                if (!document.getElementById(hashTarget) && !document.querySelector('[name="' + CSS.escape(hashTarget) + '"]')) {
                    dead.push({ href: href.substring(0, 150), text: (a.textContent || '').trim().substring(0, 60), type: 'broken_anchor' });
                }
            }
        } catch {}
    }
    return dead.slice(0, 10);
})()"""

_EMPTY_LINKS = """(() => {
    return [...document.querySelectorAll('a')]
        .filter(a => {
            const text = (a.textContent || '').trim();
            const img = a.querySelector('img, svg');
            const aria = a.getAttribute('aria-label');
            return !text && !img && !aria && a.offsetParent !== null;
        })
        .map(a => ({ href: (a.href || '').substring(0, 100) }))
        .slice(0, 10);
})()"""


class FunctionalDetector:
    """Deterministic bug detection via JS evaluation. HIGH confidence."""

    async def inject_tracking(self, execute_js: ExecuteJS):
        """Inject error-capturing script. Call after each navigation."""
        try:
            await execute_js(_INJECT_ERROR_TRACKING)
        except Exception:
            pass

    async def detect(self, execute_js: ExecuteJS, page_url: str) -> list[BugFinding]:
        findings: list[BugFinding] = []

        errors = await execute_js(_COLLECT_ERRORS)
        if isinstance(errors, dict):
            for err in errors.get("console_errors", []):
                findings.append(BugFinding(
                    title=f"JS console.error: {str(err.get('text', ''))[:120]}",
                    category=Category.FUNCTIONAL,
                    severity=Severity.P2,
                    confidence=Confidence.HIGH,
                    page_url=page_url,
                    description=str(err.get("text", "")),
                    evidence={"console_message": str(err.get("text", ""))},
                ))
            for err in errors.get("js_errors", []):
                findings.append(BugFinding(
                    title=f"JS exception: {str(err.get('message', ''))[:120]}",
                    category=Category.FUNCTIONAL,
                    severity=Severity.P1,
                    confidence=Confidence.HIGH,
                    page_url=page_url,
                    description=f"{err.get('message', '')} at {err.get('filename', '')}:{err.get('lineno', '')}",
                    evidence={"error_message": str(err.get("message", ""))},
                ))

        broken = await execute_js(_BROKEN_IMAGES)
        if isinstance(broken, list):
            for img in broken:
                findings.append(BugFinding(
                    title=f"Broken image: {_short(img.get('src', ''))}",
                    category=Category.FUNCTIONAL,
                    severity=Severity.P2,
                    confidence=Confidence.HIGH,
                    page_url=page_url,
                    evidence={"image_src": img.get("src", ""), "alt": img.get("alt", "")},
                ))

        has_viewport = await execute_js(_HAS_VIEWPORT)
        if has_viewport is False:
            findings.append(BugFinding(
                title="Missing viewport meta tag",
                category=Category.FUNCTIONAL,
                severity=Severity.P2,
                confidence=Confidence.HIGH,
                page_url=page_url,
                description="No <meta name='viewport'> tag. Mobile rendering will be broken.",
            ))

        failed_res = await execute_js(_FAILED_RESOURCES)
        if isinstance(failed_res, list):
            for req in failed_res:
                status = req.get("status", 0)
                is_server = status >= 500
                findings.append(BugFinding(
                    title=f"HTTP {status} on {_short(req.get('url', ''))}",
                    category=Category.FUNCTIONAL,
                    severity=Severity.P0 if is_server else Severity.P2,
                    confidence=Confidence.HIGH,
                    page_url=page_url,
                    evidence={"request_url": req.get("url", ""), "status": status},
                ))

        dead_links = await execute_js(_DEAD_LINKS)
        if isinstance(dead_links, list):
            for link in dead_links:
                findings.append(BugFinding(
                    title=f"Broken anchor: {_short(link.get('text', '') or link.get('href', ''))}",
                    category=Category.FUNCTIONAL,
                    severity=Severity.P3,
                    confidence=Confidence.HIGH,
                    page_url=page_url,
                    description=f"Link points to #{link.get('href', '').split('#')[-1]} which doesn't exist on the page.",
                    evidence={"href": link.get("href", ""), "text": link.get("text", "")},
                ))

        empty_links = await execute_js(_EMPTY_LINKS)
        if isinstance(empty_links, list) and len(empty_links) > 0:
            findings.append(BugFinding(
                title=f"{len(empty_links)} links with no accessible text",
                category=Category.FUNCTIONAL,
                severity=Severity.P3,
                confidence=Confidence.MEDIUM,
                page_url=page_url,
                description="Links without text, images, or aria-labels are inaccessible and confusing.",
                evidence={"count": len(empty_links), "examples": empty_links[:5]},
            ))

        return findings


def _short(url: str, max_len: int = 80) -> str:
    return url if len(url) <= max_len else url[:max_len - 3] + "..."
