"""Main scanner: orchestrates crawling + bug detection across pages and viewports."""

from __future__ import annotations
import asyncio
import os
from datetime import datetime
from pathlib import Path
from playwright.async_api import async_playwright, BrowserContext

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
    """End-to-end scanner: discovers pages, runs all detectors, collects evidence."""

    def __init__(self, url: str, max_pages: int = 20, viewports: list[str] | None = None):
        self.url = url
        self.max_pages = max_pages
        self.viewports = viewports or ["desktop", "mobile"]
        self.result = CrawlResult(url=url)

    async def scan(self) -> CrawlResult:
        """Run a full scan: discover pages, then test each page on each viewport."""
        self.result.started_at = datetime.now()

        async with async_playwright() as p:
            browser = await p.chromium.launch(headless=True)

            # Phase A: Discovery crawl (desktop viewport)
            discovery_ctx = await browser.new_context(
                viewport=VIEWPORTS["desktop"],
                user_agent="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            )
            discovery_page = await discovery_ctx.new_page()
            crawler = SiteCrawler(self.url, max_pages=self.max_pages)
            site_data = await crawler.discover(discovery_page)
            await discovery_ctx.close()

            pages_to_test = site_data["pages"]
            self.result.pages_visited = pages_to_test
            self.result.pages_tested = len(pages_to_test)

            # Phase B: Test each page on each viewport
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

                        # Collect metrics
                        metrics = await performance.collect_metrics(page, viewport_name)
                        self.result.metrics.append(metrics)

                        # Run all detectors
                        bugs = []
                        bugs.extend(await functional.detect(page, page_url))
                        bugs.extend(await performance.detect(page, page_url, metrics))
                        bugs.extend(await responsive.detect(page, page_url, viewport_name))

                        if viewport_name == "desktop":
                            bugs.extend(await accessibility.detect(page, page_url))

                        for bug in bugs:
                            bug.viewport = viewport_name

                        self.result.bugs.extend(bugs)

                        # Take screenshot if bugs found on this page
                        if bugs:
                            await _save_screenshot(page, page_url, viewport_name)

                    except Exception as e:
                        self.result.errors.append(f"Error on {page_url} ({viewport_name}): {str(e)[:200]}")

                await ctx.close()

            await browser.close()

        self.result.completed_at = datetime.now()
        self.result.bugs = _deduplicate(self.result.bugs)
        self.result.health_score = _calculate_health_score(self.result)
        return self.result


def _user_agent(viewport: str) -> str:
    if viewport == "mobile":
        return "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"
    return "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"


async def _save_screenshot(page, page_url: str, viewport: str):
    """Save a screenshot for evidence."""
    screenshots_dir = Path("screenshots")
    screenshots_dir.mkdir(exist_ok=True)
    safe_name = page_url.replace("https://", "").replace("http://", "").replace("/", "_")[:60]
    path = screenshots_dir / f"{safe_name}_{viewport}.png"
    try:
        await page.screenshot(path=str(path), full_page=False)
    except Exception:
        pass


def _deduplicate(bugs: list[BugFinding]) -> list[BugFinding]:
    """Remove duplicate bugs (same title + page + viewport)."""
    seen = set()
    unique = []
    for bug in bugs:
        key = (bug.title, bug.page_url, bug.viewport)
        if key not in seen:
            seen.add(key)
            unique.append(bug)
    return unique


def _calculate_health_score(result: CrawlResult) -> int:
    """Simple health score: start at 100, deduct for bugs by severity."""
    score = 100
    severity_penalty = {"P0": 25, "P1": 15, "P2": 8, "P3": 3, "P4": 1}
    for bug in result.bugs:
        score -= severity_penalty.get(bug.severity.value, 1)
    return max(score, 0)
