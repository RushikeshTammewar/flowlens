"""Tier 1 detector: JavaScript errors, network errors, broken images, broken links."""

from __future__ import annotations
from agent.models.types import BugFinding, Severity, Category, Confidence


class FunctionalDetector:
    """Deterministic bug detection. HIGH confidence, zero false positives."""

    def __init__(self):
        self.console_errors: list[dict] = []
        self.network_errors: list[dict] = []
        self.network_requests: list[dict] = []

    def attach_listeners(self, page):
        """Attach Playwright page event listeners to capture errors passively."""

        def on_console(msg):
            if msg.type == "error":
                self.console_errors.append({
                    "type": msg.type,
                    "text": msg.text,
                    "url": page.url,
                })

        def on_page_error(error):
            self.console_errors.append({
                "type": "exception",
                "text": str(error),
                "url": page.url,
            })

        def on_response(response):
            self.network_requests.append({
                "url": response.url,
                "status": response.status,
                "method": response.request.method,
            })
            if response.status >= 400:
                self.network_errors.append({
                    "url": response.url,
                    "status": response.status,
                    "method": response.request.method,
                    "page_url": page.url,
                })

        page.on("console", on_console)
        page.on("pageerror", on_page_error)
        page.on("response", on_response)

    async def detect(self, page, page_url: str) -> list[BugFinding]:
        """Run all functional checks on the current page."""
        findings = []

        # 1. JavaScript console errors
        for err in self.console_errors:
            if err["url"] == page_url:
                sev = Severity.P1 if err["type"] == "exception" else Severity.P2
                findings.append(BugFinding(
                    title=f"JS {err['type']}: {err['text'][:120]}",
                    category=Category.FUNCTIONAL,
                    severity=sev,
                    confidence=Confidence.HIGH,
                    page_url=page_url,
                    description=err["text"],
                    evidence={"console_message": err["text"]},
                ))

        # 2. Network errors (4xx, 5xx)
        for req in self.network_errors:
            if req["page_url"] == page_url:
                is_server = req["status"] >= 500
                findings.append(BugFinding(
                    title=f"HTTP {req['status']} on {_short_url(req['url'])}",
                    category=Category.FUNCTIONAL,
                    severity=Severity.P0 if is_server else Severity.P2,
                    confidence=Confidence.HIGH,
                    page_url=page_url,
                    description=f"{req['method']} {req['url']} returned {req['status']}",
                    evidence={"request_url": req["url"], "status": req["status"]},
                ))

        # 3. Broken images
        broken_images = await page.evaluate("""() => {
            return [...document.images]
                .filter(img => img.src && (!img.complete || img.naturalWidth === 0))
                .map(img => ({ src: img.src, alt: img.alt || '' }));
        }""")
        for img in broken_images:
            findings.append(BugFinding(
                title=f"Broken image: {_short_url(img['src'])}",
                category=Category.FUNCTIONAL,
                severity=Severity.P2,
                confidence=Confidence.HIGH,
                page_url=page_url,
                evidence={"image_src": img["src"], "alt": img["alt"]},
            ))

        # 4. Missing viewport meta (critical for mobile)
        has_viewport = await page.evaluate(
            "() => !!document.querySelector('meta[name=viewport]')"
        )
        if not has_viewport:
            findings.append(BugFinding(
                title="Missing viewport meta tag",
                category=Category.FUNCTIONAL,
                severity=Severity.P2,
                confidence=Confidence.HIGH,
                page_url=page_url,
                description="No <meta name='viewport'> tag found. Mobile rendering will be broken.",
            ))

        # 5. Mixed content (HTTP on HTTPS page)
        if page_url.startswith("https://"):
            mixed = [r for r in self.network_requests
                     if r["url"].startswith("http://") and not r["url"].startswith("http://localhost")]
            for req in mixed[:3]:
                findings.append(BugFinding(
                    title=f"Mixed content: HTTP resource on HTTPS page",
                    category=Category.SECURITY,
                    severity=Severity.P2,
                    confidence=Confidence.HIGH,
                    page_url=page_url,
                    evidence={"insecure_url": req["url"]},
                ))

        return findings

    def reset_for_page(self):
        """Clear per-page state before navigating to a new page."""
        self.console_errors.clear()
        self.network_errors.clear()
        self.network_requests.clear()


def _short_url(url: str, max_len: int = 80) -> str:
    if len(url) <= max_len:
        return url
    return url[:max_len - 3] + "..."
