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

import asyncio
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
from agent.detectors.accessibility import AccessibilityDetector
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
        sensitive_data: dict | None = None,
    ):
        self.base_url = base_url.rstrip("/")
        parsed = urlparse(base_url)
        self.base_domain = parsed.netloc
        self.root_domain = _root_domain(parsed.netloc)
        self.max_pages = max_pages
        self._sensitive_data = sensitive_data
        self.__emit_fn = on_progress or (lambda *_: None)

        self._nav = nav or NavigationEngine(on_progress=self._emit)
        self._ai = GeminiEngine()
        self._a11y = AccessibilityDetector()
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

        # ── Auth wall detection ──
        if self._ai.available and self._ai.site_context.auth_state != "logged in":
            if not page_state.screenshot_b64 or not page_state.url or page_state.url == "about:blank":
                self._emit("debug", {"msg": "Skipping auth check: blank page"})
            else:
                try:
                    auth_check = await asyncio.wait_for(
                        self._ai.detect_auth_wall(page_state), timeout=30,
                    )
                except (asyncio.TimeoutError, Exception):
                    auth_check = {"is_login_wall": False}

                is_wall = (
                    auth_check.get("is_login_wall")
                    and auth_check.get("confidence") == "high"
                    and auth_check.get("login_form_visible")
                )
                if is_wall:
                    self._emit("agent_thinking", {"thought": f"Login wall detected: {auth_check.get('reason', '')}", "page": node.url})
                    logged_in = await self._attempt_login(node, auth_check)
                    if logged_in:
                        page_state = await self._nav.get_page_state()
                        node.title = page_state.title
                    else:
                        self._emit("agent_thinking", {"thought": "Could not log in, testing public content only", "page": node.url})

        # ── Stage 2+3: Assess page AND plan journeys (single AI call) ──
        assessment = {}
        journeys = []
        if self._ai.available:
            self._emit("agent_thinking", {"thought": f"Analyzing page and planning tests: {node.url[:60]}", "page": node.url})
            assessment, journeys = await self._ai.assess_and_plan(page_state, self._state.tested_journeys)
            purpose = assessment.get("page_purpose", "")
            if purpose:
                self._emit("agent_thinking", {"thought": f"Page purpose: {purpose}", "page": node.url})
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

            try:
                flow_result = await self._execute_journey(node, journey, viewport)
            except Exception as e:
                flow_result = FlowResult(
                    flow=Flow(name=journey.get("name", ""), priority=journey.get("priority", 5)),
                    status="failed",
                    context_summary={"error": str(e)[:200]},
                )

            self._state.completed_flows.append(flow_result)
            self._state.tested_journeys.append(journey.get("name", ""))
            self._ai.site_context.journeys_completed.append({
                "name": flow_result.flow.name,
                "status": flow_result.status,
                "page": node.url,
            })

            # Navigate back to page for next journey or post-processing
            try:
                await self._nav.navigate_to(node.url)
                await self._functional.inject_tracking(self._nav.execute_javascript)
            except Exception:
                pass

        # ── Post-journey analysis (wrapped to ensure node.status is always set) ──
        bugs: list[BugFinding] = []
        try:
            await self._discover_links(node)

            execute_js = self._nav.execute_javascript
            bugs = await self._run_detectors(execute_js, node.url, viewport)
            node.bugs = bugs
            self._state.all_bugs.extend(bugs)
            for bug in bugs:
                self._emit("bug_found", {
                    "severity": bug.severity.value, "title": bug.title,
                    "page": node.url, "category": bug.category.value,
                })

            metrics = await self._performance.collect_metrics(execute_js, node.url, viewport)
            node.metrics = metrics
            self._state.all_metrics.append(metrics)

            final_state = await self._nav.get_page_state()
            node.screenshot_b64 = final_state.screenshot_b64
        except Exception:
            pass

        self._ai.site_context.pages_visited.append(node.url)
        node.status = "visited"
        self._emit("page_complete", {
            "url": node.url, "status": "visited",
            "bugs": len(bugs),
            "flows_tested": len(journeys),
            "screenshot": node.screenshot_b64,
        })

    # ──────────────────────────────────────────────
    # Auth
    # ──────────────────────────────────────────────

    async def _attempt_login(self, node: SiteNode, auth_check: dict) -> bool:
        """Attempt to log in using Browser-Use with sensitive_data credentials.

        Has a hard 90s timeout to prevent hanging on complex login flows.
        """
        login_task = auth_check.get("login_task", "")
        if not login_task:
            return False

        has_creds = self._sensitive_data and any(
            k for k in self._sensitive_data
            if "password" in k.lower() or "email" in k.lower() or "user" in k.lower()
        )
        if not has_creds:
            self._emit("auth_required", {"url": node.url, "reason": "Login wall detected but no credentials provided"})
            return False

        try:
            return await asyncio.wait_for(
                self._do_login(node, auth_check, login_task), timeout=90,
            )
        except asyncio.TimeoutError:
            self._emit("agent_thinking", {"thought": "Login attempt timed out after 90s", "page": node.url})
            return False
        except Exception as e:
            self._emit("agent_thinking", {"thought": f"Login attempt failed: {str(e)[:100]}", "page": node.url})
            return False

    async def _do_login(self, node: SiteNode, auth_check: dict, login_task: str) -> bool:
        cred_placeholders = ", ".join(f"use {{{{ {k} }}}}" for k in self._sensitive_data)
        full_task = (
            f"You are on a login page at {node.url}. "
            f"Log in using these credentials: {cred_placeholders}. "
            f"Specific instructions: {login_task}. "
            f"After entering credentials, click the sign-in/login button and wait for the page to load."
        )

        self._emit("agent_thinking", {"thought": "Attempting login...", "page": node.url})
        await self._nav.execute_task(full_task, max_steps=10)

        post_state = await self._nav.get_page_state()
        if not post_state.screenshot_b64:
            return False

        still_login = await self._ai.detect_auth_wall(post_state)

        if not still_login.get("is_login_wall"):
            self._ai.site_context.auth_state = "logged in"
            self._emit("agent_thinking", {"thought": "Login successful!", "page": post_state.url})
            await self._nav.navigate_to(node.url)
            return True

        self._emit("agent_thinking", {"thought": f"Login attempt did not succeed: {still_login.get('reason', '')}", "page": node.url})
        return False

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

        # Browser-Use Agent handles everything autonomously:
        # screenshots, DOM extraction, LLM planning, action execution,
        # per-step evaluation, and success/failure reporting.
        enhanced_task = (
            f"{task}\n\n"
            f"VERIFICATION: After completing the actions, verify that: {expected}. "
            f"If the expected outcome is clearly visible, report success. "
            f"If something went wrong (error, wrong content, blank page), report failure with details."
        )
        nav_result = await self._nav.execute_task(enhanced_task, max_steps=15)

        post_state = await self._nav.get_page_state()
        duration = int((time.monotonic() - start) * 1000)

        # Trust the Agent's verdict first. The Agent already:
        # - Took screenshots at every step
        # - Evaluated each action's success/failure
        # - Reported done with success=True/False and extracted_content
        #
        # Only call AI verification when we need deeper analysis:
        # - Agent reported failure (need to distinguish bug vs blocked vs flaky)
        # - Critical flow (priority >= 8, worth the extra API call)
        # - Agent had errors during execution
        needs_ai_verify = (
            not nav_result.success
            or nav_result.errors
            or priority >= 8
        )

        verification: dict = {}
        if needs_ai_verify and self._ai.available:
            self._emit("agent_thinking", {"thought": f"Verifying: {expected[:60]}", "page": post_state.url})
            verification = await self._ai.verify_outcome(
                post_state, name, expected,
                {
                    "success": nav_result.success,
                    "errors": nav_result.errors,
                    "actions_taken": nav_result.actions_taken,
                    "final_url": nav_result.final_url,
                    "agent_report": nav_result.extracted_content,
                },
            )
            status = verification.get("status", "inconclusive")
            reason = verification.get("reason", "")

            for issue_text in verification.get("issues", []):
                if issue_text and isinstance(issue_text, str) and len(issue_text.strip()) > 5:
                    self._state.all_bugs.append(BugFinding(
                        title=f"AI found: {issue_text[:120]}",
                        category=_category("functional"),
                        severity=_severity("P2") if status == "failed" else _severity("P3"),
                        confidence=_confidence("MEDIUM"),
                        page_url=post_state.url or node.url,
                        description=f"During journey '{name}': {issue_text}",
                        evidence={"flow": name, "verification_status": status},
                    ))
        else:
            # Trust the Agent's verdict directly
            if nav_result.success:
                status = "passed"
                reason = nav_result.extracted_content or "Agent reported success"
            else:
                status = "failed"
                reason = "; ".join(nav_result.errors[:3]) if nav_result.errors else "Agent reported failure"

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
            bugs.extend(await self._a11y.detect(execute_js, url))
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
