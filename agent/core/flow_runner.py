"""Flow execution engine -- AI-powered senior QA engineer.

AI is the brain for every non-trivial decision:
- Pick which element to interact with (AI sees element list, picks best match)
- Decide what to search for (AI reads page context, generates realistic query)
- Fill forms intelligently (AI analyzes form, generates appropriate test data)
- Verify every action outcome (AI sees screenshot, judges pass/fail)
- Recover from unexpected states (AI decides how to proceed)

Heuristics handle only mechanical tasks: typing, clicking, scrolling, capturing.
"""

from __future__ import annotations

import asyncio
import base64
import os
import time
from urllib.parse import urlparse

from playwright.async_api import Page, ElementHandle

from agent.core.ai_engine import GeminiEngine
from agent.models.flow import Flow, FlowStep, FlowResult, FlowStepResult
from agent.models.graph import SiteGraph
from agent.models.context import FlowContext
from agent.utils.element_finder import find_element, find_form
from agent.utils.form_filler import fill_form as heuristic_fill_form
from agent.utils.smart_wait import install_request_tracker, wait_for_stable_page
from agent.utils.popup_guard import dismiss_overlays
from agent.utils.auth_handler import AuthHandler
from agent.utils.test_data import detect_site_type
from agent.utils.state_verifier import StateVerifier

from playwright.async_api import BrowserContext, Playwright


class FlowRunner:
    """Executes user flows with AI-powered decision making at every step."""

    def __init__(
        self,
        page: Page,
        root_url: str,
        graph: SiteGraph | None = None,
        on_progress: callable | None = None,
        playwright_instance: Playwright | None = None,
        browser_context: BrowserContext | None = None,
        auth_cookie_event: object | None = None,
        auth_cookie_store: dict | None = None,
        scan_id: str | None = None,
    ):
        self.page = page
        self.root_url = root_url.rstrip("/")
        self._graph = graph
        self._on_progress = on_progress or (lambda *_: None)
        self._ai = GeminiEngine()
        self._auth_handler = AuthHandler(
            playwright_instance=playwright_instance,
            headless_context=browser_context,
            on_progress=self._on_progress,
            auth_cookie_event=auth_cookie_event,
            auth_cookie_store=auth_cookie_store,
            scan_id=scan_id,
        )
        self._state_verifier = StateVerifier()
        self._site_type: str = "generic"

    async def execute_flows(self, flows: list[Flow]) -> list[FlowResult]:
        self._state_verifier.attach_listeners(self.page)
        await install_request_tracker(self.page)

        try:
            page_text = await self.page.evaluate("() => (document.body?.innerText || '').substring(0, 3000)")
            self._site_type = detect_site_type(self.root_url, page_text)
        except Exception:
            pass

        results = []
        for flow in flows:
            result = await self._execute_flow(flow)
            results.append(result)
        return results

    async def _execute_flow(self, flow: Flow) -> FlowResult:
        start = time.monotonic()
        step_results: list[FlowStepResult] = []
        status = "passed"
        ctx = FlowContext(site_type=self._site_type)

        # Navigate to root
        try:
            await self.page.goto(self.root_url, wait_until="domcontentloaded", timeout=20000)
            await wait_for_stable_page(self.page, timeout_ms=6000)
            await install_request_tracker(self.page)
            ctx.record_navigation(self.page.url)
        except Exception:
            pass

        for i, step in enumerate(flow.steps):
            self._emit("flow_step", {
                "flow": flow.name,
                "step_index": i,
                "step_action": step.action,
                "step_target": step.target,
            })

            # Pre-step: dismiss overlays
            dismissed = await dismiss_overlays(self.page)
            if dismissed:
                self._emit("popup_dismissed", {"types": dismissed})

            # Pre-step: check for login screen and handle via headful browser
            auth_result = await self._auth_handler.check_and_handle_login(self.page)
            if auth_result:
                ctx.auth_completed = auth_result.success
                self._emit("auth_attempted", {
                    "success": auth_result.success,
                    "method": auth_result.method,
                    "message": auth_result.message,
                    "cookies_injected": auth_result.cookies_injected,
                })
                if auth_result.success:
                    await wait_for_stable_page(self.page, timeout_ms=6000)
                    await install_request_tracker(self.page)
                    ctx.record_navigation(self.page.url)

            # State snapshot before
            snapshot_before = await self._state_verifier.take_snapshot(self.page)
            url_before = self.page.url

            # Execute the step
            step_result = await self._execute_step(step, url_before, ctx)
            step_results.append(step_result)

            # State snapshot after + compare
            snapshot_after = await self._state_verifier.take_snapshot(self.page)
            state_change = self._state_verifier.compare(snapshot_before, snapshot_after)
            ctx.record_snapshot(snapshot_after)
            ctx.record_state_change(state_change)

            step_result.state_changes = {
                "url_changed": state_change.url_changed,
                "cookies_set": state_change.cookies_added[:5],
                "js_errors": state_change.new_console_errors[:3],
                "network_errors": [e["url"][:80] for e in state_change.new_network_errors[:3]],
                "dom_changed": state_change.dom_changed,
            }

            if state_change.has_errors:
                self._emit("state_errors", {
                    "step": i,
                    "js_errors": state_change.new_console_errors[:3],
                    "network_errors": [e["url"][:80] for e in state_change.new_network_errors[:3]],
                })

            if self.page.url != url_before:
                ctx.record_navigation(self.page.url)

            if step_result.status == "passed":
                ctx.steps_completed += 1
            elif step_result.status == "failed":
                ctx.steps_failed += 1
                # AI decides whether to recover or abort
                if self._ai.available:
                    recovery = await self._ai.decide_recovery_action(
                        self.page,
                        step_result.error or "Step failed",
                        f"Flow: {flow.name}, Step {i+1}/{len(flow.steps)}: {step.action} '{step.target}'",
                    )
                    if recovery and recovery.get("action") == "skip":
                        step_result.status = "skipped"
                        status = "partial"
                        self._emit("recovery", {"action": "skip", "reasoning": recovery.get("reasoning", "")})
                        continue
                    elif recovery and recovery.get("action") in ("dismiss", "navigate_back", "refresh"):
                        await self._execute_recovery(recovery)
                        self._emit("recovery", recovery)
                        step_result.status = "skipped"
                        status = "partial"
                        continue

                status = "failed"
                break
            elif step_result.status == "skipped":
                if status != "failed":
                    status = "partial"

        duration_ms = int((time.monotonic() - start) * 1000)

        self._emit("flow_complete", {
            "flow": flow.name,
            "status": status,
            "duration_ms": duration_ms,
            "ai_calls": self._ai.stats["calls"],
            "context": ctx.summary(),
        })

        return FlowResult(
            flow=flow,
            status=status,
            steps=step_results,
            duration_ms=duration_ms,
            context_summary=ctx.summary(),
        )

    async def _execute_step(self, step: FlowStep, url_before: str, ctx: FlowContext) -> FlowStepResult:
        """Execute a step. AI makes every key decision."""
        actual_url = self.page.url
        screenshot_b64: str | None = None
        error: str | None = None
        status = "passed"
        method = "Heuristic"

        try:
            # ─── NAVIGATE ───
            if step.action == "navigate":
                target_url = self._resolve_url(step.url_hint or "/")
                await self.page.goto(target_url, wait_until="domcontentloaded", timeout=20000)
                await wait_for_stable_page(self.page, timeout_ms=6000)
                await install_request_tracker(self.page)
                actual_url = self.page.url

            # ─── CLICK ───
            elif step.action == "click":
                el, method = await self._find_element_smart(step.target)
                if el:
                    await el.click()
                    await wait_for_stable_page(self.page, timeout_ms=6000)
                    actual_url = self.page.url
                else:
                    status = "failed"
                    error = f"Could not find element: '{step.target}'"

            # ─── SEARCH ───
            elif step.action == "search":
                el, method = await self._find_element_smart(step.target or "search box")
                if el:
                    # AI decides what to search for
                    if self._ai.available:
                        query = await self._ai.decide_search_query(self.page)
                        method = f"AI search query: '{query}'"
                    else:
                        from agent.utils.test_data import get_search_query
                        query = get_search_query(ctx.site_type)
                    ctx.search_query_used = query
                    await el.fill(query)
                    await el.press("Enter")
                    await wait_for_stable_page(self.page, timeout_ms=8000)
                    actual_url = self.page.url
                else:
                    status = "failed"
                    error = "Search input not found"

            # ─── FILL FORM ───
            elif step.action == "fill_form":
                form_sel = await find_form(self.page, step.target or "form")
                if form_sel:
                    # AI analyzes the form and decides how to fill it
                    if self._ai.available:
                        ai_fields = await self._ai.analyze_form(self.page, form_sel)
                        if ai_fields:
                            filled = await self._fill_form_with_ai(ai_fields)
                            method = f"AI form fill ({filled} fields)"
                            # Submit
                            await self._submit_form(form_sel)
                            await wait_for_stable_page(self.page, timeout_ms=6000)
                            actual_url = self.page.url
                        else:
                            result = await heuristic_fill_form(self.page, form_sel)
                            method = "Heuristic form fill (AI fallback failed)"
                            actual_url = self.page.url
                            if result.outcome == "error" and result.error:
                                error = result.error
                                status = "failed"
                    else:
                        result = await heuristic_fill_form(self.page, form_sel)
                        actual_url = self.page.url
                        if result.outcome == "error" and result.error:
                            error = result.error
                            status = "failed"
                else:
                    status = "failed"
                    error = "Form not found"

            # ─── VERIFY ───
            elif step.action == "verify":
                success, reason = await self._verify_smart(
                    f"verify '{step.target}'", step.verify, url_before,
                )
                if not success:
                    status = "failed"
                    error = reason
                else:
                    error = reason

            # ─── SCREENSHOT ───
            try:
                buf = await self.page.screenshot(full_page=False, type="jpeg", quality=60)
                screenshot_b64 = base64.b64encode(buf).decode("utf-8")
            except Exception:
                pass

            # ─── AI VERIFICATION (after every non-verify action) ───
            if step.verify and status == "passed" and step.action != "verify":
                action_desc = f"{step.action} '{step.target}'"
                success, reason = await self._verify_smart(action_desc, step.verify, url_before)
                method = f"AI verified" if "AI" in reason else method
                if not success:
                    status = "failed"
                    error = reason
                elif not error:
                    error = reason

        except Exception as e:
            status = "failed"
            error = str(e)[:300]

        return FlowStepResult(
            step=step,
            status=status,
            actual_url=actual_url or self.page.url,
            screenshot_b64=screenshot_b64,
            error=error,
            ai_used=method,
        )

    async def _find_element_smart(self, target: str) -> tuple[ElementHandle | None, str]:
        """Find an element: try fast heuristic first, then AI picks the best match."""
        # Fast path: heuristic (instant, no API call)
        el = await find_element(self.page, target)
        if el:
            return el, "Heuristic"

        # AI path: Gemini sees the element list and picks
        if self._ai.available:
            decision = await self._ai.pick_element(self.page, target)
            if decision and isinstance(decision, dict):
                idx = decision.get("index", -1)
                reasoning = decision.get("reasoning", "")
                if idx >= 0:
                    sel = ('a[href], button, input:not([type=hidden]), select, textarea, '
                           '[role="button"], [role="link"], [role="menuitem"], [onclick], '
                           '[role="tab"], summary')
                    els = await self.page.query_selector_all(sel)
                    visible_els = []
                    for e in els:
                        try:
                            if await e.is_visible():
                                visible_els.append(e)
                        except Exception:
                            continue
                    if idx < len(visible_els):
                        return visible_els[idx], f"AI: {reasoning[:60]}"

        # Last resort: scroll and retry heuristic
        try:
            await self.page.evaluate("window.scrollBy(0, window.innerHeight)")
            await self.page.wait_for_timeout(500)
            el = await find_element(self.page, target)
            if el:
                return el, "Heuristic (after scroll)"
            await self.page.evaluate("window.scrollTo(0, 0)")
        except Exception:
            pass

        return None, "not_found"

    async def _fill_form_with_ai(self, ai_fields: list[dict]) -> int:
        """Fill form fields using AI-generated data."""
        filled = 0
        for field_info in ai_fields:
            sel = field_info.get("selector", "")
            value = field_info.get("value", "")
            action = field_info.get("action", "fill")

            if not sel or not value:
                continue

            try:
                el = await self.page.query_selector(sel)
                if not el or not await el.is_visible():
                    continue

                if action == "select":
                    await el.select_option(value)
                elif action == "check":
                    if not await el.is_checked():
                        await el.check()
                else:
                    await el.fill(value)
                filled += 1
            except Exception:
                continue

        return filled

    async def _submit_form(self, form_selector: str):
        """Find and click the form's submit button."""
        submit_sels = [
            f"{form_selector} button[type=submit]",
            f"{form_selector} input[type=submit]",
            f"{form_selector} button:not([type])",
        ]
        for sel in submit_sels:
            try:
                btn = await self.page.query_selector(sel)
                if btn and await btn.is_visible():
                    await btn.click()
                    return
            except Exception:
                continue
        # Fallback: submit via JS
        try:
            await self.page.evaluate(f"document.querySelector('{form_selector}')?.submit()")
        except Exception:
            pass

    async def _verify_smart(self, action_desc: str, expected: str, url_before: str) -> tuple[bool, str]:
        """Verify an action outcome: AI as primary, heuristic as fast check."""
        if not expected:
            return (True, "No verification needed")

        # Quick heuristic checks first (instant)
        expected_lower = expected.lower()

        # Error detection (always check)
        error_text = await self.page.evaluate("""() => {
            const sels = ['[role="alert"]', '.error', '.alert-danger', '[class*="error"]'];
            for (const sel of sels) {
                const el = document.querySelector(sel);
                if (el && el.textContent.trim().length > 5) return el.textContent.trim().substring(0, 200);
            }
            return null;
        }""")
        if error_text:
            return (False, f"Error on page: {error_text}")

        # Redirect check
        if "redirect" in expected_lower:
            if self.page.url != url_before:
                return (True, f"Redirected to {self.page.url}")
            return (False, "Expected redirect but URL unchanged")

        # AI verification (the real deal)
        if self._ai.available:
            return await self._ai.verify_action(self.page, action_desc, expected)

        # Fallback: basic content check
        content = await self.page.evaluate("() => ({words: (document.body?.innerText || '').split(/\\s+/).length})")
        if content.get("words", 0) > 30:
            return (True, f"Content present ({content['words']} words)")
        return (False, "Page appears empty")

    async def _execute_recovery(self, recovery: dict):
        """Execute a recovery action suggested by AI."""
        action = recovery.get("action")
        try:
            if action == "dismiss":
                target = recovery.get("target", "")
                if target:
                    el = await self.page.query_selector(target)
                    if el and await el.is_visible():
                        await el.click()
                        await self.page.wait_for_timeout(500)
            elif action == "navigate_back":
                await self.page.go_back()
                await wait_for_stable_page(self.page, timeout_ms=5000)
            elif action == "refresh":
                await self.page.reload()
                await wait_for_stable_page(self.page, timeout_ms=5000)
        except Exception:
            pass

    def _resolve_url(self, hint: str) -> str:
        if hint.startswith("http"):
            return hint
        parsed = urlparse(self.root_url)
        base = f"{parsed.scheme}://{parsed.netloc}"
        path = hint if hint.startswith("/") else f"/{hint}"
        return base + path

    def _emit(self, event_type: str, data: dict):
        try:
            self._on_progress(event_type, data)
        except Exception:
            pass
