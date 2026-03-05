"""QA-focused AI engine for FlowLens.

Five-stage strategy (unchanged from v1):
1. Site Understanding  – what kind of site, critical flows
2. Page Assessment     – what's on this page, what's testable
3. Journey Planning    – what flows to test (now outputs NL tasks for Browser-Use)
4. Outcome Verification – did the journey pass/fail/block
5. Failure Investigation – why did the critical flow fail

v2 change: methods accept PageState (url + title + screenshot_b64) instead
of a Playwright Page object. Screenshots come from NavigationEngine.
"""

from __future__ import annotations

import asyncio
import base64
import json
import os
import re
from dataclasses import dataclass, field

from agent.core.navigation_engine import PageState


@dataclass
class SiteContext:
    """Accumulated understanding of the site, built over the scan."""
    site_type: str = ""
    target_user: str = ""
    core_product: str = ""
    critical_flow: str = ""
    main_features: list[str] = field(default_factory=list)
    critical_paths: list[str] = field(default_factory=list)
    requires_auth_for: list[str] = field(default_factory=list)
    pages_visited: list[str] = field(default_factory=list)
    journeys_completed: list[dict] = field(default_factory=list)
    key_findings: list[str] = field(default_factory=list)
    auth_state: str = "not logged in"

    def summary(self) -> str:
        parts = [f"Site type: {self.site_type or 'unknown'}"]
        if self.core_product:
            parts.append(f"Core product: {self.core_product}")
        if self.main_features:
            parts.append(f"Features: {', '.join(self.main_features[:5])}")
        parts.append(f"Auth: {self.auth_state}")
        parts.append(f"Pages visited: {len(self.pages_visited)}")
        if self.journeys_completed:
            passed = sum(1 for j in self.journeys_completed if j.get("status") == "passed")
            parts.append(f"Journeys: {passed}/{len(self.journeys_completed)} passed")
        if self.key_findings:
            parts.append(f"Findings: {'; '.join(self.key_findings[-5:])}")
        return " | ".join(parts)


class GeminiEngine:
    """Five-stage QA AI engine."""

    def __init__(self, model_name: str | None = None):
        self._model_name = model_name or os.environ.get("GEMINI_MODEL", "gemini-2.5-flash")
        self._client = None
        self._call_count = 0
        self.site_context = SiteContext()

    def _ensure_client(self):
        if self._client:
            return
        api_key = os.environ.get("GEMINI_API_KEY")
        if not api_key:
            raise RuntimeError("GEMINI_API_KEY not set")
        from google import genai
        self._client = genai.Client(api_key=api_key)

    @property
    def available(self) -> bool:
        return bool(os.environ.get("GEMINI_API_KEY"))

    @property
    def stats(self) -> dict:
        return {"calls": self._call_count, "model": self._model_name}

    async def _call(self, parts: list, expect_json: bool = True) -> str | dict | None:
        if not self.available:
            return None
        self._ensure_client()
        self._call_count += 1

        def _sync():
            contents = []
            for part in parts:
                if isinstance(part, str):
                    contents.append(part)
                elif isinstance(part, dict) and "mime_type" in part:
                    from google.genai import types
                    contents.append(types.Part.from_bytes(
                        data=base64.b64decode(part["data"]),
                        mime_type=part["mime_type"],
                    ))
            return self._client.models.generate_content(
                model=self._model_name, contents=contents,
            )

        try:
            resp = await asyncio.wait_for(asyncio.to_thread(_sync), timeout=60)
            text = resp.text if resp and resp.text else None
        except (asyncio.TimeoutError, Exception):
            self._call_count -= 1
            return None

        if not text:
            return None
        if not expect_json:
            return text.strip()

        cleaned = text.strip()
        if cleaned.startswith("```"):
            cleaned = re.sub(r"^```\w*\n?", "", cleaned)
            cleaned = re.sub(r"\n?```\s*$", "", cleaned)
        try:
            return json.loads(cleaned)
        except json.JSONDecodeError:
            return {"raw": cleaned}

    # ═══════════════════════════════════════════
    # STAGE 1: Site Understanding
    # ═══════════════════════════════════════════

    async def understand_site(self, state: PageState) -> SiteContext:
        """Look at the homepage screenshot and build a mental model."""
        parts = []
        if state.screenshot_b64:
            parts.append({"mime_type": "image/png", "data": state.screenshot_b64})

        parts.append(f"""You are a senior QA engineer starting a new testing session.

Look at this website homepage and tell me:

URL: {state.url}
Title: {state.title}

1. site_type: What kind of site? (saas, ecommerce, news, blog, docs, social, qa_forum, portfolio, corporate, other)
2. target_user: Who uses this site?
3. core_product: The ONE main thing users come here to do
4. critical_flow: The SINGLE MOST IMPORTANT user action. Describe it step-by-step:
   e.g. "type 'laptop' into search, click search, verify product results appear"
5. main_features: 3-5 most important features visible
6. requires_auth: Features that need login
7. public_testable: Features testable without login

Respond JSON:
{{"site_type": "...", "target_user": "...", "core_product": "...", "critical_flow": "...", "main_features": [...], "requires_auth": [...], "public_testable": [...]}}""")

        result = await self._call(parts)
        if isinstance(result, dict) and "site_type" in result:
            self.site_context.site_type = result.get("site_type", "unknown")
            self.site_context.target_user = result.get("target_user", "")
            self.site_context.core_product = result.get("core_product", "")
            self.site_context.critical_flow = result.get("critical_flow", "")
            self.site_context.main_features = result.get("main_features", [])
            self.site_context.requires_auth_for = result.get("requires_auth", [])
        return self.site_context

    # ═══════════════════════════════════════════
    # STAGE 2: Page Assessment
    # ═══════════════════════════════════════════

    async def assess_page(self, state: PageState) -> dict:
        """Look at a page and assess it BEFORE testing."""
        parts = []
        if state.screenshot_b64:
            parts.append({"mime_type": "image/png", "data": state.screenshot_b64})

        parts.append(f"""You are a senior QA engineer assessing a page BEFORE testing it.

{self.site_context.summary()}

Page: {state.url}
Title: {state.title}

Assess:
1. page_purpose: What is this page for?
2. testable_features: What can be tested here without auth?
3. auth_required_features: What needs login?
4. visual_issues: Any visible problems? (broken layout, missing images, errors)

Respond JSON:
{{"page_purpose": "...", "testable_features": [...], "auth_required_features": [...], "visual_issues": [...]}}""")

        result = await self._call(parts)
        return result if isinstance(result, dict) else {}

    # ═══════════════════════════════════════════
    # STAGE 3: Journey Planning
    # ═══════════════════════════════════════════

    async def plan_journeys(
        self, state: PageState, assessment: dict, already_tested: list[str],
    ) -> list[dict]:
        """Plan test journeys as natural-language task descriptions.

        v2 change: instead of returning low-level browser commands with
        element indices, returns high-level task descriptions that
        Browser-Use's agent will execute autonomously.
        """
        parts = []
        if state.screenshot_b64:
            parts.append({"mime_type": "image/png", "data": state.screenshot_b64})

        testable = assessment.get("testable_features", [])

        critical_instruction = ""
        if self.site_context.critical_flow and not any("critical" in t.lower() for t in already_tested):
            critical_instruction = f"""
MANDATORY FIRST JOURNEY:
The site's critical flow is: "{self.site_context.critical_flow}"
Your FIRST journey MUST test this. This is the highest priority.
"""

        parts.append(f"""You are a senior QA engineer. Plan test journeys for this page.

{self.site_context.summary()}

Page: {state.url}
Title: {state.title}
Purpose: {assessment.get('page_purpose', 'unknown')}
Testable features: {testable}
Auth state: {self.site_context.auth_state}
Already tested: {already_tested[:10]}
{critical_instruction}
Plan 2-4 journeys. For each journey, write a CLEAR TASK DESCRIPTION
that tells a browser agent exactly what to do. Be specific about:
- What to type and where
- What to click
- What to verify after each action

EXAMPLE journeys:
{{"name": "Test search", "priority": 10, "requires_auth": false,
  "task": "Find the search input on the page, type 'wireless headphones' into it, press Enter or click the search button, then verify that search results appear showing relevant products.",
  "expected_outcome": "Search results page displays products matching the query"}}

{{"name": "Test category navigation", "priority": 7, "requires_auth": false,
  "task": "Find and click the 'Electronics' category link in the navigation menu. Wait for the page to load. Verify that the page shows electronics products with prices.",
  "expected_outcome": "Category page shows filtered products"}}

RULES:
- Be SPECIFIC: say "type 'laptop'" not "type something"
- The task must be self-contained — the browser agent has no prior context
- Include what URL we're starting from if relevant
- Include WHAT to verify (expected outcome)
- First journey MUST be the most critical user action
- Do NOT test footer links, legal pages, language selectors

Respond JSON:
{{"journeys": [
  {{"name": "...", "priority": 1-10, "requires_auth": false,
    "task": "...", "expected_outcome": "..."}},
  ...
]}}""")

        result = await self._call(parts)
        if isinstance(result, dict) and "journeys" in result:
            return result["journeys"]
        return []

    # ═══════════════════════════════════════════
    # STAGE 4: Outcome Verification
    # ═══════════════════════════════════════════

    async def verify_outcome(
        self, state: PageState, journey_name: str,
        expected_outcome: str, nav_result: dict,
    ) -> dict:
        """Verify whether a journey achieved its expected outcome."""
        parts = []
        if state.screenshot_b64:
            parts.append({"mime_type": "image/png", "data": state.screenshot_b64})

        errors = nav_result.get("errors", [])
        error_str = "; ".join(errors[:3]) if errors else "none"

        parts.append(f"""You just completed a QA test journey.

Journey: {journey_name}
Expected: {expected_outcome}
Final URL: {state.url}
Navigation errors: {error_str}
Navigation success: {nav_result.get('success', False)}
Actions taken: {nav_result.get('actions_taken', 0)}

Look at the screenshot and determine the outcome:

- "passed": The expected outcome clearly occurred.
- "failed": Something UNEXPECTED happened indicating a BUG (error message, wrong content, broken UI).
- "blocked": Cannot proceed because of auth/permissions/CAPTCHA. NOT a bug.
- "inconclusive": Can't determine the outcome.

IMPORTANT:
- Login page appearing = BLOCKED, not failed
- An error like "404" or "500" = FAILED (real bug)
- A page with relevant content = PASSED
- Blank or empty page = FAILED

Respond JSON:
{{"status": "passed|failed|blocked|inconclusive", "reason": "1-2 sentences", "issues": ["any bugs noticed"], "notes": "observations"}}""")

        result = await self._call(parts)
        if isinstance(result, dict) and "status" in result:
            return result
        return {"status": "inconclusive", "reason": "AI verification unavailable"}

    # ═══════════════════════════════════════════
    # STAGE 5: Failure Investigation
    # ═══════════════════════════════════════════

    async def investigate_failure(
        self, state: PageState, flow_name: str, error: str,
    ) -> dict | None:
        """When the critical flow fails, investigate why."""
        parts = []
        if state.screenshot_b64:
            parts.append({"mime_type": "image/png", "data": state.screenshot_b64})

        parts.append(f"""The site's CRITICAL FLOW just failed.

Flow: {flow_name}
Error: {error}
URL: {state.url}

Investigate:
1. WHY did it fail?
2. Is there an ALTERNATIVE approach?
3. Is this a real bug on the site?

Respond JSON:
{{"cause": "why it failed", "is_bug": true/false, "bug_description": "if real bug, describe it", "alternative_task": "rephrased task to retry, or empty string if no alternative"}}""")

        return await self._call(parts)
