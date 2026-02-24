"""Main scanner: orchestrates the site explorer and bug detection.

Uses SiteExplorer to navigate the site interactively (clicking links,
filling forms, expanding menus), then produces a CrawlResult for
backward compatibility with the API and frontend.
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
from datetime import datetime
from typing import Callable
from playwright.async_api import async_playwright

from agent.core.explorer import SiteExplorer
from agent.core.flow_planner import identify_flows
from agent.core.flow_runner import FlowRunner
from agent.models.graph import SiteGraph, ProgressCallback
from agent.models.types import CrawlResult, BugFinding, PageMetrics


VIEWPORTS = {
    "desktop": {"width": 1920, "height": 1080},
    "mobile": {"width": 375, "height": 812},
}


class FlowLensScanner:
    """End-to-end scanner: explores a site interactively and collects bugs."""

    def __init__(
        self,
        url: str,
        max_pages: int = 20,
        viewports: list[str] | None = None,
        on_progress: ProgressCallback | None = None,
        headful: bool = False,
    ):
        self.url = url
        self.max_pages = max_pages
        self.viewports = viewports or ["desktop", "mobile"]
        self.result = CrawlResult(url=url)
        self.screenshots: dict[str, str] = {}
        self._graph: SiteGraph | None = None
        self._on_progress = on_progress
        self._headful = headful

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

                explorer = SiteExplorer(
                    base_url=self.url,
                    max_pages=self.max_pages,
                    on_progress=self._on_progress,
                )

                graph = await explorer.explore(page, viewport=viewport_name)

                if self._graph is None:
                    self._graph = graph

                # Phase B + C: Flow identification and execution (desktop only)
                if viewport_name == "desktop" and self._graph and len(self._graph.nodes) > 0:
                    try:
                        if self._on_progress:
                            self._on_progress("flow_identification_start", {"pages": len(self._graph.nodes)})

                        flows = await identify_flows(self._graph)

                        if self._on_progress:
                            self._on_progress("flows_identified", {
                                "count": len(flows),
                                "flows": [f.name for f in flows],
                            })

                        if flows:
                            runner = FlowRunner(
                                page=page,
                                root_url=self.url,
                                graph=self._graph,
                                on_progress=self._on_progress,
                                playwright_instance=pw if self._headful else None,
                                browser_context=ctx,
                            )
                            flow_results = await runner.execute_flows(flows)
                            self.result.flows = flow_results
                    except Exception as e:
                        error_msg = f"Flow execution error: {str(e)[:300]}"
                        self.result.errors.append(error_msg)
                        if self._on_progress:
                            self._on_progress("flow_error", {"error": error_msg})

                # Extract results from graph nodes
                for node in graph.nodes.values():
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
        """Return the site graph in the format the frontend expects."""
        if not self._graph:
            return {"nodes": [], "edges": []}
        return self._graph.to_dict()


def _generate_description(bug: BugFinding, page_title: str, viewport: str) -> str:
    location = f'on page "{page_title}"' if page_title else f"at {bug.page_url}"
    viewport_text = f" (tested on {viewport} viewport)"

    if bug.category.value == "functional":
        if "status" in bug.evidence:
            return f"A network request returned HTTP {bug.evidence['status']}, indicating a server-side error {location}{viewport_text}."
        if "console_message" in bug.evidence:
            return f"A JavaScript error was detected {location}{viewport_text}. This may cause broken interactivity."
        if "image_src" in bug.evidence:
            return f"An image failed to load {location}{viewport_text}."
        return f"A functional issue was detected {location}{viewport_text}."

    if bug.category.value == "performance":
        return f"Performance degradation detected {location}{viewport_text}."

    if bug.category.value == "responsive":
        return f"A responsive layout issue was detected {location} on {viewport} viewport."

    if bug.category.value == "accessibility":
        return f"An accessibility issue was detected {location}{viewport_text}."

    return f"An issue was detected {location}{viewport_text}."


def _generate_repro_steps(bug: BugFinding, page_url: str, viewport: str) -> list[str]:
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
        steps.append("Run accessibility audit")
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
