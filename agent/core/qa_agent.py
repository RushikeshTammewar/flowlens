"""Unified QA Agent v2 — Browser-Use powered navigation.

FlowLens decides WHAT to test. Browser-Use handles HOW to navigate.

Five-stage AI strategy (unchanged):
1. Understand the site (once, from homepage screenshot)
2. Assess each page before testing
3. Plan multi-step user journeys (output: NL task descriptions)
4. Execute journeys via Browser-Use (autonomous LLM-driven navigation)
5. Verify outcomes with nuance (pass/fail/blocked/inconclusive)

v2 changes:
- NavigationEngine replaces all direct Playwright interaction
- Journey planning outputs natural language tasks, not browser commands
- Element discovery/clicking delegated entirely to Browser-Use
- Bug detectors use JS evaluation via CDP instead of Playwright events
"""

from __future__ import annotations

import base64
import heapq
import time
from dataclasses import dataclass, field
from urllib.parse import urlparse, urlunparse, parse_qs, urlencode

from agent.core.navigation_engine import NavigationEngine, PageState, ProgressCallback
from agent.core.ai_engine import GeminiEngine
from agent.models.graph import SiteGraph, SiteNode
from agent.models.flow import Flow, FlowStep, FlowResult, FlowStepResult
from agent.models.types import BugFinding, PageMetrics
from agent.detectors.functional import FunctionalDetector
from agent.detectors.performance import PerformanceDetector
from agent.detectors.responsive import ResponsiveDetector


@dataclass
class AgentState:
    graph: SiteGraph = field(default_factory=lambda: SiteGraph(root_url=""))
    page_queue: list = field(default_factory=list)
    completed_flows: list[FlowResult] = field(default_factory=list)
    all_bugs: list[BugFinding] = field(default_factory=list)
    all_metrics: list[PageMetrics] = field(default_factory=list)
    tested_journeys: list[str] = field(default_factory=list)
    visit_count: int = 0


class QAAgent:
    """QA agent that uses Browser-Use for navigation and Gemini for QA intelligence."""

    def __init__(
        self,
        base_url: str,
        max_pages: int = 20,
        nav: NavigationEngine | None = None,
        on_progress: ProgressCallback | None = None,
    ):
        self.base_url = base_url.rstrip("/")
        parsed = urlparse(base_url)
        self.base_domain = parsed.netloc
        self.root_domain = _root_domain(parsed.netloc)
        self.max_pages = max_pages
        self.__emit_fn = on_progress or (lambda *_: None)

        self._nav = nav or NavigationEngine(on_progress=self._emit)
        self._ai = GeminiEngine()
        self._functional = FunctionalDetector()
        self._performance = PerformanceDetector()
        self._responsive = ResponsiveDetector()
        self._state = AgentState()
        self._state.graph = SiteGraph(root_url=self.base_url)

    async def run(self, viewport: str = "desktop") -> AgentState:
        """Run the full QA scan."""

        # ── Stage 1: Navigate to site and understand it ──
        self._emit("debug", {"msg": f"Navigating to {self.base_url}..."})
        page_state = await self._nav.navigate_to(self.base_url)
        await self._functional.inject_tracking(self._nav.execute_javascript)

        if self._ai.available:
            self._emit("agent_thinking", {"thought": "Understanding what this site is..."})
            try:
                ctx = await self._ai.understand_site(page_state)
                self._emit("agent_thinking", {
                    "thought": f"Site: {ctx.core_product or ctx.site_type}. "
                               f"Features: {', '.join(ctx.main_features[:3])}",
                })
                self._emit("site_analysis", {
                    "site_type": ctx.site_type,
                    "core_product": ctx.core_product,
                    "features": ctx.main_features,
                    "critical_paths": ctx.critical_paths,
                })
            except Exception:
                self._emit("agent_thinking", {"thought": "Site analysis timed out, continuing"})

        # ── Seed the page queue ──
        self._state.graph.add_node(self.base_url, depth=0, page_type="home")
        heapq.heappush(self._state.page_queue, (-10, 0, self.base_url))
        self._emit("page_discovered", {"url": self.base_url, "depth": 0, "from": None})

        # ── Main loop: visit pages and test journeys ──
        while self._state.page_queue and self._state.visit_count < self.max_pages:
            _, depth, url = heapq.heappop(self._state.page_queue)
            node = self._state.graph.get_node(url)
            if not node or node.status != "discovered":
                continue
            await self._visit_and_test(node, viewport)

        self._emit("scan_complete", {
            "pages": self._state.visit_count,
            "bugs": len(self._state.all_bugs),
            "flows": len(self._state.completed_flows),
            "flows_passed": sum(1 for f in self._state.completed_flows if f.status == "passed"),
        })
        return self._state

    # ──────────────────────────────────────────────
    # Per-page visit
    # ──────────────────────────────────────────────

    async def _visit_and_test(self, node: SiteNode, viewport: str):
        node.status = "visiting"
        self._emit("visiting_page", {
            "url": node.url,
            "page_number": self._state.visit_count + 1,
            "total_discovered": len(self._state.graph.nodes),
        })

        # Navigate to the page
        page_state = await self._nav.navigate_to(node.url)
        if not page_state.url:
            node.status = "failed"
            self._emit("page_complete", {"url": node.url, "status": "failed"})
            return

        await self._functional.inject_tracking(self._nav.execute_javascript)
        node.title = page_state.title
        self._state.visit_count += 1

        # ── Stage 2: Assess page ──
        assessment = {}
        if self._ai.available:
            self._emit("agent_thinking", {"thought": f"Assessing page: {node.url[:60]}", "page": node.url})
            assessment = await self._ai.assess_page(page_state)
            purpose = assessment.get("page_purpose", "")
            if purpose:
                self._emit("agent_thinking", {"thought": f"Page purpose: {purpose}", "page": node.url})

            visual_issues = assessment.get("visual_issues", [])
            for issue in visual_issues[:3]:
                self._ai.site_context.key_findings.append(f"Visual: {issue}")

        # ── Stage 3: Plan journeys ──
        journeys = []
        if self._ai.available:
            self._emit("agent_thinking", {"thought": "Planning test journeys...", "page": node.url})
            journeys = await self._ai.plan_journeys(page_state, assessment, self._state.tested_journeys)
            if journeys:
                names = [j.get("name", "?") for j in journeys[:4]]
                self._emit("agent_thinking", {"thought": f"Will test: {', '.join(names)}", "page": node.url})

        if not journeys:
            self._emit("agent_thinking", {"thought": "No journeys planned, using heuristic", "page": node.url})
            journeys = self._heuristic_journeys(page_state)

        # ── Stage 4: Execute journeys via Browser-Use ──
        for journey in journeys:
            if journey.get("requires_auth") and self._ai.site_context.auth_state == "not logged in":
                flow_result = FlowResult(
                    flow=Flow(name=journey.get("name", ""), priority=journey.get("priority", 5)),
                    status="blocked",
                    context_summary={"blocked_reason": "auth_required"},
                )
                self._state.completed_flows.append(flow_result)
                self._emit("flow_complete", {
                    "flow": journey.get("name", ""), "status": "blocked",
                    "page": node.url, "duration_ms": 0,
                })
                continue

            flow_result = await self._execute_journey(node, journey, viewport)
            self._state.completed_flows.append(flow_result)
            self._state.tested_journeys.append(journey.get("name", ""))
            self._ai.site_context.journeys_completed.append({
                "name": flow_result.flow.name,
                "status": flow_result.status,
                "page": node.url,
            })

            # Navigate back for next journey
            await self._nav.navigate_to(node.url)
            await self._functional.inject_tracking(self._nav.execute_javascript)

        # ── Discover links ──
        await self._discover_links(node)

        # ── Bug detection ──
        execute_js = self._nav.execute_javascript
        bugs = await self._run_detectors(execute_js, node.url, viewport)
        node.bugs = bugs
        self._state.all_bugs.extend(bugs)
        for bug in bugs:
            self._emit("bug_found", {
                "severity": bug.severity.value, "title": bug.title,
                "page": node.url, "category": bug.category.value,
            })

        # ── Metrics + screenshot ──
        metrics = await self._performance.collect_metrics(execute_js, node.url, viewport)
        node.metrics = metrics
        self._state.all_metrics.append(metrics)

        final_state = await self._nav.get_page_state()
        node.screenshot_b64 = final_state.screenshot_b64

        self._ai.site_context.pages_visited.append(node.url)
        node.status = "visited"
        self._emit("page_complete", {
            "url": node.url, "status": "visited",
            "bugs": len(bugs),
            "flows_tested": len(journeys),
            "screenshot": node.screenshot_b64,
        })

    # ──────────────────────────────────────────────
    # Journey execution
    # ──────────────────────────────────────────────

    async def _execute_journey(self, node: SiteNode, journey: dict, viewport: str) -> FlowResult:
        name = journey.get("name", "Unknown")
        task = journey.get("task", "")
        expected = journey.get("expected_outcome", "action completes successfully")
        priority = journey.get("priority", 5)

        if not task:
            return FlowResult(
                flow=Flow(name=name, priority=priority),
                status="failed",
                context_summary={"error": "no task description"},
            )

        start = time.monotonic()

        self._emit("flow_step", {
            "flow": name, "step_index": 0, "step_action": "execute",
            "step_target": task[:80], "page": node.url,
        })

        # Let Browser-Use execute the task autonomously
        nav_result = await self._nav.execute_task(task, max_steps=15)

        # Get the page state after navigation for verification
        post_state = await self._nav.get_page_state()

        # ── Stage 5: Verify outcome ──
        verification = {"status": "inconclusive", "reason": "no AI"}
        if self._ai.available:
            self._emit("agent_thinking", {"thought": f"Verifying: {expected[:60]}", "page": post_state.url})
            verification = await self._ai.verify_outcome(
                post_state, name, expected,
                {
                    "success": nav_result.success,
                    "errors": nav_result.errors,
                    "actions_taken": nav_result.actions_taken,
                    "final_url": nav_result.final_url,
                },
            )

        status = verification.get("status", "inconclusive")
        reason = verification.get("reason", "")
        duration = int((time.monotonic() - start) * 1000)

        # If critical flow failed, investigate and retry
        if status == "failed" and priority >= 9 and self._ai.available:
            self._emit("agent_thinking", {"thought": f"Critical flow '{name}' failed. Investigating...", "page": node.url})
            investigation = await self._ai.investigate_failure(post_state, name, reason)

            if isinstance(investigation, dict):
                alt_task = investigation.get("alternative_task", "")
                if alt_task:
                    self._emit("agent_thinking", {"thought": f"Retrying: {alt_task[:60]}", "page": node.url})
                    await self._nav.navigate_to(node.url)
                    retry_result = await self._nav.execute_task(alt_task, max_steps=15)
                    retry_state = await self._nav.get_page_state()
                    retry_verify = await self._ai.verify_outcome(
                        retry_state, f"{name} (retry)", expected,
                        {
                            "success": retry_result.success,
                            "errors": retry_result.errors,
                            "actions_taken": retry_result.actions_taken,
                            "final_url": retry_result.final_url,
                        },
                    )
                    if retry_verify.get("status") == "passed":
                        status = "passed"
                        reason = retry_verify.get("reason", "Passed on retry")
                        self._emit("agent_thinking", {"thought": "Retry PASSED!", "page": node.url})

                if investigation.get("is_bug"):
                    self._state.all_bugs.append(BugFinding(
                        title=f"Critical flow failure: {name}",
                        category=_category("functional"),
                        severity=_severity("P0"),
                        confidence=_confidence("MEDIUM"),
                        page_url=node.url,
                        description=investigation.get("bug_description", reason),
                        evidence={"flow": name, "errors": nav_result.errors[:3]},
                    ))

        step_result = FlowStepResult(
            step=FlowStep(action="browser_use_task", target=task[:200]),
            status=status,
            actual_url=nav_result.final_url,
            screenshot_b64=post_state.screenshot_b64,
            error=reason if status != "passed" else None,
            ai_used="Browser-Use + Gemini",
        )

        self._emit("flow_complete", {
            "flow": name, "status": status, "duration_ms": duration,
            "page": node.url, "steps_count": nav_result.actions_taken,
        })

        return FlowResult(
            flow=Flow(name=name, priority=priority),
            status=status,
            steps=[step_result],
            duration_ms=duration,
            context_summary={"verification": verification},
        )

    # ──────────────────────────────────────────────
    # Link discovery
    # ──────────────────────────────────────────────

    async def _discover_links(self, node: SiteNode):
        links = await self._nav.get_links(self.base_domain)
        count = 0
        for link in links:
            if count >= 8:
                break
            href = link.get("href", "")
            if not href or not self._is_allowed(href):
                continue
            url = self._normalize(href)
            if url in self._state.graph.nodes:
                self._state.graph.add_edge(node.url, url)
                continue
            depth = node.depth + 1
            is_nav = link.get("inNav", False)
            pri = 8 if is_nav else 5
            self._state.graph.add_node(url, depth=depth)
            self._state.graph.add_edge(node.url, url)
            heapq.heappush(self._state.page_queue, (-max(1, pri), depth, url))
            count += 1
            self._emit("page_discovered", {
                "url": url, "depth": depth, "from": node.url,
                "via": link.get("text", "")[:40],
            })

    # ──────────────────────────────────────────────
    # Bug detection
    # ──────────────────────────────────────────────

    async def _run_detectors(self, execute_js, url: str, viewport: str) -> list[BugFinding]:
        bugs: list[BugFinding] = []
        try:
            bugs.extend(await self._functional.detect(execute_js, url))
        except Exception:
            pass
        try:
            m = await self._performance.collect_metrics(execute_js, url, viewport)
            bugs.extend(await self._performance.detect(execute_js, url, m))
        except Exception:
            pass
        try:
            bugs.extend(await self._responsive.detect(execute_js, url, viewport))
        except Exception:
            pass
        for b in bugs:
            b.viewport = viewport
        return bugs

    # ──────────────────────────────────────────────
    # Heuristic fallback
    # ──────────────────────────────────────────────

    def _heuristic_journeys(self, page_state: PageState) -> list[dict]:
        """Fallback journeys when AI planning is unavailable."""
        return [
            {
                "name": "Test page interactivity",
                "priority": 5,
                "requires_auth": False,
                "task": (
                    f"On the page {page_state.url}, look for any search input, "
                    f"form, or main call-to-action button. If there is a search input, "
                    f"type 'test query' and press Enter. If there is a form, try to "
                    f"fill it out with test data. Report what you find."
                ),
                "expected_outcome": "Page responds to user interaction",
            }
        ]

    # ──────────────────────────────────────────────
    # Helpers
    # ──────────────────────────────────────────────

    def _is_allowed(self, url: str) -> bool:
        if not url:
            return False
        parsed = urlparse(url)
        if parsed.netloc != self.base_domain and _root_domain(parsed.netloc) != self.root_domain:
            return False
        path = parsed.path.lower()
        skip_ext = (".pdf", ".zip", ".png", ".jpg", ".gif", ".svg", ".css", ".js",
                     ".ico", ".woff", ".mp4", ".xml", ".json")
        if any(path.endswith(ext) for ext in skip_ext):
            return False
        return not any(p in url.lower() for p in ["mailto:", "tel:", "javascript:", "/wp-admin"])

    def _normalize(self, url: str) -> str:
        parsed = urlparse(url)
        params = sorted(parse_qs(parsed.query).items())
        return urlunparse(parsed._replace(
            fragment="",
            query=urlencode(params, doseq=True),
            path=parsed.path.rstrip("/") or "/",
        ))

    def _emit(self, t: str, d: dict):
        try:
            self.__emit_fn(t, d)
        except Exception:
            pass


def _root_domain(netloc: str) -> str:
    parts = netloc.split(".")
    return ".".join(parts[-2:]) if len(parts) >= 2 else netloc


def _category(s: str):
    from agent.models.types import Category
    return Category(s)

def _severity(s: str):
    from agent.models.types import Severity
    return Severity(s)

def _confidence(s: str):
    from agent.models.types import Confidence
    return Confidence(s)
