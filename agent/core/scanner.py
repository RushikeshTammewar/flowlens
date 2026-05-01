"""Scanner v2: orchestrates QAAgent with Browser-Use powered navigation.

Browser-Use manages the browser (Chrome via CDP). The scanner creates
a NavigationEngine, passes it to QAAgent, and aggregates results.

Auth flow:
  1. If credentials are provided (sensitive_data), Agent uses browser-use's
     sensitive_data feature for automated login (LLM never sees real values).
  2. If automated login fails or no credentials, auth_required event fires.
  3. If auth_cookie_event is set (backend wired), scanner pauses and waits
     for the user to complete manual login via RemoteBrowserModal.
  4. Manual login cookies are injected into the browser session via CDP.
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
from datetime import datetime

from agent.core.navigation_engine import NavigationEngine, ProgressCallback
from agent.core.qa_agent import QAAgent
from agent.models.graph import SiteGraph
from agent.models.types import CrawlResult, BugFinding, PageMetrics

logger = logging.getLogger(__name__)


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
        auth_cookie_event: asyncio.Event | None = None,
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
        self._auth_cookie_event = auth_cookie_event
        self._auth_cookie_store = auth_cookie_store
        self._scan_id = scan_id

    async def scan(self) -> CrawlResult:
        self.result.started_at = datetime.now()
        self._log("debug", f"Starting scan for {self.url}")

        self._nav = NavigationEngine(
            on_progress=self._on_progress,
            headless=self._headless,
            storage_state=self._storage_state,
            user_data_dir=self._user_data_dir,
            sensitive_data=self._sensitive_data,
        )
        nav = self._nav

        try:
            await nav.start()
        except Exception as e:
            self.result.errors.append(f"Browser launch failed: {str(e)[:300]}")
            self._log("scan_error", f"Browser launch failed: {e}")
            return self.result

        def on_progress_with_cookie_bridge(event_type: str, data: dict):
            if self._on_progress:
                self._on_progress(event_type, data)
            if event_type == "auth_required" and self._auth_cookie_event:
                asyncio.ensure_future(self._wait_for_manual_login(nav))

        for viewport_name in self.viewports:
            self._log("debug", f"Testing viewport: {viewport_name}")

            agent = QAAgent(
                base_url=self.url,
                max_pages=self.max_pages,
                nav=nav,
                on_progress=on_progress_with_cookie_bridge,
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

    async def _wait_for_manual_login(self, nav: NavigationEngine):
        """Wait for user to complete login via RemoteBrowserModal, then inject cookies."""
        if not self._auth_cookie_event:
            return

        self._log("debug", "Waiting for manual login (up to 120s)...")
        try:
            await asyncio.wait_for(self._auth_cookie_event.wait(), timeout=120)
        except asyncio.TimeoutError:
            self._log("debug", "Manual login timed out after 120s")
            return

        cookies = []
        if self._auth_cookie_store and self._scan_id:
            cookies = self._auth_cookie_store.get(self._scan_id, [])

        if not cookies:
            self._log("debug", "No cookies received from manual login")
            return

        self._log("debug", f"Injecting {len(cookies)} cookies from manual login")
        await self._inject_cookies(nav, cookies)

    async def _inject_cookies(self, nav: NavigationEngine, cookies: list[dict]):
        """Inject Playwright-format cookies into the browser-use CDP session."""
        if not nav._browser:
            return
        try:
            for cookie in cookies:
                cdp_cookie: dict = {
                    "name": cookie.get("name", ""),
                    "value": cookie.get("value", ""),
                    "domain": cookie.get("domain", ""),
                    "path": cookie.get("path", "/"),
                }
                if cookie.get("expires"):
                    cdp_cookie["expires"] = cookie["expires"]
                if cookie.get("httpOnly"):
                    cdp_cookie["httpOnly"] = True
                if cookie.get("secure"):
                    cdp_cookie["secure"] = True
                if cookie.get("sameSite"):
                    cdp_cookie["sameSite"] = cookie["sameSite"]

                await nav.execute_javascript(
                    f"document.cookie = '{cdp_cookie['name']}={cdp_cookie['value']}; "
                    f"path={cdp_cookie['path']}; "
                    f"domain={cdp_cookie['domain']}';"
                )

            cdp = nav._browser.cdp_client
            if cdp:
                for cookie in cookies:
                    params = {
                        "name": cookie.get("name", ""),
                        "value": cookie.get("value", ""),
                        "domain": cookie.get("domain", ""),
                        "path": cookie.get("path", "/"),
                    }
                    if cookie.get("expires"):
                        params["expires"] = cookie["expires"]
                    if cookie.get("httpOnly"):
                        params["httpOnly"] = True
                    if cookie.get("secure"):
                        params["secure"] = True
                    try:
                        await cdp.send("Network.setCookie", params)
                    except Exception:
                        pass

            self._log("debug", "Cookie injection complete, refreshing page...")
            await nav.navigate_to(self.url)
        except Exception as e:
            logger.warning(f"Cookie injection failed: {e}")

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
