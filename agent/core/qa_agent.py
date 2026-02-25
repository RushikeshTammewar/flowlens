"""Unified QA Agent -- single-pass, AI-driven, multi-step journey testing.

Five-stage AI strategy:
1. Understand the site (once, at start)
2. Assess each page before testing (screenshot-based)
3. Plan multi-step user journeys (not single clicks)
4. Execute with disabled-element checks
5. Verify with nuance (pass/fail/blocked/inconclusive)

Every interaction builds accumulated context. The agent gets smarter
as it tests more pages.
"""

from __future__ import annotations

import asyncio
import base64
import heapq
import time
from dataclasses import dataclass, field
from urllib.parse import urlparse, urlunparse, parse_qs, urlencode

from playwright.async_api import Page, BrowserContext, Playwright

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


_DISCOVER_ELEMENTS_JS = """() => {
    const seen = new Set();
    const results = [];
    function add(el, type, priority) {
        const text = (el.textContent || el.getAttribute('aria-label') || '').trim().substring(0, 120);
        if (!text && type !== 'form' && type !== 'search') return;
        let href = null;
        if (el.tagName === 'A') { try { const u = new URL(el.href, location.origin); if (u.protocol.startsWith('http')) { u.hash = ''; href = u.href; } } catch {} }
        let selector;
        if (el.id) selector = '#' + CSS.escape(el.id);
        else if (el.getAttribute('data-testid')) selector = `[data-testid="${el.getAttribute('data-testid')}"]`;
        else { const parent = el.parentElement; if (parent) { const siblings = [...parent.children].filter(c => c.tagName === el.tagName); const idx = siblings.indexOf(el) + 1; const pSel = parent.id ? '#' + CSS.escape(parent.id) : parent.tagName.toLowerCase(); selector = `${pSel} > ${el.tagName.toLowerCase()}:nth-of-type(${idx})`; } else { selector = el.tagName.toLowerCase(); } }
        const key = type + '|' + (href || selector);
        if (seen.has(key)) return; seen.add(key);
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0 && type !== 'form') return;
        const disabled = el.disabled || el.getAttribute('aria-disabled') === 'true';
        results.push({ type, selector, text: text.substring(0, 80), href, priority, disabled });
    }
    for (const a of document.querySelectorAll('nav a[href], header a[href], [role="navigation"] a[href]')) add(a, 'nav_link', 9);
    for (const el of document.querySelectorAll('[aria-haspopup], [data-toggle="dropdown"], .dropdown-toggle, details > summary')) add(el, 'dropdown', 8);
    for (const form of document.querySelectorAll('form')) {
        const inputs = form.querySelectorAll('input:not([type=hidden]):not([type=submit]):not([type=button]), select, textarea');
        if (inputs.length === 0) continue;
        let sel = form.id ? '#' + CSS.escape(form.id) : null;
        if (!sel && form.getAttribute('name')) sel = `form[name="${form.getAttribute('name')}"]`;
        if (!sel) { const idx = [...document.querySelectorAll('form')].indexOf(form) + 1; sel = `form:nth-of-type(${idx})`; }
        const key = 'form|' + sel; if (seen.has(key)) continue; seen.add(key);
        results.push({ type: 'form', selector: sel, text: form.getAttribute('aria-label') || `Form with ${inputs.length} field(s)`, href: null, priority: 8, disabled: false });
    }
    for (const el of document.querySelectorAll('input[type="search"], [role="search"] input, input[name="q"], input[name="search"], input[name="query"]')) add(el, 'search', 10);
    for (const el of document.querySelectorAll('button:not([type="submit"]), a.btn, [role="button"], .cta')) { if (!el.closest('form')) add(el, 'cta', 6); }
    for (const a of document.querySelectorAll('main a[href], article a[href], .content a[href]')) add(a, 'content_link', 5);
    for (const a of document.querySelectorAll('footer a[href]')) add(a, 'footer_link', 2);
    if (results.filter(r => r.href).length < 5) { for (const a of document.querySelectorAll('a[href]')) { if (!a.closest('nav') && !a.closest('footer')) add(a, 'content_link', 4); } }
    return results;
}"""


@dataclass
class AgentState:
    graph: SiteGraph = field(default_factory=lambda: SiteGraph(root_url=""))
    page_queue: list = field(default_factory=list)
    completed_flows: list[FlowResult] = field(default_factory=list)
    all_bugs: list[BugFinding] = field(default_factory=list)
    all_metrics: list[PageMetrics] = field(default_factory=list)
    tested_actions: set[str] = field(default_factory=set)
    visit_count: int = 0
    total_elements: int = 0
    total_actions: int = 0
    auth_logged_in: bool = False


class QAAgent:
    """Single-pass QA agent with five-stage AI strategy."""

    def __init__(
        self, base_url: str, max_pages: int = 20,
        on_progress: ProgressCallback | None = None,
        playwright_instance: Playwright | None = None,
        browser_context: BrowserContext | None = None,
        auth_cookie_event=None, auth_cookie_store=None, scan_id=None,
    ):
        self.base_url = base_url.rstrip("/")
        parsed = urlparse(base_url)
        self.base_domain = parsed.netloc
        self.root_domain = _root_domain(parsed.netloc)
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
        self._functional = FunctionalDetector()
        self._performance = PerformanceDetector()
        self._responsive = ResponsiveDetector()
        self._state = AgentState()
        self._state.graph = SiteGraph(root_url=self.base_url)

    async def run(self, page: Page, viewport: str = "desktop") -> AgentState:
        self._functional.attach_listeners(page)
        await install_request_tracker(page)

        # Stage 1: Understand the site
        try:
            await page.goto(self.base_url, wait_until="domcontentloaded", timeout=20000)
            await wait_for_stable_page(page, timeout_ms=6000)

            if self._ai.available:
                self._emit("site_analysis", {"status": "analyzing site..."})
                ctx = await self._ai.understand_site(page)
                self._emit("site_analysis", {
                    "site_type": ctx.site_type,
                    "features": ctx.main_features,
                    "critical_paths": ctx.critical_paths,
                })
        except Exception:
            pass

        # Seed page queue
        self._state.graph.add_node(self.base_url, depth=0, page_type="home")
        heapq.heappush(self._state.page_queue, (-10, 0, self.base_url))
        self._emit("page_discovered", {"url": self.base_url, "depth": 0, "from": None})

        # Main loop
        while self._state.page_queue and self._state.visit_count < self.max_pages:
            _, depth, url = heapq.heappop(self._state.page_queue)
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
        node.status = "visiting"
        self._emit("visiting_page", {
            "url": node.url,
            "page_number": self._state.visit_count + 1,
            "total_discovered": len(self._state.graph.nodes),
        })

        if self._state.visit_count > 0:
            await page.wait_for_timeout(500)

        try:
            response = await page.goto(node.url, wait_until="domcontentloaded", timeout=20000)
            if not response or response.status >= 400:
                node.status = "failed"
                self._emit("page_complete", {"url": node.url, "status": "failed"})
                return
            await install_request_tracker(page)
            await wait_for_stable_page(page, timeout_ms=6000)
            await _scroll_page(page)
            node.title = await page.title() or ""
            self._state.visit_count += 1
            self._functional.reset_for_page()
        except Exception as e:
            node.status = "failed"
            self._emit("page_complete", {"url": node.url, "status": "failed", "error": str(e)[:200]})
            return

        await dismiss_overlays(page)

        # Auth check
        auth_result = await self._auth.check_and_handle_login(page)
        if auth_result:
            self._state.auth_logged_in = auth_result.success
            self._ai.site_context.auth_state = "logged in" if auth_result.success else "not logged in"
            self._emit("auth_attempted", {"success": auth_result.success, "method": auth_result.method, "message": auth_result.message})
            if auth_result.success:
                await wait_for_stable_page(page, timeout_ms=5000)

        # Discover elements
        elements = await self._discover_elements(page)
        node.elements = elements
        self._state.total_elements += len(elements)

        el_summary = {}
        for el in elements:
            el_summary[el.type] = el_summary.get(el.type, 0) + 1
        self._emit("elements_found", {"url": node.url, "total": len(elements), **el_summary})

        # Build element summary for AI
        el_lines = []
        for i, el in enumerate(elements):
            disabled_str = " [DISABLED]" if getattr(el, '_disabled', False) else ""
            el_lines.append(f"[{i}] {el.type} | '{el.text[:50]}' | href={el.href or 'none'}{disabled_str}")
        elements_summary = "\n".join(el_lines[:40])

        # Stage 2: Assess page
        page_assessment = {}
        if self._ai.available:
            page_assessment = await self._ai.assess_page(page, elements_summary)
            visual_issues = page_assessment.get("visual_issues", [])
            if visual_issues:
                for issue in visual_issues[:3]:
                    self._ai.site_context.key_findings.append(f"Visual: {issue}")

        # Stage 3: Plan journeys
        already_tested = list(self._state.tested_actions)[:20]
        journeys = []
        if self._ai.available:
            journeys = await self._ai.plan_journeys(page, elements_summary, page_assessment, already_tested)

        if not journeys:
            journeys = self._heuristic_journeys(elements, node)

        # Execute journeys
        for journey in journeys:
            if journey.get("requires_auth") and not self._state.auth_logged_in:
                self._emit("flow_complete", {
                    "flow": journey.get("name", "Unknown"),
                    "status": "blocked",
                    "page": node.url,
                    "reasoning": "Requires authentication",
                    "duration_ms": 0,
                })
                self._state.completed_flows.append(FlowResult(
                    flow=Flow(name=journey.get("name", ""), priority=journey.get("priority", 5)),
                    status="blocked",
                    context_summary={"blocked_reason": "auth_required"},
                ))
                continue

            flow_result = await self._execute_journey(page, node, journey, elements, viewport)
            if flow_result:
                self._state.completed_flows.append(flow_result)
                self._state.total_actions += len(flow_result.steps)
                self._ai.site_context.journeys_completed.append({
                    "name": flow_result.flow.name,
                    "status": flow_result.status,
                    "page": node.url,
                })

        # Discover links for page queue
        self._queue_links(node, elements)

        # Bug detection
        bugs = await self._run_detectors(page, node.url, viewport)
        node.bugs = bugs
        self._state.all_bugs.extend(bugs)
        for bug in bugs:
            self._emit("bug_found", {"severity": bug.severity.value, "title": bug.title, "page": node.url, "category": bug.category.value})

        # Metrics + screenshot
        metrics = await self._performance.collect_metrics(page, viewport)
        node.metrics = metrics
        self._state.all_metrics.append(metrics)
        node.screenshot_b64 = await _screenshot(page)

        self._ai.site_context.pages_visited.append(node.url)
        node.status = "visited"
        self._emit("page_complete", {
            "url": node.url, "status": "visited",
            "bugs": len(bugs), "flows_tested": len(journeys),
            "screenshot": node.screenshot_b64,
        })

    async def _execute_journey(self, page: Page, node: SiteNode, journey: dict, elements: list[PageElement], viewport: str) -> FlowResult | None:
        """Execute a multi-step journey. Each step is verified with nuance."""
        name = journey.get("name", "Unknown")
        steps = journey.get("steps", [])
        if not steps:
            return None

        start = time.monotonic()
        step_results: list[FlowStepResult] = []
        url_before_journey = page.url

        self._emit("flow_step", {"flow": name, "step_index": 0, "step_action": "start", "step_target": name, "page": node.url, "reasoning": journey.get("reasoning", "")})

        for si, step in enumerate(steps):
            action = step.get("action", "click")
            el_idx = step.get("element_index", -1)
            target = step.get("target", "")
            query = step.get("query", "")
            verify = step.get("verify", "action completed")

            self._emit("flow_step", {"flow": name, "step_index": si, "step_action": action, "step_target": target or query or f"element[{el_idx}]", "page": page.url})

            step_result = await self._execute_step(page, action, el_idx, target, query, verify, elements, node)
            step_results.append(step_result)

            # If step failed or blocked, stop this journey
            if step_result.status in ("failed", "blocked"):
                break

            # If we navigated to a new page, re-discover elements for the next step
            if page.url != url_before_journey:
                try:
                    elements = await self._discover_elements(page)
                except Exception:
                    elements = []

        # Navigate back if we left the original page
        if page.url != url_before_journey:
            try:
                await page.goto(url_before_journey, wait_until="domcontentloaded", timeout=15000)
                await wait_for_stable_page(page, timeout_ms=3000)
            except Exception:
                pass

        duration = int((time.monotonic() - start) * 1000)

        if all(s.status == "passed" for s in step_results):
            status = "passed"
        elif any(s.status == "blocked" for s in step_results):
            status = "blocked"
        elif any(s.status == "failed" for s in step_results):
            status = "failed"
        else:
            status = "partial"

        action_key = f"{name}@{node.url}"
        self._state.tested_actions.add(action_key)

        self._emit("flow_complete", {"flow": name, "status": status, "duration_ms": duration, "page": node.url, "steps_count": len(step_results)})

        return FlowResult(
            flow=Flow(name=name, priority=journey.get("priority", 5)),
            status=status, steps=step_results, duration_ms=duration,
        )

    async def _execute_step(self, page: Page, action: str, el_idx: int, target: str, query: str, verify: str, elements: list[PageElement], node: SiteNode) -> FlowStepResult:
        """Execute one step of a journey with proper disabled checks and nuanced verification."""
        screenshot_b64 = None
        error = None
        status = "passed"
        ai_method = "Heuristic"

        try:
            if action == "search":
                el = None
                # Find search input
                if 0 <= el_idx < len(elements):
                    el = await page.query_selector(elements[el_idx].selector)
                if not el:
                    el = await find_element(page, "search")
                if not el:
                    return FlowStepResult(step=FlowStep("search", target or "search"), status="failed", error="Search input not found", ai_used="N/A")

                # Check if interactable
                if not await el.is_visible():
                    return FlowStepResult(step=FlowStep("search", target), status="failed", error="Search input not visible", ai_used="N/A")
                if await el.is_disabled():
                    return FlowStepResult(step=FlowStep("search", target), status="blocked", error="Search input is disabled", ai_used="N/A")

                # Get query
                search_query = query
                if not search_query and self._ai.available:
                    search_query = await self._ai.decide_search_query(page)
                    ai_method = "AI"
                if not search_query:
                    search_query = get_search_query(self._ai.site_context.site_type or "generic")

                await el.fill(search_query)
                await el.press("Enter")
                await wait_for_stable_page(page, timeout_ms=8000)
                target = f"search: '{search_query}'"

            elif action == "click" or action == "nav":
                el = None
                if 0 <= el_idx < len(elements):
                    el = await page.query_selector(elements[el_idx].selector)

                # If on a new page (from previous step), use AI to find element
                if not el and target and self._ai.available:
                    decision = await self._ai.find_element_for_step(page, target)
                    if decision and isinstance(decision, dict) and decision.get("index", -1) >= 0:
                        sel = 'a[href], button, input:not([type=hidden]), [role="button"], [role="link"], summary'
                        all_els = await page.query_selector_all(sel)
                        idx = decision["index"]
                        visible = [e for e in all_els if await e.is_visible()]
                        if idx < len(visible):
                            el = visible[idx]
                            ai_method = "AI"

                if not el and target:
                    el = await find_element(page, target)

                if not el:
                    return FlowStepResult(step=FlowStep("click", target), status="failed", error=f"Element not found: {target}", ai_used=ai_method)
                if not await el.is_visible():
                    return FlowStepResult(step=FlowStep("click", target), status="failed", error="Element not visible", ai_used=ai_method)
                try:
                    is_disabled = await el.is_disabled()
                except Exception:
                    is_disabled = False
                if is_disabled:
                    return FlowStepResult(step=FlowStep("click", target), status="blocked", error="Element is disabled — cannot interact", ai_used=ai_method)

                # For nav links, use goto instead of click (more reliable)
                href = None
                if 0 <= el_idx < len(elements) and elements[el_idx].href:
                    href = elements[el_idx].href
                if href and self._is_allowed(href):
                    await page.goto(href, wait_until="domcontentloaded", timeout=15000)
                else:
                    await el.click()
                await wait_for_stable_page(page, timeout_ms=6000)

                # Add to graph if new page
                if href and self._is_allowed(href):
                    norm = self._normalize(href)
                    if norm not in self._state.graph.nodes:
                        self._state.graph.add_node(norm, depth=node.depth + 1)
                        self._state.graph.add_edge(node.url, norm)
                        heapq.heappush(self._state.page_queue, (-5, node.depth + 1, norm))
                        self._emit("page_discovered", {"url": norm, "depth": node.depth + 1, "from": node.url, "via": target[:40]})

            elif action == "fill_form":
                form_el = None
                if 0 <= el_idx < len(elements):
                    form_el = elements[el_idx]
                if form_el:
                    if self._ai.available:
                        ai_fields = await self._ai.analyze_form(page, form_el.selector)
                        if ai_fields:
                            filled = 0
                            for fi in ai_fields:
                                try:
                                    sel = fi.get("selector", "")
                                    val = fi.get("value", "")
                                    if not sel or not val:
                                        continue
                                    fel = await page.query_selector(sel)
                                    if not fel or not await fel.is_visible():
                                        continue
                                    try:
                                        if await fel.is_disabled():
                                            continue
                                    except Exception:
                                        pass
                                    act = fi.get("action", "fill")
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
                            for sub_sel in [f"{form_el.selector} button[type=submit]", f"{form_el.selector} input[type=submit]", f"{form_el.selector} button:not([type])"]:
                                try:
                                    btn = await page.query_selector(sub_sel)
                                    if btn and await btn.is_visible():
                                        await btn.click()
                                        break
                                except Exception:
                                    continue
                            await wait_for_stable_page(page, timeout_ms=5000)
                            ai_method = f"AI ({filled} fields)"
                        else:
                            await heuristic_fill_form(page, form_el.selector)
                            await wait_for_stable_page(page, timeout_ms=3000)
                    else:
                        await heuristic_fill_form(page, form_el.selector)
                        await wait_for_stable_page(page, timeout_ms=3000)
                else:
                    return FlowStepResult(step=FlowStep("fill_form", target), status="failed", error="Form not found", ai_used="N/A")

            elif action == "verify":
                pass  # Just verify, no action needed

            # Capture screenshot
            screenshot_b64 = await _screenshot(page)

            # Stage 5: Nuanced verification
            if self._ai.available and verify:
                result = await self._ai.verify_step(page, f"{action}: {target or query}", verify)
                status = result.get("status", "inconclusive")
                error = result.get("reason", "")
                issues = result.get("issues", [])
                if issues:
                    for issue in issues:
                        self._ai.site_context.key_findings.append(str(issue)[:100])
                ai_method = "AI verified"
            elif not verify:
                status = "passed"
                error = "Action completed"

        except Exception as e:
            err_str = str(e)[:200]
            if "timeout" in err_str.lower() and "disabled" in err_str.lower():
                status = "blocked"
                error = f"Element not interactable: {err_str}"
            elif "timeout" in err_str.lower():
                status = "failed"
                error = f"Action timed out: {err_str}"
            else:
                status = "failed"
                error = err_str

        return FlowStepResult(
            step=FlowStep(action, target or query or f"element[{el_idx}]", "", verify),
            status=status, actual_url=page.url,
            screenshot_b64=screenshot_b64, error=error, ai_used=ai_method,
        )

    def _heuristic_journeys(self, elements: list[PageElement], node: SiteNode) -> list[dict]:
        """Fallback: plan simple journeys without AI."""
        journeys = []
        for i, el in enumerate(elements):
            if el.type == "search" and len(journeys) < 4:
                journeys.append({"name": "Search", "priority": 10, "steps": [
                    {"action": "search", "element_index": i, "verify": "results appear"},
                ], "requires_auth": False})
            elif el.type == "form" and len(journeys) < 4:
                journeys.append({"name": f"Form: {el.text[:25]}", "priority": 9, "steps": [
                    {"action": "fill_form", "element_index": i, "verify": "form submitted"},
                ], "requires_auth": False})
            elif el.type == "nav_link" and el.href and self._is_allowed(el.href) and len(journeys) < 4:
                journeys.append({"name": f"Nav: {el.text[:25]}", "priority": 6, "steps": [
                    {"action": "nav", "element_index": i, "target": el.text[:30], "verify": "page loads with content"},
                ], "requires_auth": False})
        return journeys[:4]

    # ─── Discovery ───

    async def _discover_elements(self, page: Page) -> list[PageElement]:
        try:
            raw = await page.evaluate(_DISCOVER_ELEMENTS_JS)
        except Exception:
            return []
        elements = []
        for r in raw:
            el = PageElement(type=r["type"], selector=r["selector"], text=r["text"], href=r.get("href"), priority=r["priority"])
            el._disabled = r.get("disabled", False)
            elements.append(el)
        return elements

    def _queue_links(self, node: SiteNode, elements: list[PageElement]):
        count = 0
        for el in elements:
            if el.type not in ("nav_link", "content_link"):
                continue
            if not el.href or not self._is_allowed(el.href):
                continue
            url = self._normalize(el.href)
            if url in self._state.graph.nodes:
                self._state.graph.add_edge(node.url, url)
                continue
            if count >= 8:
                continue
            depth = node.depth + 1
            pri = el.priority - (2 if depth > 3 else 0)
            self._state.graph.add_node(url, depth=depth)
            self._state.graph.add_edge(node.url, url)
            heapq.heappush(self._state.page_queue, (-max(1, pri), depth, url))
            count += 1
            self._emit("page_discovered", {"url": url, "depth": depth, "from": node.url, "via": el.text[:40]})

    async def _run_detectors(self, page: Page, url: str, viewport: str) -> list[BugFinding]:
        bugs = []
        try: bugs.extend(await self._functional.detect(page, url))
        except Exception: pass
        try:
            m = await self._performance.collect_metrics(page, viewport)
            bugs.extend(await self._performance.detect(page, url, m))
        except Exception: pass
        try: bugs.extend(await self._responsive.detect(page, url, viewport))
        except Exception: pass
        for b in bugs: b.viewport = viewport
        return bugs

    def _is_allowed(self, url: str) -> bool:
        if not url: return False
        parsed = urlparse(url)
        if parsed.netloc != self.base_domain and _root_domain(parsed.netloc) != self.root_domain:
            return False
        path = parsed.path.lower()
        if any(path.endswith(ext) for ext in (".pdf", ".zip", ".png", ".jpg", ".gif", ".svg", ".css", ".js", ".ico", ".woff", ".mp4", ".xml", ".json")):
            return False
        return not any(p in url.lower() for p in ["mailto:", "tel:", "javascript:", "/wp-admin"])

    def _normalize(self, url: str) -> str:
        parsed = urlparse(url)
        params = sorted(parse_qs(parsed.query).items())
        return urlunparse(parsed._replace(fragment="", query=urlencode(params, doseq=True), path=parsed.path.rstrip("/") or "/"))

    def _emit(self, t: str, d: dict):
        try: self._emit_fn(t, d)
        except Exception: pass


async def _scroll_page(page: Page):
    try:
        for _ in range(3):
            await page.evaluate("window.scrollBy(0, window.innerHeight)")
            await page.wait_for_timeout(400)
        await page.evaluate("window.scrollTo(0, 0)")
        await page.wait_for_timeout(300)
    except Exception: pass


async def _screenshot(page: Page) -> str | None:
    try:
        buf = await page.screenshot(full_page=False, type="jpeg", quality=60)
        return base64.b64encode(buf).decode("utf-8")
    except Exception: return None


def _root_domain(netloc: str) -> str:
    parts = netloc.split(".")
    return ".".join(parts[-2:]) if len(parts) >= 2 else netloc
