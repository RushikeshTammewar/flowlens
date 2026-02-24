"""Unified QA Agent -- single-pass site testing.

Replaces the old two-pass architecture (Explorer then FlowRunner) with
a single agent that discovers pages AND tests flows simultaneously.
Every interaction IS a flow test. The SiteGraph and FlowResults are
built as side effects of testing, not as separate phases.

Behaves like a senior QA engineer: visits a page, looks at what's there,
decides what to test, tests it, records pass/fail, moves to the next page.
AI makes every non-trivial decision.
"""

from __future__ import annotations

import asyncio
import base64
import heapq
import time
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import urlparse, urlunparse, parse_qs, urlencode

from playwright.async_api import Page, BrowserContext, Playwright, ElementHandle

from agent.core.ai_engine import GeminiEngine
from agent.models.graph import (
    SiteGraph, SiteNode, PageElement, ActionResult, ProgressCallback,
)
from agent.models.flow import Flow, FlowStep, FlowResult, FlowStepResult
from agent.models.types import BugFinding, PageMetrics
from agent.detectors.functional import FunctionalDetector
from agent.detectors.performance import PerformanceDetector
from agent.detectors.responsive import ResponsiveDetector
from agent.utils.smart_wait import install_request_tracker, wait_for_stable_page
from agent.utils.popup_guard import dismiss_overlays
from agent.utils.auth_handler import AuthHandler
from agent.utils.element_finder import find_element
from agent.utils.form_filler import fill_form as heuristic_fill_form
from agent.utils.test_data import detect_site_type, get_search_query
from agent.utils.state_verifier import StateVerifier


_DISCOVER_ELEMENTS_JS = """() => {
    const seen = new Set();
    const results = [];

    function add(el, type, priority) {
        const text = (el.textContent || el.getAttribute('aria-label') || '').trim().substring(0, 120);
        if (!text && type !== 'form' && type !== 'search') return;

        let href = null;
        if (el.tagName === 'A') {
            try {
                const u = new URL(el.href, location.origin);
                if (u.protocol === 'http:' || u.protocol === 'https:') { u.hash = ''; href = u.href; }
            } catch {}
        }

        let selector;
        if (el.id) selector = '#' + CSS.escape(el.id);
        else if (el.getAttribute('data-testid')) selector = `[data-testid="${el.getAttribute('data-testid')}"]`;
        else {
            const parent = el.parentElement;
            if (parent) {
                const siblings = [...parent.children].filter(c => c.tagName === el.tagName);
                const idx = siblings.indexOf(el) + 1;
                const parentSel = parent.id ? '#' + CSS.escape(parent.id) : parent.tagName.toLowerCase();
                selector = `${parentSel} > ${el.tagName.toLowerCase()}:nth-of-type(${idx})`;
            } else { selector = el.tagName.toLowerCase(); }
        }

        const key = type + '|' + (href || selector);
        if (seen.has(key)) return;
        seen.add(key);
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0 && type !== 'form') return;
        results.push({ type, selector, text: text.substring(0, 80), href, priority });
    }

    for (const a of document.querySelectorAll('nav a[href], header a[href], [role="navigation"] a[href]')) add(a, 'nav_link', 9);
    for (const el of document.querySelectorAll('[aria-haspopup], [data-toggle="dropdown"], .dropdown-toggle, details > summary')) add(el, 'dropdown', 8);
    for (const form of document.querySelectorAll('form')) {
        const inputs = form.querySelectorAll('input:not([type=hidden]):not([type=submit]):not([type=button]), select, textarea');
        if (inputs.length === 0) continue;
        let sel = form.id ? '#' + CSS.escape(form.id) : null;
        if (!sel && form.getAttribute('name')) sel = `form[name="${form.getAttribute('name')}"]`;
        if (!sel) { const idx = [...document.querySelectorAll('form')].indexOf(form) + 1; sel = `form:nth-of-type(${idx})`; }
        const key = 'form|' + sel;
        if (seen.has(key)) continue; seen.add(key);
        results.push({ type: 'form', selector: sel, text: form.getAttribute('aria-label') || `Form with ${inputs.length} field(s)`, href: null, priority: 8 });
    }
    for (const el of document.querySelectorAll('input[type="search"], [role="search"] input, input[name="q"], input[name="search"], input[name="query"]')) add(el, 'search', 10);
    for (const el of document.querySelectorAll('button:not([type="submit"]), a.btn, [role="button"], .cta')) { if (!el.closest('form')) add(el, 'cta', 6); }
    for (const a of document.querySelectorAll('main a[href], article a[href], .content a[href], #content a[href]')) add(a, 'content_link', 5);
    for (const a of document.querySelectorAll('footer a[href]')) add(a, 'footer_link', 2);
    if (results.filter(r => r.href).length < 5) { for (const a of document.querySelectorAll('a[href]')) { if (!a.closest('nav') && !a.closest('header') && !a.closest('footer')) add(a, 'content_link', 4); } }
    return results;
}"""


@dataclass
class AgentState:
    """Persistent state across the entire scan session."""

    graph: SiteGraph = field(default_factory=lambda: SiteGraph(root_url=""))
    page_queue: list = field(default_factory=list)
    completed_flows: list[FlowResult] = field(default_factory=list)
    all_bugs: list[BugFinding] = field(default_factory=list)
    all_metrics: list[PageMetrics] = field(default_factory=list)
    tested_actions: set[str] = field(default_factory=set)
    visit_count: int = 0
    total_elements: int = 0
    total_actions: int = 0
    site_type: str = "generic"
    auth_logged_in: bool = False


class QAAgent:
    """Single-pass QA agent: discovers, tests, and reports in one sweep."""

    def __init__(
        self,
        base_url: str,
        max_pages: int = 20,
        on_progress: ProgressCallback | None = None,
        playwright_instance: Playwright | None = None,
        browser_context: BrowserContext | None = None,
        auth_cookie_event: object | None = None,
        auth_cookie_store: dict | None = None,
        scan_id: str | None = None,
    ):
        self.base_url = base_url.rstrip("/")
        parsed = urlparse(base_url)
        self.base_domain = parsed.netloc
        self.root_domain = _extract_root_domain(parsed.netloc)
        self.max_pages = max_pages
        self._emit_fn = on_progress or (lambda *_: None)

        self._ai = GeminiEngine()
        self._auth = AuthHandler(
            playwright_instance=playwright_instance,
            headless_context=browser_context,
            on_progress=self._emit_fn,
            auth_cookie_event=auth_cookie_event,
            auth_cookie_store=auth_cookie_store,
            scan_id=scan_id,
        )
        self._state_verifier = StateVerifier()
        self._functional = FunctionalDetector()
        self._performance = PerformanceDetector()
        self._responsive = ResponsiveDetector()

        self._state = AgentState()
        self._state.graph = SiteGraph(root_url=self.base_url)

    async def run(self, page: Page, viewport: str = "desktop") -> AgentState:
        """Main entry point. Returns the complete agent state with all results."""

        self._functional.attach_listeners(page)
        self._state_verifier.attach_listeners(page)
        await install_request_tracker(page)

        # Detect site type
        try:
            await page.goto(self.base_url, wait_until="domcontentloaded", timeout=20000)
            await wait_for_stable_page(page, timeout_ms=5000)
            text = await page.evaluate("() => (document.body?.innerText || '').substring(0, 3000)")
            self._state.site_type = detect_site_type(self.base_url, text)
        except Exception:
            pass

        # Seed the page queue
        self._state.graph.add_node(self.base_url, depth=0, page_type="home")
        heapq.heappush(self._state.page_queue, (-10, 0, self.base_url))
        self._emit("page_discovered", {"url": self.base_url, "depth": 0, "from": None})

        # Main loop: visit pages and test
        while self._state.page_queue and self._state.visit_count < self.max_pages:
            neg_pri, depth, url = heapq.heappop(self._state.page_queue)
            node = self._state.graph.get_node(url)
            if not node or node.status != "discovered":
                continue
            await self._visit_and_test(page, node, viewport)

        self._emit("scan_complete", {
            "pages": self._state.visit_count,
            "bugs": len(self._state.all_bugs),
            "flows": len(self._state.completed_flows),
            "flows_passed": sum(1 for f in self._state.completed_flows if f.status == "passed"),
            "actions_taken": self._state.total_actions,
        })

        return self._state

    async def _visit_and_test(self, page: Page, node: SiteNode, viewport: str):
        """Visit a page, test flows on it, detect bugs. Single pass."""

        node.status = "visiting"
        self._emit("visiting_page", {
            "url": node.url,
            "page_number": self._state.visit_count + 1,
            "total_discovered": len(self._state.graph.nodes),
        })

        # Navigate
        if self._state.visit_count > 0:
            await page.wait_for_timeout(600)

        try:
            response = await page.goto(node.url, wait_until="domcontentloaded", timeout=20000)
            if not response or response.status >= 400:
                node.status = "failed"
                self._emit("page_complete", {"url": node.url, "status": "failed"})
                return

            await install_request_tracker(page)
            await wait_for_stable_page(page, timeout_ms=5000)
            await _scroll_page(page)
            node.title = await page.title() or ""
            self._state.visit_count += 1
            self._functional.reset_for_page()
        except Exception as e:
            node.status = "failed"
            self._emit("page_complete", {"url": node.url, "status": "failed", "error": str(e)[:200]})
            return

        # Dismiss overlays
        await dismiss_overlays(page)

        # Check for login
        auth_result = await self._auth.check_and_handle_login(page)
        if auth_result:
            self._state.auth_logged_in = auth_result.success
            self._emit("auth_attempted", {
                "success": auth_result.success,
                "method": auth_result.method,
                "message": auth_result.message,
            })
            if auth_result.success:
                await wait_for_stable_page(page, timeout_ms=5000)
                await install_request_tracker(page)

        # Discover elements
        elements = await self._discover_elements(page)
        node.elements = elements
        self._state.total_elements += len(elements)

        el_summary = {}
        for el in elements:
            el_summary[el.type] = el_summary.get(el.type, 0) + 1
        self._emit("elements_found", {"url": node.url, "total": len(elements), **el_summary})

        # AI decides what to test on this page
        flows_to_test = await self._plan_page_tests(page, node, elements)

        # Execute each flow
        for candidate in flows_to_test:
            flow_result = await self._execute_test(page, node, candidate, elements, viewport)
            if flow_result:
                self._state.completed_flows.append(flow_result)
                self._state.total_actions += len(flow_result.steps)

        # Discover links for the page queue (nav links we didn't test as flows)
        self._queue_links(node, elements)

        # Run bug detectors
        bugs = await self._run_detectors(page, node.url, viewport)
        node.bugs = bugs
        self._state.all_bugs.extend(bugs)
        for bug in bugs:
            self._emit("bug_found", {
                "severity": bug.severity.value,
                "title": bug.title,
                "page": node.url,
                "category": bug.category.value,
            })

        # Metrics + screenshot
        metrics = await self._performance.collect_metrics(page, viewport)
        node.metrics = metrics
        self._state.all_metrics.append(metrics)
        node.screenshot_b64 = await _capture_screenshot(page)

        node.status = "visited"
        self._emit("page_complete", {
            "url": node.url,
            "status": "visited",
            "bugs": len(bugs),
            "flows_tested": len(flows_to_test),
        })

    async def _plan_page_tests(self, page: Page, node: SiteNode, elements: list[PageElement]) -> list[dict]:
        """AI decides what flows to test on this page."""

        # Build element summary for AI
        el_lines = []
        for i, el in enumerate(elements):
            el_lines.append(f"[{i}] {el.type} | '{el.text[:50]}' | href={el.href or 'none'} | sel={el.selector[:40]}")
        elements_summary = "\n".join(el_lines[:40])

        already_tested = list(self._state.tested_actions)[:20]
        auth_str = "logged in" if self._state.auth_logged_in else "not logged in"

        # Use AI if available
        if self._ai.available:
            candidates = await self._ai.plan_page_tests(
                page, elements_summary, already_tested,
                self._state.site_type, auth_str,
            )
            if candidates:
                return sorted(candidates, key=lambda c: -c.get("priority", 0))[:6]

        # Heuristic fallback: test search, forms, and top nav links
        fallback = []
        for i, el in enumerate(elements):
            if el.type == "search" and f"search@{node.url}" not in self._state.tested_actions:
                fallback.append({"name": "Search", "priority": 10, "type": "search", "element_index": i, "reasoning": "Search is critical"})
            elif el.type == "form" and f"form@{node.url}" not in self._state.tested_actions:
                fallback.append({"name": f"Form: {el.text[:30]}", "priority": 9, "type": "form", "element_index": i, "reasoning": "Form testing"})
            elif el.type == "nav_link" and len(fallback) < 4 and el.href and self._is_allowed(el.href):
                fallback.append({"name": f"Nav: {el.text[:30]}", "priority": 6, "type": "nav", "element_index": i, "reasoning": "Navigation test"})
            elif el.type == "cta" and len(fallback) < 5:
                fallback.append({"name": f"CTA: {el.text[:30]}", "priority": 5, "type": "cta", "element_index": i, "reasoning": "Button test"})

        return sorted(fallback, key=lambda c: -c.get("priority", 0))[:6]

    async def _execute_test(
        self, page: Page, node: SiteNode, candidate: dict,
        elements: list[PageElement], viewport: str,
    ) -> FlowResult | None:
        """Execute one flow test on the current page."""

        flow_type = candidate.get("type", "nav")
        flow_name = candidate.get("name", "Unknown")
        el_idx = candidate.get("element_index", -1)
        reasoning = candidate.get("reasoning", "")

        action_key = f"{flow_type}@{node.url}"
        if action_key in self._state.tested_actions:
            return None
        self._state.tested_actions.add(action_key)

        if el_idx < 0 or el_idx >= len(elements):
            return None

        element = elements[el_idx]
        start = time.monotonic()

        self._emit("flow_step", {
            "flow": flow_name,
            "step_index": 0,
            "step_action": flow_type,
            "step_target": element.text[:50],
            "page": node.url,
            "reasoning": reasoning,
        })

        # State snapshot before
        snapshot_before = await self._state_verifier.take_snapshot(page)
        url_before = page.url

        # Execute based on type
        steps: list[FlowStepResult] = []

        if flow_type == "search":
            steps = await self._test_search(page, element, node)
        elif flow_type == "form":
            steps = await self._test_form(page, element, node)
        elif flow_type == "nav":
            steps = await self._test_nav(page, element, node)
        elif flow_type == "cta":
            steps = await self._test_cta(page, element, node)
        elif flow_type == "menu":
            steps = await self._test_menu(page, element, node)
        else:
            steps = await self._test_nav(page, element, node)

        # Navigate back if we left
        if page.url != url_before:
            try:
                await page.goto(url_before, wait_until="domcontentloaded", timeout=15000)
                await wait_for_stable_page(page, timeout_ms=3000)
            except Exception:
                pass

        duration = int((time.monotonic() - start) * 1000)
        status = "passed" if steps and all(s.status == "passed" for s in steps) else "failed" if steps else "skipped"

        flow = Flow(name=flow_name, priority=candidate.get("priority", 5))
        result = FlowResult(flow=flow, status=status, steps=steps, duration_ms=duration)

        self._emit("flow_complete", {
            "flow": flow_name,
            "status": status,
            "duration_ms": duration,
            "page": node.url,
            "reasoning": reasoning,
        })

        return result

    # ─── Per-type test methods ───

    async def _test_search(self, page: Page, element: PageElement, node: SiteNode) -> list[FlowStepResult]:
        """Test search: type query, submit, verify results."""
        steps = []
        try:
            el = await page.query_selector(element.selector)
            if not el or not await el.is_visible():
                el = await find_element(page, "search")
            if not el:
                return [_fail_step("search", "search box", "Search input not found")]

            # AI decides search query
            if self._ai.available:
                query = await self._ai.decide_search_query(page)
            else:
                query = get_search_query(self._state.site_type)

            url_before = page.url
            await el.fill(query)
            await el.press("Enter")
            await wait_for_stable_page(page, timeout_ms=8000)

            screenshot = await _capture_screenshot(page)

            # AI verifies results
            success, reason = True, f"Searched for '{query}'"
            if self._ai.available:
                success, reason = await self._ai.verify_action(page, f"Search for '{query}'", "Search results should be displayed")

            steps.append(FlowStepResult(
                step=FlowStep("search", f"'{query}'", "", "results displayed"),
                status="passed" if success else "failed",
                actual_url=page.url,
                screenshot_b64=screenshot,
                error=reason,
                ai_used="AI" if self._ai.available else "Heuristic",
            ))

            # Add search results page to graph
            if page.url != url_before:
                norm = self._normalize(page.url)
                if self._is_allowed(norm) and norm not in self._state.graph.nodes:
                    self._state.graph.add_node(norm, depth=node.depth + 1, page_type="search")
                    self._state.graph.add_edge(node.url, norm)
                    self._emit("page_discovered", {"url": norm, "depth": node.depth + 1, "from": node.url, "via": f"search: {query}"})

        except Exception as e:
            steps.append(_fail_step("search", "search box", str(e)[:200]))

        return steps

    async def _test_form(self, page: Page, element: PageElement, node: SiteNode) -> list[FlowStepResult]:
        """Test form: fill fields, submit, verify outcome."""
        steps = []
        try:
            url_before = page.url

            # AI fills the form
            if self._ai.available:
                ai_fields = await self._ai.analyze_form(page, element.selector)
                if ai_fields:
                    filled = 0
                    for fi in ai_fields:
                        try:
                            sel = fi.get("selector", "")
                            val = fi.get("value", "")
                            act = fi.get("action", "fill")
                            if not sel or not val:
                                continue
                            fel = await page.query_selector(sel)
                            if not fel or not await fel.is_visible():
                                continue
                            if act == "select":
                                await fel.select_option(val)
                            elif act == "check":
                                if not await fel.is_checked():
                                    await fel.check()
                            else:
                                await fel.fill(val)
                            filled += 1
                        except Exception:
                            continue

                    # Submit
                    for sel in [f"{element.selector} button[type=submit]", f"{element.selector} input[type=submit]", f"{element.selector} button:not([type])"]:
                        try:
                            btn = await page.query_selector(sel)
                            if btn and await btn.is_visible():
                                await btn.click()
                                break
                        except Exception:
                            continue

                    await wait_for_stable_page(page, timeout_ms=5000)
                    screenshot = await _capture_screenshot(page)

                    success, reason = True, f"Form filled ({filled} fields) and submitted"
                    if self._ai.available:
                        success, reason = await self._ai.verify_action(page, "Submit form", "Form should submit successfully")

                    steps.append(FlowStepResult(
                        step=FlowStep("fill_form", element.text[:40], "", "form submitted"),
                        status="passed" if success else "failed",
                        actual_url=page.url,
                        screenshot_b64=screenshot,
                        error=reason,
                        ai_used="AI",
                    ))
                    return steps

            # Heuristic fallback
            result = await heuristic_fill_form(page, element.selector)
            await wait_for_stable_page(page, timeout_ms=3000)
            screenshot = await _capture_screenshot(page)

            steps.append(FlowStepResult(
                step=FlowStep("fill_form", element.text[:40], "", "form submitted"),
                status="passed" if result.outcome != "error" else "failed",
                actual_url=page.url,
                screenshot_b64=screenshot,
                error=result.error or result.outcome,
                ai_used="Heuristic",
            ))

        except Exception as e:
            steps.append(_fail_step("fill_form", element.text[:40], str(e)[:200]))

        return steps

    async def _test_nav(self, page: Page, element: PageElement, node: SiteNode) -> list[FlowStepResult]:
        """Test navigation: click link, verify destination loads."""
        steps = []
        try:
            if not element.href or not self._is_allowed(element.href):
                return [_fail_step("click", element.text[:40], "Link not navigable")]

            url = self._normalize(element.href)
            await page.goto(url, wait_until="domcontentloaded", timeout=15000)
            await wait_for_stable_page(page, timeout_ms=5000)

            screenshot = await _capture_screenshot(page)

            # Verify page loaded
            success, reason = True, f"Navigated to {_short_url(page.url)}"
            if self._ai.available:
                success, reason = await self._ai.verify_action(page, f"Navigate to {element.text[:40]}", "Page should load with content")

            steps.append(FlowStepResult(
                step=FlowStep("click", element.text[:40], element.href or "", "page loads"),
                status="passed" if success else "failed",
                actual_url=page.url,
                screenshot_b64=screenshot,
                error=reason,
                ai_used="AI" if self._ai.available else "Heuristic",
            ))

            # Add to graph
            if url not in self._state.graph.nodes:
                self._state.graph.add_node(url, depth=node.depth + 1)
                self._state.graph.add_edge(node.url, url)
                heapq.heappush(self._state.page_queue, (-element.priority, node.depth + 1, url))
                self._emit("page_discovered", {"url": url, "depth": node.depth + 1, "from": node.url, "via": element.text[:40]})
            else:
                self._state.graph.add_edge(node.url, url)

        except Exception as e:
            steps.append(_fail_step("click", element.text[:40], str(e)[:200]))

        return steps

    async def _test_cta(self, page: Page, element: PageElement, node: SiteNode) -> list[FlowStepResult]:
        """Test CTA button: click, verify outcome."""
        steps = []
        try:
            el = await page.query_selector(element.selector)
            if not el or not await el.is_visible():
                return [_fail_step("click", element.text[:40], "Button not found/visible")]

            url_before = page.url
            await el.click()
            await wait_for_stable_page(page, timeout_ms=5000)

            screenshot = await _capture_screenshot(page)
            navigated = page.url != url_before

            success, reason = True, "Button clicked"
            if navigated:
                reason = f"Navigated to {_short_url(page.url)}"
                norm = self._normalize(page.url)
                if self._is_allowed(norm) and norm not in self._state.graph.nodes:
                    self._state.graph.add_node(norm, depth=node.depth + 1)
                    self._state.graph.add_edge(node.url, norm)
                    heapq.heappush(self._state.page_queue, (-5, node.depth + 1, norm))
                    self._emit("page_discovered", {"url": norm, "depth": node.depth + 1, "from": node.url, "via": element.text[:40]})

            if self._ai.available:
                success, reason = await self._ai.verify_action(page, f"Click '{element.text[:40]}'", "Button should respond")

            steps.append(FlowStepResult(
                step=FlowStep("click", element.text[:40], "", "button responds"),
                status="passed" if success else "failed",
                actual_url=page.url,
                screenshot_b64=screenshot,
                error=reason,
                ai_used="AI" if self._ai.available else "Heuristic",
            ))

        except Exception as e:
            steps.append(_fail_step("click", element.text[:40], str(e)[:200]))

        return steps

    async def _test_menu(self, page: Page, element: PageElement, node: SiteNode) -> list[FlowStepResult]:
        """Test dropdown menu: hover/click, verify it expands."""
        steps = []
        try:
            el = await page.query_selector(element.selector)
            if not el or not await el.is_visible():
                return [_fail_step("expand_menu", element.text[:40], "Menu trigger not found")]

            links_before = await page.evaluate("() => document.querySelectorAll('a[href]').length")
            await el.hover()
            await page.wait_for_timeout(500)
            await el.click()
            await page.wait_for_timeout(800)
            links_after = await page.evaluate("() => document.querySelectorAll('a[href]').length")

            expanded = links_after > links_before
            screenshot = await _capture_screenshot(page)

            steps.append(FlowStepResult(
                step=FlowStep("click", f"Menu: {element.text[:30]}", "", "menu expands"),
                status="passed" if expanded else "failed",
                actual_url=page.url,
                screenshot_b64=screenshot,
                error=f"Menu {'expanded' if expanded else 'did not expand'} ({links_after - links_before} new links)",
                ai_used="Heuristic",
            ))

        except Exception as e:
            steps.append(_fail_step("expand_menu", element.text[:40], str(e)[:200]))

        return steps

    # ─── Discovery helpers ───

    async def _discover_elements(self, page: Page) -> list[PageElement]:
        try:
            raw = await page.evaluate(_DISCOVER_ELEMENTS_JS)
        except Exception:
            return []
        return [PageElement(type=r["type"], selector=r["selector"], text=r["text"], href=r.get("href"), priority=r["priority"]) for r in raw]

    def _queue_links(self, node: SiteNode, elements: list[PageElement]):
        """Add discovered nav/content links to the page queue."""
        link_count = 0
        for el in elements:
            if el.type not in ("nav_link", "content_link", "footer_link"):
                continue
            if not el.href or not self._is_allowed(el.href):
                continue
            url = self._normalize(el.href)
            if url in self._state.graph.nodes:
                self._state.graph.add_edge(node.url, url)
                continue
            if link_count >= 10:
                continue

            depth = node.depth + 1
            priority = el.priority
            if depth > 3:
                priority = max(1, priority - 2)

            self._state.graph.add_node(url, depth=depth)
            self._state.graph.add_edge(node.url, url)
            heapq.heappush(self._state.page_queue, (-priority, depth, url))
            link_count += 1
            self._emit("page_discovered", {"url": url, "depth": depth, "from": node.url, "via": el.text[:40]})

    async def _run_detectors(self, page: Page, url: str, viewport: str) -> list[BugFinding]:
        bugs: list[BugFinding] = []
        try:
            bugs.extend(await self._functional.detect(page, url))
        except Exception:
            pass
        try:
            metrics = await self._performance.collect_metrics(page, viewport)
            bugs.extend(await self._performance.detect(page, url, metrics))
        except Exception:
            pass
        try:
            bugs.extend(await self._responsive.detect(page, url, viewport))
        except Exception:
            pass
        for bug in bugs:
            bug.viewport = viewport
        return bugs

    # ─── URL helpers ───

    def _is_allowed(self, url: str) -> bool:
        if not url:
            return False
        parsed = urlparse(url)
        netloc = parsed.netloc
        if netloc != self.base_domain:
            if _extract_root_domain(netloc) != self.root_domain:
                return False
        path = parsed.path.lower()
        skip_ext = {".pdf", ".zip", ".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp", ".css", ".js", ".ico", ".woff", ".woff2", ".ttf", ".mp4", ".mp3", ".xml", ".rss", ".json"}
        if any(path.endswith(ext) for ext in skip_ext):
            return False
        return not any(p in url.lower() for p in ["/wp-admin", "/admin/", "mailto:", "tel:", "javascript:"])

    def _normalize(self, url: str) -> str:
        parsed = urlparse(url)
        params = sorted(parse_qs(parsed.query).items())
        return urlunparse(parsed._replace(fragment="", query=urlencode(params, doseq=True), path=parsed.path.rstrip("/") or "/"))

    def _emit(self, event_type: str, data: dict):
        try:
            self._emit_fn(event_type, data)
        except Exception:
            pass


# ─── Helpers ───

def _fail_step(action: str, target: str, error: str) -> FlowStepResult:
    return FlowStepResult(step=FlowStep(action, target), status="failed", error=error, ai_used="N/A")


async def _scroll_page(page: Page):
    try:
        for _ in range(3):
            await page.evaluate("window.scrollBy(0, window.innerHeight)")
            await page.wait_for_timeout(400)
        await page.evaluate("window.scrollTo(0, 0)")
        await page.wait_for_timeout(300)
    except Exception:
        pass


async def _capture_screenshot(page: Page) -> str | None:
    try:
        buf = await page.screenshot(full_page=False, type="jpeg", quality=60)
        return base64.b64encode(buf).decode("utf-8")
    except Exception:
        return None


def _extract_root_domain(netloc: str) -> str:
    parts = netloc.split(".")
    return ".".join(parts[-2:]) if len(parts) >= 2 else netloc


def _short_url(url: str, max_len: int = 60) -> str:
    s = url.replace("https://", "").replace("http://", "")
    return s[:max_len - 3] + "..." if len(s) > max_len else s
