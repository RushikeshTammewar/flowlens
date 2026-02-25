"""Main scanner: orchestrates the QA agent for each viewport.

Uses the unified QAAgent that discovers pages AND tests flows in a single
pass. No more two-phase architecture -- every interaction IS a test.
"""

from __future__ import annotations

import hashlib
from datetime import datetime
from playwright.async_api import async_playwright

from agent.core.qa_agent import QAAgent
from agent.models.graph import SiteGraph, ProgressCallback
from agent.models.types import CrawlResult, BugFinding, PageMetrics


VIEWPORTS = {
    "desktop": {"width": 1920, "height": 1080},
    "mobile": {"width": 375, "height": 812},
}


class FlowLensScanner:
    """End-to-end scanner using the unified QA agent."""

    def __init__(
        self,
        url: str,
        max_pages: int = 20,
        viewports: list[str] | None = None,
        on_progress: ProgressCallback | None = None,
        headful: bool = False,
        auth_cookie_event: object | None = None,
        auth_cookie_store: dict | None = None,
        scan_id: str | None = None,
    ):
        self.url = url
        self.max_pages = max_pages
        self.viewports = viewports or ["desktop", "mobile"]
        self.result = CrawlResult(url=url)
        self.screenshots: dict[str, str] = {}
        self._graph: SiteGraph | None = None
        self._on_progress = on_progress
        self._headful = headful
        self._auth_cookie_event = auth_cookie_event
        self._auth_cookie_store = auth_cookie_store or {}
        self._scan_id = scan_id

    async def scan(self) -> CrawlResult:
        self.result.started_at = datetime.now()

        async with async_playwright() as pw:
            browser = await pw.chromium.launch(headless=not self._headful)

            for viewport_name in self.viewports:
                viewport_config = VIEWPORTS.get(viewport_name, VIEWPORTS["desktop"])
                ctx = await browser.new_context(
                    viewport=viewport_config,
                    user_agent=_user_agent(viewport_name),
                )
                page = await ctx.new_page()

                # Apply stealth to avoid bot detection
                try:
                    from playwright_stealth import stealth_async
                    await stealth_async(page)
                except ImportError:
                    pass

                agent = QAAgent(
                    base_url=self.url,
                    max_pages=self.max_pages,
                    on_progress=self._on_progress,
                    playwright_instance=pw if self._headful else None,
                    browser_context=ctx,
                    auth_cookie_event=self._auth_cookie_event,
                    auth_cookie_store=self._auth_cookie_store,
                    scan_id=self._scan_id,
                )

                try:
                    state = await agent.run(page, viewport=viewport_name)
                except Exception as e:
                    if self._on_progress:
                        self._on_progress("scan_error", {"error": str(e)[:300], "viewport": viewport_name})
                    self.result.errors.append(f"{viewport_name}: {str(e)[:300]}")
                    await ctx.close()
                    continue

                if self._graph is None:
                    self._graph = state.graph

                # Collect flow results (desktop only to avoid duplicates)
                if viewport_name == "desktop" and state.completed_flows:
                    self.result.flows = state.completed_flows

                # Extract results from graph nodes
                for node in state.graph.nodes.values():
                    if node.status != "visited":
                        continue

                    url = node.url
                    if url not in self.result.pages_visited:
                        self.result.pages_visited.append(url)

                    for bug in node.bugs:
                        bug.viewport = viewport_name
                        bug.evidence["page_title"] = node.title
                        screenshot_key = f"{_url_hash(url)}_{viewport_name}"
                        bug.evidence["screenshot_key"] = screenshot_key
                        if not bug.description:
                            bug.description = _generate_description(bug, node.title, viewport_name)
                        bug.evidence["repro_steps"] = _generate_repro_steps(bug, url, viewport_name)
                        self.result.bugs.append(bug)

                    if node.metrics:
                        self.result.metrics.append(node.metrics)

                    if node.screenshot_b64:
                        key = f"{_url_hash(url)}_{viewport_name}"
                        self.screenshots[key] = node.screenshot_b64

                await ctx.close()

            await browser.close()

        self.result.pages_tested = len(self.result.pages_visited)
        self.result.completed_at = datetime.now()
        self.result.bugs = _deduplicate(self.result.bugs)
        self.result.health_score = _calculate_health_score(self.result)
        return self.result

    def get_screenshots(self) -> dict[str, str]:
        return self.screenshots

    def get_site_graph(self) -> dict:
        if not self._graph:
            return {"nodes": [], "edges": []}
        return self._graph.to_dict()


def _generate_description(bug: BugFinding, page_title: str, viewport: str) -> str:
    location = f'on page "{page_title}"' if page_title else f"at {bug.page_url}"
    vp = f" (tested on {viewport} viewport)"
    descs = {
        "functional": f"A functional issue was detected {location}{vp}.",
        "performance": f"Performance degradation detected {location}{vp}.",
        "responsive": f"A responsive layout issue was detected {location} on {viewport} viewport.",
        "accessibility": f"An accessibility issue was detected {location}{vp}.",
    }
    cat = bug.category.value
    if cat == "functional":
        if "status" in bug.evidence:
            return f"HTTP {bug.evidence['status']} error {location}{vp}."
        if "console_message" in bug.evidence:
            return f"JavaScript error detected {location}{vp}."
        if "image_src" in bug.evidence:
            return f"Broken image {location}{vp}."
    return descs.get(cat, f"An issue was detected {location}{vp}.")


def _generate_repro_steps(bug: BugFinding, page_url: str, viewport: str) -> list[str]:
    steps = [f"Navigate to {page_url}", f"Set viewport to {viewport}", "Wait for page to load"]
    cat = bug.category.value
    if cat == "functional":
        if "console_message" in bug.evidence:
            steps.extend(["Open DevTools Console", f"Observe: {bug.evidence['console_message'][:100]}"])
        elif "request_url" in bug.evidence:
            steps.extend(["Open DevTools Network", f"Observe failed request: {bug.evidence['request_url']}"])
    elif cat == "performance":
        steps.extend(["Open DevTools Performance", f"Observe: {bug.title}"])
    elif cat == "responsive":
        steps.extend(["Check layout on mobile", f"Observe: {bug.title}"])
    return steps


def _url_hash(url: str) -> str:
    return hashlib.md5(url.encode()).hexdigest()[:10]


def _user_agent(viewport: str) -> str:
    if viewport == "mobile":
        return "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15"
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
    penalty = {"P0": 25, "P1": 15, "P2": 8, "P3": 3, "P4": 1}
    for bug in result.bugs:
        score -= penalty.get(bug.severity.value, 1)
    return max(score, 0)
