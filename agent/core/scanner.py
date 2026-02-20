"""Main scanner: orchestrates crawling + bug detection across pages and viewports.

Follows the HLD design:
- Phase A: Discovery crawl (BFS link-following, zero AI)
- Phase B: Page-level testing with interaction (scroll, click, observe)
- Detectors run passively during navigation
- Screenshots captured per page as evidence
"""

from __future__ import annotations
import asyncio
import base64
import hashlib
import os
from datetime import datetime
from io import BytesIO
from pathlib import Path
from playwright.async_api import async_playwright, BrowserContext, Page

from agent.core.crawler import SiteCrawler
from agent.detectors.functional import FunctionalDetector
from agent.detectors.performance import PerformanceDetector
from agent.detectors.responsive import ResponsiveDetector
from agent.detectors.accessibility import AccessibilityDetector
from agent.models.types import CrawlResult, BugFinding, PageMetrics


VIEWPORTS = {
    "desktop": {"width": 1920, "height": 1080},
    "mobile": {"width": 375, "height": 812},
}


class FlowLensScanner:
    """End-to-end scanner: discovers pages, interacts with them, runs detectors, collects evidence."""

    def __init__(self, url: str, max_pages: int = 20, viewports: list[str] | None = None):
        self.url = url
        self.max_pages = max_pages
        self.viewports = viewports or ["desktop", "mobile"]
        self.result = CrawlResult(url=url)
        self.screenshots: dict[str, str] = {}
        self._site_data: dict = {}

    async def scan(self) -> CrawlResult:
        self.result.started_at = datetime.now()

        async with async_playwright() as p:
            browser = await p.chromium.launch(headless=True)

            # Phase A: Discovery crawl
            discovery_ctx = await browser.new_context(
                viewport=VIEWPORTS["desktop"],
                user_agent=_user_agent("desktop"),
            )
            discovery_page = await discovery_ctx.new_page()
            crawler = SiteCrawler(self.url, max_pages=self.max_pages)
            site_data = await crawler.discover(discovery_page)
            self._site_data = site_data
            await discovery_ctx.close()

            pages_to_test = site_data["pages"]
            self.result.pages_visited = pages_to_test
            self.result.pages_tested = len(pages_to_test)

            # Phase B: Test each page on each viewport — with interaction
            for viewport_name in self.viewports:
                viewport_config = VIEWPORTS.get(viewport_name, VIEWPORTS["desktop"])
                ctx = await browser.new_context(
                    viewport=viewport_config,
                    user_agent=_user_agent(viewport_name),
                )
                page = await ctx.new_page()

                functional = FunctionalDetector()
                performance = PerformanceDetector()
                responsive = ResponsiveDetector()
                accessibility = AccessibilityDetector()

                functional.attach_listeners(page)

                for page_url in pages_to_test:
                    functional.reset_for_page()

                    try:
                        response = await page.goto(page_url, wait_until="domcontentloaded", timeout=15000)
                        if not response:
                            continue
                        await page.wait_for_timeout(1500)

                        # Interact with the page like a human
                        await _interact_with_page(page)

                        # Capture screenshot of every page (evidence)
                        screenshot_b64 = await _capture_screenshot_b64(page)
                        key = f"{_url_hash(page_url)}_{viewport_name}"
                        if screenshot_b64:
                            self.screenshots[key] = screenshot_b64

                        # Collect metrics
                        metrics = await performance.collect_metrics(page, viewport_name)
                        self.result.metrics.append(metrics)

                        # Collect page metadata for richer bug context
                        page_title = await page.title() or ""
                        page_meta = await _get_page_meta(page)

                        # Run all detectors
                        bugs: list[BugFinding] = []
                        bugs.extend(await functional.detect(page, page_url))
                        bugs.extend(await performance.detect(page, page_url, metrics))
                        bugs.extend(await responsive.detect(page, page_url, viewport_name))

                        if viewport_name == "desktop":
                            bugs.extend(await accessibility.detect(page, page_url))

                        for bug in bugs:
                            bug.viewport = viewport_name
                            bug.evidence["page_title"] = page_title
                            bug.evidence["screenshot_key"] = key
                            if not bug.description:
                                bug.description = _generate_description(bug, page_title, viewport_name)
                            bug.evidence["repro_steps"] = _generate_repro_steps(bug, page_url, viewport_name)

                        self.result.bugs.extend(bugs)

                    except Exception as e:
                        self.result.errors.append(f"Error on {page_url} ({viewport_name}): {str(e)[:200]}")

                await ctx.close()

            await browser.close()

        self.result.completed_at = datetime.now()
        self.result.bugs = _deduplicate(self.result.bugs)
        self.result.health_score = _calculate_health_score(self.result)
        return self.result

    def get_screenshots(self) -> dict[str, str]:
        return self.screenshots

    def get_site_graph(self) -> dict:
        """Return the discovered site graph for visualization."""
        graph = self._site_data.get("graph", {})
        titles = self._site_data.get("titles", {})
        bug_pages = {}
        for bug in self.result.bugs:
            url = bug.page_url
            if url not in bug_pages:
                bug_pages[url] = {"count": 0, "max_severity": "P4"}
            bug_pages[url]["count"] += 1
            sev_order = {"P0": 0, "P1": 1, "P2": 2, "P3": 3, "P4": 4}
            if sev_order.get(bug.severity.value, 4) < sev_order.get(bug_pages[url]["max_severity"], 4):
                bug_pages[url]["max_severity"] = bug.severity.value

        nodes = []
        edges = []
        for page_url in self._site_data.get("pages", []):
            nodes.append({
                "id": page_url,
                "label": titles.get(page_url, page_url.split("/")[-1] or "/"),
                "path": "/" + "/".join(page_url.replace("https://", "").replace("http://", "").split("/")[1:]),
                "bugs": bug_pages.get(page_url, {}).get("count", 0),
                "max_severity": bug_pages.get(page_url, {}).get("max_severity"),
            })
            for linked_url in graph.get(page_url, []):
                if linked_url in self._site_data.get("pages", []):
                    edges.append({"from": page_url, "to": linked_url})

        return {"nodes": nodes, "edges": edges}


async def _interact_with_page(page: Page):
    """Simulate human interaction: scroll, observe, trigger lazy content."""
    try:
        # Scroll down to trigger lazy loading and reveal below-fold content
        for _ in range(3):
            await page.evaluate("window.scrollBy(0, window.innerHeight)")
            await page.wait_for_timeout(500)

        # Scroll back to top
        await page.evaluate("window.scrollTo(0, 0)")
        await page.wait_for_timeout(300)

        # Close common popups/modals (cookie banners, newsletter popups)
        popup_selectors = [
            'button[aria-label*="close" i]',
            'button[aria-label*="dismiss" i]',
            'button[aria-label*="accept" i]',
            '[class*="cookie"] button',
            '[class*="consent"] button',
            '[class*="popup"] button[class*="close"]',
            '[class*="modal"] button[class*="close"]',
        ]
        for selector in popup_selectors:
            try:
                el = await page.query_selector(selector)
                if el and await el.is_visible():
                    await el.click()
                    await page.wait_for_timeout(300)
                    break
            except Exception:
                continue

        # Try clicking the first few navigation links to test them
        nav_links = await page.query_selector_all('nav a[href], header a[href]')
        tested_count = 0
        for link in nav_links[:3]:
            try:
                href = await link.get_attribute("href")
                if href and not href.startswith("#") and not href.startswith("javascript"):
                    # Just hover to trigger any hover states, don't navigate away
                    await link.hover()
                    await page.wait_for_timeout(200)
                    tested_count += 1
            except Exception:
                continue

    except Exception:
        pass


async def _capture_screenshot_b64(page: Page) -> str | None:
    """Capture page screenshot as base64 string."""
    try:
        buffer = await page.screenshot(full_page=False, type="jpeg", quality=70)
        return base64.b64encode(buffer).decode("utf-8")
    except Exception:
        return None


async def _get_page_meta(page: Page) -> dict:
    """Extract useful page metadata."""
    try:
        return await page.evaluate("""() => ({
            title: document.title || '',
            description: document.querySelector('meta[name="description"]')?.content || '',
            h1: document.querySelector('h1')?.textContent?.trim()?.substring(0, 100) || '',
            linkCount: document.querySelectorAll('a').length,
            imageCount: document.images.length,
            formCount: document.forms.length,
            buttonCount: document.querySelectorAll('button').length,
            inputCount: document.querySelectorAll('input, select, textarea').length,
        })""")
    except Exception:
        return {}


def _generate_description(bug: BugFinding, page_title: str, viewport: str) -> str:
    """Generate a human-readable description for a bug."""
    location = f'on page "{page_title}"' if page_title else f"at {bug.page_url}"
    viewport_text = f" (tested on {viewport} viewport)"

    if bug.category.value == "functional":
        if "status" in bug.evidence:
            return f"A network request returned HTTP {bug.evidence['status']}, indicating a server-side error {location}{viewport_text}. This may cause broken functionality or missing content for users."
        if "console_message" in bug.evidence:
            return f"A JavaScript error was detected {location}{viewport_text}. This may cause broken interactivity or visible errors for users."
        if "image_src" in bug.evidence:
            return f"An image failed to load {location}{viewport_text}. Users will see a broken image placeholder."
        return f"A functional issue was detected {location}{viewport_text}."

    if bug.category.value == "performance":
        return f"Performance degradation detected {location}{viewport_text}. Slow page loads directly impact user engagement and conversion rates."

    if bug.category.value == "responsive":
        return f"A responsive layout issue was detected {location} on {viewport} viewport. This affects the mobile/tablet user experience."

    if bug.category.value == "accessibility":
        return f"An accessibility issue was detected {location}{viewport_text}. This may prevent users with disabilities from using your site effectively."

    return f"An issue was detected {location}{viewport_text}."


def _generate_repro_steps(bug: BugFinding, page_url: str, viewport: str) -> list[str]:
    """Generate reproduction steps for a bug."""
    steps = [
        f"Navigate to {page_url}",
        f"Set viewport to {viewport}" + (" (375x812)" if viewport == "mobile" else " (1920x1080)"),
        "Wait for page to fully load",
    ]

    if bug.category.value == "functional":
        if "console_message" in bug.evidence:
            steps.append("Open browser DevTools → Console tab")
            steps.append(f"Observe JavaScript error: {bug.evidence['console_message'][:100]}")
        elif "request_url" in bug.evidence:
            steps.append("Open browser DevTools → Network tab")
            steps.append(f"Observe failed request: {bug.evidence['request_url']}")
        elif "image_src" in bug.evidence:
            steps.append(f"Locate image with src: {bug.evidence['image_src'][:100]}")
            steps.append("Observe that the image fails to load")
    elif bug.category.value == "performance":
        steps.append("Open browser DevTools → Performance tab")
        steps.append(f"Observe: {bug.title}")
    elif bug.category.value == "responsive":
        steps.append("Scroll through the page on mobile viewport")
        steps.append(f"Observe: {bug.title}")
    elif bug.category.value == "accessibility":
        steps.append("Run accessibility audit (DevTools → Lighthouse or axe)")
        steps.append(f"Observe: {bug.title}")

    return steps


def _url_hash(url: str) -> str:
    return hashlib.md5(url.encode()).hexdigest()[:10]


def _user_agent(viewport: str) -> str:
    if viewport == "mobile":
        return "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"
    return "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"


def _deduplicate(bugs: list[BugFinding]) -> list[BugFinding]:
    seen = set()
    unique = []
    for bug in bugs:
        key = (bug.title, bug.page_url, bug.viewport)
        if key not in seen:
            seen.add(key)
            unique.append(bug)
    return unique


def _calculate_health_score(result: CrawlResult) -> int:
    score = 100
    severity_penalty = {"P0": 25, "P1": 15, "P2": 8, "P3": 3, "P4": 1}
    for bug in result.bugs:
        score -= severity_penalty.get(bug.severity.value, 1)
    return max(score, 0)
