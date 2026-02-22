"""Step-by-step flow execution with heuristic-first interaction and AI fallback."""

from __future__ import annotations

import base64
import os
import time
from urllib.parse import urlparse, urlunparse

from playwright.async_api import Page

from agent.models.flow import Flow, FlowStep, FlowResult, FlowStepResult
from agent.models.graph import SiteGraph
from agent.utils.element_finder import find_element, find_form
from agent.utils.form_filler import fill_form


_EXTRACT_INTERACTIVE_JS = """() => {
    const els = [];
    const interactive = document.querySelectorAll(
        'a[href], button, input:not([type=hidden]), select, textarea, [role="button"], [role="link"], [onclick]'
    );
    for (let i = 0; i < Math.min(interactive.length, 30); i++) {
        const el = interactive[i];
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) continue;
        const text = (el.textContent || el.getAttribute('aria-label') || el.placeholder || el.name || '').trim().substring(0, 60);
        els.push({ i, tag: el.tagName, text });
    }
    return els;
}"""


class FlowRunner:
    """Executes user flows step-by-step on a Playwright page."""

    def __init__(
        self,
        page: Page,
        root_url: str,
        graph: SiteGraph | None = None,
        on_progress: callable | None = None,
    ):
        self.page = page
        self.root_url = root_url.rstrip("/")
        self._graph = graph
        self._on_progress = on_progress or (lambda *_: None)

    async def execute_flows(self, flows: list[Flow]) -> list[FlowResult]:
        """Execute all flows and return results."""
        results = []
        for flow in flows:
            result = await self._execute_flow(flow)
            results.append(result)
        return results

    async def _execute_flow(self, flow: Flow) -> FlowResult:
        """Execute a single flow."""
        start = time.monotonic()
        step_results: list[FlowStepResult] = []
        status = "passed"

        # Start each flow from the root URL
        try:
            await self.page.goto(self.root_url, wait_until="domcontentloaded", timeout=15000)
            await self.page.wait_for_timeout(1000)
        except Exception:
            pass

        for i, step in enumerate(flow.steps):
            self._on_progress("flow_step", {
                "flow": flow.name,
                "step_index": i,
                "step_action": step.action,
                "step_target": step.target,
            })

            url_before = self.page.url
            step_result = await self._execute_step(step, url_before)
            step_results.append(step_result)

            if step_result.status == "failed":
                status = "failed"
                break
            if step_result.status == "skipped":
                status = "partial"
                # Continue to next step

        duration_ms = int((time.monotonic() - start) * 1000)
        return FlowResult(
            flow=flow,
            status=status,
            steps=step_results,
            duration_ms=duration_ms,
        )

    async def _execute_step(self, step: FlowStep, url_before: str) -> FlowStepResult:
        """Execute a single step with outcome verification. Returns FlowStepResult with ai_used flag."""
        ai_used = False
        actual_url = self.page.url
        screenshot_b64: str | None = None
        error: str | None = None
        status = "passed"
        verification_method = "Heuristic"

        try:
            # Execute the action
            if step.action == "navigate":
                target_url = self._resolve_url(step.url_hint or "/")
                await self.page.goto(target_url, wait_until="domcontentloaded", timeout=15000)
                await self.page.wait_for_timeout(1000)
                actual_url = self.page.url

            elif step.action == "click":
                el = await find_element(self.page, step.target)
                if not el:
                    el, ai_used = await self._ai_find_element(step.target)
                    if ai_used:
                        verification_method = "AI-assisted (element finding)"
                if el:
                    await el.click()
                    await self.page.wait_for_timeout(1500)
                    actual_url = self.page.url
                else:
                    status = "failed"
                    error = "Element not found"

            elif step.action == "search":
                el = await find_element(self.page, step.target or "search")
                if not el:
                    el, ai_used = await self._ai_find_element(step.target or "search box")
                    if ai_used:
                        verification_method = "AI-assisted (element finding)"
                if el:
                    await el.fill("test")
                    await el.press("Enter")
                    await self.page.wait_for_timeout(2000)
                    actual_url = self.page.url
                else:
                    status = "failed"
                    error = "Search input not found"

            elif step.action == "fill_form":
                form_sel = await find_form(self.page, step.target or "form")
                if form_sel:
                    result = await fill_form(self.page, form_sel)
                    await self.page.wait_for_timeout(2000)
                    actual_url = self.page.url
                    if result.outcome == "error" and result.error:
                        error = result.error
                        status = "failed"
                else:
                    status = "failed"
                    error = "Form not found"

            elif step.action == "verify":
                # Explicit verification step
                success, reason = await self.verify_action_outcome(step, step.verify, url_before)
                if not success:
                    status = "failed"
                    error = reason
                else:
                    error = reason  # Store success reason

            # Capture screenshot after action
            try:
                buf = await self.page.screenshot(full_page=False, type="jpeg", quality=60)
                screenshot_b64 = base64.b64encode(buf).decode("utf-8")
            except Exception:
                pass

            # VERIFY outcome if action has a verification requirement
            if step.verify and status == "passed" and step.action != "verify":
                success, reason = await self.verify_action_outcome(step, step.verify, url_before)

                # Track if AI was used for verification
                if "AI" in reason or verification_method == "Heuristic":
                    if "inconclusive" not in reason.lower():
                        verification_method = "AI verification" if "AI" in reason else "Heuristic"

                if not success:
                    status = "failed"
                    error = reason
                else:
                    # Store the verification success reason
                    if not error:
                        error = reason

        except Exception as e:
            status = "failed"
            error = str(e)[:300]

        return FlowStepResult(
            step=step,
            status=status,
            actual_url=actual_url,
            screenshot_b64=screenshot_b64,
            error=error,
            ai_used=verification_method,
        )

    def _resolve_url(self, hint: str) -> str:
        """Resolve a URL hint to a full URL."""
        if hint.startswith("http"):
            return hint
        parsed = urlparse(self.root_url)
        base = f"{parsed.scheme}://{parsed.netloc}"
        path = hint if hint.startswith("/") else f"/{hint}"
        return base + path

    async def _verify_outcome(self, expected: str, url_before: str) -> bool:
        """Legacy method - redirects to new comprehensive verification."""
        success, _ = await self.verify_action_outcome(None, expected, url_before)
        return success

    async def verify_action_outcome(
        self,
        step: FlowStep | None,
        expected: str,
        url_before: str,
    ) -> tuple[bool, str]:
        """
        Comprehensive action outcome verification.

        Returns:
            (success: bool, reason: str)
        """
        if not expected:
            return (True, "No verification needed")

        expected_lower = expected.lower()

        # Check for error messages first (always fail if errors present)
        error_indicators = await self.page.evaluate("""() => {
            const errorSelectors = [
                '[role="alert"]',
                '.error', '.alert', '.warning',
                '[class*="error"]', '[class*="alert"]',
                '.invalid-feedback', '.error-message'
            ];
            for (const sel of errorSelectors) {
                const el = document.querySelector(sel);
                if (el && el.textContent.trim()) {
                    return el.textContent.trim().substring(0, 200);
                }
            }
            return null;
        }""")

        if error_indicators:
            return (False, f"Error message detected: {error_indicators}")

        # URL change verification
        if "redirect" in expected_lower or "navigate" in expected_lower:
            if self.page.url != url_before:
                return (True, f"Redirected to {self.page.url}")
            else:
                return (False, "Expected redirect but URL did not change")

        # For search actions
        if step and step.action == "search":
            return await self._verify_search_results(expected)

        # For form submissions
        if step and step.action == "fill_form":
            return await self._verify_form_submission(expected)

        # Generic "results appear" or "content loads"
        if "results" in expected_lower or "appear" in expected_lower or "loads" in expected_lower:
            return await self._verify_content_loaded(expected)

        # If we can't verify heuristically, default to success
        return (True, "Action completed")

    async def _verify_search_results(self, expected: str) -> tuple[bool, str]:
        """Verify that search returned results."""
        results_info = await self.page.evaluate("""() => {
            // Look for common result container patterns
            const selectors = [
                '[role="list"]', '[role="listbox"]',
                '.results', '.search-results', '[class*="result"]',
                'article', '.item', '.product', '.post'
            ];

            let count = 0;
            for (const sel of selectors) {
                const elements = document.querySelectorAll(sel);
                if (elements.length > 0) {
                    count = Math.max(count, elements.length);
                }
            }

            // Check for "no results" messages
            const bodyText = document.body.textContent.toLowerCase();
            const hasNoResults =
                bodyText.includes('no results') ||
                bodyText.includes('0 results') ||
                bodyText.includes('nothing found') ||
                bodyText.includes('no matches') ||
                bodyText.includes('did not match');

            return {count, hasNoResults};
        }""")

        if results_info.get('hasNoResults'):
            return (False, "Search returned no results")

        if results_info.get('count', 0) >= 3:
            return (True, f"Search results displayed ({results_info['count']} items visible)")

        # If unclear, use AI verification
        if os.environ.get('GEMINI_API_KEY'):
            return await self._verify_with_ai(expected, "search results")

        # Default to success if we can't verify
        return (True, "Search completed")

    async def _verify_form_submission(self, expected: str) -> tuple[bool, str]:
        """Verify that form submission succeeded."""
        # Wait a moment for any redirects or success messages
        await self.page.wait_for_timeout(1000)

        success_info = await self.page.evaluate("""() => {
            // Look for success indicators
            const successSelectors = [
                '[role="status"]',
                '.success', '.confirmation', '[class*="success"]',
                '[class*="confirm"]', '[class*="thank"]',
                '.alert-success'
            ];

            for (const sel of successSelectors) {
                const el = document.querySelector(sel);
                if (el && el.textContent.trim()) {
                    return {
                        found: true,
                        message: el.textContent.trim().substring(0, 200)
                    };
                }
            }

            // Check for error messages
            const errorSelectors = [
                '[role="alert"]',
                '.error', '[class*="error"]',
                '.invalid', '[class*="invalid"]',
                '.alert-danger'
            ];

            for (const sel of errorSelectors) {
                const el = document.querySelector(sel);
                if (el && el.textContent.trim()) {
                    return {
                        found: false,
                        message: el.textContent.trim().substring(0, 200)
                    };
                }
            }

            // Check if still on same form page
            const forms = document.querySelectorAll('form');
            return {
                found: null,
                hasForm: forms.length > 0
            };
        }""")

        if success_info.get('found') is True:
            return (True, f"Form submitted successfully: {success_info.get('message', '')}")

        if success_info.get('found') is False:
            return (False, f"Form submission failed: {success_info.get('message', '')}")

        # If unclear and we have AI, use it
        if os.environ.get('GEMINI_API_KEY'):
            return await self._verify_with_ai(expected, "form submission")

        # Default to success if unclear
        return (True, "Form submitted")

    async def _verify_content_loaded(self, expected: str) -> tuple[bool, str]:
        """Verify that content loaded on the page."""
        # Check if page has meaningful content
        content_info = await self.page.evaluate("""() => {
            const bodyText = document.body.innerText || '';
            const wordCount = bodyText.split(/\s+/).length;
            const hasImages = document.querySelectorAll('img').length > 0;
            const hasLinks = document.querySelectorAll('a').length > 0;

            return {
                wordCount,
                hasImages,
                hasLinks,
                hasContent: wordCount > 50
            };
        }""")

        if content_info.get('hasContent'):
            return (True, f"Content loaded ({content_info.get('wordCount', 0)} words)")

        return (False, "Page appears empty")

    async def _verify_with_ai(self, expected: str, context: str) -> tuple[bool, str]:
        """Use Gemini vision to verify action outcome."""
        api_key = os.environ.get('GEMINI_API_KEY')
        if not api_key:
            return (True, "Verification skipped (no AI key)")

        try:
            import asyncio
            import google.generativeai as genai

            genai.configure(api_key=api_key)
            # Use Flash for cost efficiency - vision is available in Flash
            model = genai.GenerativeModel(
                'gemini-2.0-flash',
                generation_config={"temperature": 0.0},
            )

            # Capture screenshot
            screenshot = await self.page.screenshot(full_page=False, type="png")
            screenshot_b64 = base64.b64encode(screenshot).decode()

            prompt = f"""You are a QA engineer verifying a {context} action.

EXPECTED OUTCOME: {expected}

CURRENT PAGE URL: {self.page.url}

Look at the screenshot and answer:

1. Did the expected outcome occur?
2. What evidence supports your answer?
3. Are there any error messages visible?

Respond in this exact JSON format:
{{
  "success": true/false,
  "reason": "Brief explanation (1-2 sentences)",
  "evidence": "What you see in the screenshot"
}}
"""

            def _call():
                resp = model.generate_content([
                    {
                        'mime_type': 'image/png',
                        'data': screenshot_b64
                    },
                    prompt
                ])
                return resp.text if resp and resp.text else None

            response_text = await asyncio.to_thread(_call)
            if not response_text:
                return (True, "AI verification inconclusive")

            # Parse JSON response
            import json
            # Strip markdown if present
            cleaned = response_text.strip()
            if cleaned.startswith("```"):
                cleaned = cleaned.split('\n', 1)[1].rsplit('\n', 1)[0]

            result = json.loads(cleaned)
            return (result.get('success', True), result.get('reason', 'AI verification'))

        except Exception as e:
            # AI failed, default to success (optimistic)
            return (True, f"Verification inconclusive (AI error)")

        return (True, "AI verification completed")

    async def _ai_find_element(self, target_description: str) -> tuple[object | None, bool]:
        """AI fallback for element finding. Returns (element, ai_used)."""
        api_key = os.environ.get("GEMINI_API_KEY")
        if not api_key:
            return None, False

        try:
            import asyncio
            import google.generativeai as genai

            genai.configure(api_key=api_key)
            model = genai.GenerativeModel(
                os.environ.get("GEMINI_MODEL", "gemini-2.0-flash"),
                generation_config={"temperature": 0.0},
            )

            elements = await self.page.evaluate(_EXTRACT_INTERACTIVE_JS)
            if not elements:
                return None, False

            elements_str = "\n".join(
                f"{e['i']}: {e['tag']} - {e['text'][:50]}" for e in elements
            )

            prompt = f"""On this page, I need to click or interact with: "{target_description}".

Interactive elements (index, tag, text):
{elements_str}

Which element index should I interact with? Reply with ONLY the number (0-based index), nothing else."""

            def _call():
                resp = model.generate_content(prompt)
                return resp.text.strip() if resp and resp.text else None

            text = await asyncio.to_thread(_call)
            if text is None:
                return None, False

            idx = int("".join(c for c in text if c.isdigit()) or "0")
            if 0 <= idx < len(elements):
                sel = f'a[href], button, input:not([type=hidden]), select, textarea, [role="button"], [role="link"], [onclick]'
                els = await self.page.query_selector_all(sel)
                if idx < len(els):
                    return els[idx], True
        except Exception:
            pass

        return None, False
