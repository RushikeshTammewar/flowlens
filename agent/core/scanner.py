"""Scanner v2: orchestrates QAAgent with Browser-Use powered navigation.

Browser-Use manages the browser (Chrome via CDP). The scanner creates
a NavigationEngine, passes it to QAAgent, and aggregates results.
"""

from __future__ import annotations

import hashlib
from datetime import datetime

from agent.core.navigation_engine import NavigationEngine, ProgressCallback
from agent.core.qa_agent import QAAgent
from agent.models.graph import SiteGraph
from agent.models.types import CrawlResult, BugFinding, PageMetrics


VIEWPORTS = {
    "desktop": {"width": 1920, "height": 1080},
    "mobile": {"width": 375, "height": 812},
}


class FlowLensScanner:
    """End-to-end scanner using Browser-Use powered QA agent."""

    def __init__(
        self,
        url: str,
        max_pages: int = 20,
        viewports: list[str] | None = None,
        on_progress: ProgressCallback | None = None,
        headless: bool = True,
        headful: bool = False,
        storage_state: str | None = None,
        user_data_dir: str | None = None,
        sensitive_data: dict | None = None,
        # Legacy params (kept for backend compat, ignored)
        auth_cookie_event: object | None = None,
        auth_cookie_store: dict | None = None,
        scan_id: str | None = None,
    ):
        self.url = url
        self.max_pages = max_pages
        self.viewports = viewports or ["desktop"]
        self.result = CrawlResult(url=url)
        self.screenshots: dict[str, str] = {}
        self._graph: SiteGraph | None = None
        self._on_progress = on_progress
        self._headless = headless and not headful
        self._storage_state = storage_state
        self._user_data_dir = user_data_dir
        self._sensitive_data = sensitive_data

    async def scan(self) -> CrawlResult:
        self.result.started_at = datetime.now()
        self._log("debug", f"Starting scan for {self.url}")

        nav = NavigationEngine(
            on_progress=self._on_progress,
            headless=self._headless,
            storage_state=self._storage_state,
            user_data_dir=self._user_data_dir,
            sensitive_data=self._sensitive_data,
        )

        try:
            await nav.start()
        except Exception as e:
            self.result.errors.append(f"Browser launch failed: {str(e)[:300]}")
            self._log("scan_error", f"Browser launch failed: {e}")
            return self.result

        for viewport_name in self.viewports:
            self._log("debug", f"Testing viewport: {viewport_name}")

            agent = QAAgent(
                base_url=self.url,
                max_pages=self.max_pages,
                nav=nav,
                on_progress=self._on_progress,
                sensitive_data=self._sensitive_data,
            )

            try:
                state = await agent.run(viewport=viewport_name)
            except Exception as e:
                self._log("scan_error", f"{viewport_name}: {str(e)[:300]}")
                self.result.errors.append(f"{viewport_name}: {str(e)[:300]}")
                continue

            if self._graph is None:
                self._graph = state.graph

            if viewport_name == self.viewports[0] and state.completed_flows:
                self.result.flows = state.completed_flows

            for url, node in state.graph.nodes.items():
                if node.status != "visited":
                    continue
                if url not in self.result.pages_visited:
                    self.result.pages_visited.append(url)

                for bug in (node.bugs or []):
                    bug.viewport = viewport_name
                    bug.evidence["page_title"] = node.title
                    key = f"{_url_hash(url)}_{viewport_name}"
                    bug.evidence["screenshot_key"] = key
                    if not bug.description:
                        bug.description = _gen_desc(bug, node.title, viewport_name)
                    bug.evidence["repro_steps"] = _repro(bug, url, viewport_name)
                    self.result.bugs.append(bug)

                if node.metrics:
                    self.result.metrics.append(node.metrics)

                if node.screenshot_b64:
                    key = f"{_url_hash(url)}_{viewport_name}"
                    self.screenshots[key] = node.screenshot_b64

        await nav.stop()

        self.result.pages_tested = len(self.result.pages_visited)
        self.result.completed_at = datetime.now()
        self.result.bugs = _dedup(self.result.bugs)
        self.result.health_score = _health(self.result)
        return self.result

    def get_screenshots(self) -> dict[str, str]:
        return self.screenshots

    def get_site_graph(self) -> dict:
        if not self._graph:
            return {"nodes": [], "edges": []}
        return self._graph.to_dict()

    def _log(self, event: str, msg: str):
        if self._on_progress:
            self._on_progress(event, {"msg": msg})


# ── Helpers (unchanged from v1) ──

def _gen_desc(bug: BugFinding, title: str, viewport: str) -> str:
    loc = f'on page "{title}"' if title else f"at {bug.page_url}"
    vp = f" ({viewport} viewport)"
    return f"{bug.title} {loc}{vp}."


def _repro(bug: BugFinding, url: str, viewport: str) -> list[str]:
    return [f"Navigate to {url}", f"Set viewport to {viewport}", "Wait for page to load"]


def _url_hash(url: str) -> str:
    return hashlib.md5(url.encode()).hexdigest()[:10]


def _dedup(bugs: list[BugFinding]) -> list[BugFinding]:
    seen: set[tuple] = set()
    unique: list[BugFinding] = []
    for bug in bugs:
        key = (bug.title, bug.page_url, bug.viewport)
        if key not in seen:
            seen.add(key)
            unique.append(bug)
    return unique


def _health(result: CrawlResult) -> int:
    score = 100
    penalty = {"P0": 25, "P1": 15, "P2": 8, "P3": 3, "P4": 1}
    for bug in result.bugs:
        score -= penalty.get(bug.severity.value, 1)
    return max(score, 0)
