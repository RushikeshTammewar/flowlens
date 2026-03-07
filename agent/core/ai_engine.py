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
    # AUTH: Login wall detection
    # ═══════════════════════════════════════════

    async def detect_auth_wall(self, state: PageState) -> dict:
        """Determine if the current page is a login/auth wall blocking content."""
        parts = []
        if state.screenshot_b64:
            parts.append({"mime_type": "image/png", "data": state.screenshot_b64})

        parts.append(f"""You are a senior QA engineer. Determine if this page is a LOGIN WALL
that blocks access to the actual site content.

URL: {state.url}
Title: {state.title}
Auth state: {self.site_context.auth_state}

A login wall means:
- The page shows a login/sign-in form as the PRIMARY content
- OR the page redirected to a login page (URL contains /login, /signin, /auth, etc.)
- OR the page shows "Please log in" / "Sign in to continue" type messaging
- OR the page is mostly empty/blank because the user isn't authenticated

NOT a login wall:
- A page with a small "Sign in" button in the header but real content visible
- A settings page that reasonably requires auth
- A page with a login OPTION but also public content

Respond JSON:
{{"is_login_wall": true/false, "confidence": "high/medium/low",
  "login_form_visible": true/false,
  "login_task": "If login wall: describe exactly how to log in (e.g. 'Click the email input, type the email, click the password input, type the password, click Sign In'). Empty string if not a login wall.",
  "reason": "1 sentence explanation"}}""")

        result = await self._call(parts)
        if isinstance(result, dict) and "is_login_wall" in result:
            return result
        return {"is_login_wall": False, "confidence": "low", "login_form_visible": False, "login_task": "", "reason": "AI unavailable"}

    # ═══════════════════════════════════════════
    # STAGE 2: Page Assessment
    # ═══════════════════════════════════════════

    async def assess_page(self, state: PageState) -> dict:
        """Look at a page and assess it BEFORE testing.

        This is a lightweight check. Deep analysis is done in assess_and_plan().
        """
        return {}

    async def assess_and_plan(
        self, state: PageState, already_tested: list[str],
    ) -> tuple[dict, list[dict]]:
        """Combined assessment + journey planning in a single AI call.

        Returns (assessment_dict, journeys_list). Saves one Gemini API call per page.
        """
        parts = []
        if state.screenshot_b64:
            parts.append({"mime_type": "image/png", "data": state.screenshot_b64})

        critical_instruction = ""
        if self.site_context.critical_flow and not any("critical" in t.lower() for t in already_tested):
            critical_instruction = f"""
MANDATORY FIRST JOURNEY:
The site's critical flow is: "{self.site_context.critical_flow}"
Your FIRST journey MUST test this. This is the highest priority.
"""

        parts.append(f"""You are a senior QA engineer with 10+ years experience.
Look at this page and do TWO things: assess it, then plan test journeys.

{self.site_context.summary()}

Page: {state.url}
Title: {state.title}
Auth state: {self.site_context.auth_state}
Already tested: {already_tested[:10]}
{critical_instruction}

═══ PART 1: ASSESS THE PAGE ═══

Look for:
- page_purpose: What is this page for?
- visual_issues: Broken layout, missing images, errors, blank areas, overlapping elements
- error_states: Error messages, 404s, 500s, "something went wrong"
- empty_states: Suspiciously empty sections that should have content

═══ PART 2: PLAN TEST JOURNEYS ═══

Plan 3-5 journeys covering THREE CATEGORIES:

1. HAPPY PATH (1-2 journeys): The main use case working correctly. Priority 8-10.

2. NEGATIVE/EDGE CASE (1-2 journeys): Try to BREAK things:
   - Type gibberish into search → graceful "no results"?
   - Submit empty form → validation errors?
   - Invalid data (email without @) → handled?
   - Special characters in inputs
   Priority 6-8.

3. BOUNDARY/STATE (1 journey): Test transitions:
   - Click back after action → page restores?
   - Empty states handled gracefully?
   Priority 5-7.

For each journey, write a CLEAR, SELF-CONTAINED task description.
The browser agent will execute autonomously — be explicit:
- EXACTLY what to type and where (use specific test values)
- EXACTLY what to click
- EXACTLY what to verify

EXAMPLE:
{{"name": "Search happy path", "priority": 10, "requires_auth": false,
  "task": "Find the search input, type 'wireless headphones', press Enter. Verify search results appear.",
  "expected_outcome": "Search results page displays relevant products"}}

RULES:
- Be SPECIFIC: say "type 'laptop'" not "type something"
- Tasks are self-contained — agent has no prior context
- Starting URL: {state.url}
- At least ONE negative/edge case test
- First journey = most critical user action
- Do NOT test footer links, legal pages, cookie banners

Respond JSON:
{{"assessment": {{
    "page_purpose": "...",
    "visual_issues": [...],
    "error_states": [...],
    "empty_states": [...]
  }},
  "journeys": [
    {{"name": "...", "priority": 1-10, "requires_auth": false,
      "task": "...", "expected_outcome": "..."}},
    ...
  ]
}}""")

        result = await self._call(parts)
        if isinstance(result, dict):
            assessment = result.get("assessment", {})
            journeys = result.get("journeys", [])

            if not journeys and "raw" not in result:
                journeys = [v for v in result.values() if isinstance(v, list) and v and isinstance(v[0], dict) and "task" in v[0]]
                journeys = journeys[0] if journeys else []

            for issue in assessment.get("visual_issues", []):
                self.site_context.key_findings.append(f"Visual: {issue}")
            for err in assessment.get("error_states", []):
                self.site_context.key_findings.append(f"Error: {err}")

            return assessment, journeys
        return {}, []

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

        error_states = assessment.get("error_states", [])
        empty_states = assessment.get("empty_states", [])
        visual_issues = assessment.get("visual_issues", [])

        parts.append(f"""You are a senior QA engineer with 10+ years experience. Plan test journeys for this page.
Think like a QA who WANTS to find bugs, not just verify happy paths.

{self.site_context.summary()}

Page: {state.url}
Title: {state.title}
Purpose: {assessment.get('page_purpose', 'unknown')}
Testable features: {testable}
Auth state: {self.site_context.auth_state}
Already tested: {already_tested[:10]}
Visible errors: {error_states}
Empty areas: {empty_states}
Visual issues: {visual_issues}
{critical_instruction}
Plan 3-5 journeys covering THREE CATEGORIES:

1. HAPPY PATH (1-2 journeys): The main use case working correctly.
   Priority 8-10.

2. NEGATIVE/EDGE CASE (1-2 journeys): Try to BREAK things:
   - Type gibberish into search ("asdfghjkl") → does it show "no results" gracefully?
   - Submit an empty form → does it show validation errors?
   - Enter invalid data (email without @, phone with letters) → does it handle it?
   - Navigate to a non-existent sub-page → is there a proper 404?
   - Try special characters: <script>alert(1)</script> in inputs
   Priority 6-8.

3. BOUNDARY/STATE (1 journey): Test transitions and states:
   - Click back after an action → does the page restore correctly?
   - Interact rapidly → does the UI remain responsive?
   - Check if empty states (no items, no results) are handled
   Priority 5-7.

For each journey, write a CLEAR, SELF-CONTAINED task description.
The browser agent has NO prior context — be explicit about:
- EXACTLY what to type and where (use specific test values)
- EXACTLY what to click
- EXACTLY what to verify after each action

EXAMPLE journeys:
{{"name": "Search happy path", "priority": 10, "requires_auth": false,
  "task": "Find the search input on the page, type 'wireless headphones' into it, press Enter or click the search button, then verify that search results appear showing relevant products.",
  "expected_outcome": "Search results page displays products matching the query"}}

{{"name": "Search with gibberish input", "priority": 7, "requires_auth": false,
  "task": "Find the search input, type 'zzzzqqqxxx123' (nonsense), press Enter. Check whether the page shows a graceful 'no results' message or crashes/shows an error page.",
  "expected_outcome": "Page shows a user-friendly 'no results found' message, not a crash or error"}}

{{"name": "Empty form submission", "priority": 8, "requires_auth": false,
  "task": "Find any form on the page (contact, signup, search). Without filling in any fields, click the submit button. Verify that the page shows validation errors or prevents submission.",
  "expected_outcome": "Form shows validation errors for required fields"}}

RULES:
- Be SPECIFIC: say "type 'laptop'" not "type something"
- The task must be self-contained — the browser agent has no prior context
- Include what URL we're starting from: {state.url}
- At least ONE journey must be a negative/edge case test
- First journey MUST be the most critical user action
- Do NOT test footer links, legal pages, language selectors, cookie banners

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
        agent_report = nav_result.get("agent_report", "")

        parts.append(f"""You are a senior QA engineer verifying a test result. Be CRITICAL — your job is to find problems.

Journey: {journey_name}
Expected: {expected_outcome}
Final URL: {state.url}
Navigation errors: {error_str}
Navigation success: {nav_result.get('success', False)}
Actions taken: {nav_result.get('actions_taken', 0)}
Agent's own report: {agent_report or 'none'}

Look at the screenshot carefully and determine the outcome:

- "passed": The expected outcome CLEARLY occurred. Content is correct and complete.
- "failed": Something went wrong — a BUG exists:
  * Error message visible (404, 500, "something went wrong", "undefined", "null")
  * Wrong content shown (search for X but results show Y)
  * Broken layout (overlapping text, cut-off content, elements off-screen)
  * Missing content (empty sections where data should be)
  * Broken images or missing assets
  * Form didn't validate (accepted invalid input that should be rejected)
  * Page crashed or showed a stack trace
- "blocked": Cannot proceed because of auth/permissions/CAPTCHA. NOT a bug.
- "inconclusive": Can't determine the outcome.

CRITICAL RULES:
- Login/auth wall appearing = BLOCKED, not failed
- HTTP errors (404, 500) = FAILED (real bug)
- A page with relevant content matching the expected outcome = PASSED
- Blank or empty page where content was expected = FAILED
- "No results found" for a valid search query = FAILED
- "No results found" for gibberish search = PASSED (correct behavior)
- Navigation error reported but page looks fine = check the screenshot carefully

In the "issues" array, list EVERY problem you see on the page, even minor ones.
These will be logged as bugs, so be specific: "Submit button overlaps the footer on the page"
not just "layout issue".

Respond JSON:
{{"status": "passed|failed|blocked|inconclusive", "reason": "1-2 sentences", "issues": ["specific bug descriptions"], "notes": "any other observations"}}""")

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
