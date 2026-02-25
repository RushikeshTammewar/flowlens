"""Central AI engine for FlowLens -- the brain of the QA agent.

Five-stage AI strategy:
1. Site Understanding -- what kind of site, who uses it, critical paths
2. Page Assessment -- what is this page, what can be done, visual issues
3. Journey Planning -- multi-step user journeys (not single clicks)
4. Step Execution -- find elements, check interactable, act
5. Outcome Verification -- pass/fail/blocked/inconclusive with nuance

Every call includes accumulated context so the AI builds understanding
over time, like a real QA engineer would.
"""

from __future__ import annotations

import asyncio
import base64
import json
import os
import re
from dataclasses import dataclass, field

from playwright.async_api import Page


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
    """Five-stage AI engine with accumulated context."""

    def __init__(self, model_name: str = "gemini-2.5-flash"):
        self._model_name = model_name
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
                        data=base64.b64decode(part["data"]), mime_type=part["mime_type"],
                    ))
            return self._client.models.generate_content(
                model=self._model_name, contents=contents,
            )

        try:
            resp = await asyncio.wait_for(asyncio.to_thread(_sync), timeout=60)
            text = resp.text if resp and resp.text else None
        except asyncio.TimeoutError:
            self._call_count -= 1
            return None
        except Exception:
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

    async def _screenshot_b64(self, page: Page) -> str | None:
        try:
            buf = await page.screenshot(full_page=False, type="png")
            return base64.b64encode(buf).decode()
        except Exception:
            return None

    # ═══════════════════════════════════════════════════════
    # STAGE 1: Site Understanding (once, at start)
    # ═══════════════════════════════════════════════════════

    async def understand_site(self, page: Page) -> SiteContext:
        """Look at the homepage and build a mental model of the site."""
        shot = await self._screenshot_b64(page)
        parts = []
        if shot:
            parts.append({"mime_type": "image/png", "data": shot})

        parts.append(f"""You are a senior QA engineer starting a new testing session.

Look at this website homepage and tell me:

URL: {page.url}
Title: {await page.title()}

1. site_type: What kind of site is this? (saas, ecommerce, news, blog, docs, social, qa_forum, portfolio, corporate, other)
2. target_user: Who uses this site? (1 sentence)
3. core_product: What is the ONE main thing users come here to do? (e.g. "search and read Q&A", "buy products", "read news articles", "manage projects")
4. critical_flow: The SINGLE MOST IMPORTANT user action on this site. What MUST work or the site is useless?
   Describe it as step-by-step browser actions a human would take:
   e.g. for a search site: "type 'machine learning' into the search input, click search button, verify results appear"
   e.g. for a scan tool: "type 'youtube.com' into the URL input, click the scan/submit button, verify redirect to results page"
   e.g. for ecommerce: "search for 'laptop', click first product, verify product page loads with price"
5. main_features: What are the 3-5 most important features visible? (list)
6. requires_auth: What features seem to require login? (list)
7. public_testable: What can be tested WITHOUT logging in? (list)

Respond in JSON:
{{"site_type": "...", "target_user": "...", "core_product": "...", "critical_flow": "step by step description of the most important user action", "main_features": [...], "requires_auth": [...], "public_testable": [...]}}""")

        result = await self._call(parts)
        if isinstance(result, dict) and "site_type" in result:
            self.site_context.site_type = result.get("site_type", "unknown")
            self.site_context.target_user = result.get("target_user", "")
            self.site_context.core_product = result.get("core_product", "")
            self.site_context.critical_flow = result.get("critical_flow", "")
            self.site_context.main_features = result.get("main_features", [])
            self.site_context.critical_paths = result.get("critical_paths", [])
            self.site_context.requires_auth_for = result.get("requires_auth", [])

        return self.site_context

    # ═══════════════════════════════════════════════════════
    # STAGE 2: Page Assessment (per page, before testing)
    # ═══════════════════════════════════════════════════════

    async def assess_page(self, page: Page, elements_summary: str) -> dict:
        """Look at a page and assess it BEFORE testing anything."""
        shot = await self._screenshot_b64(page)
        parts = []
        if shot:
            parts.append({"mime_type": "image/png", "data": shot})

        parts.append(f"""You are a senior QA engineer assessing a page BEFORE testing it.

{self.site_context.summary()}

Current page: {page.url}
Title: {await page.title()}

Interactive elements found:
{elements_summary}

Assess this page:
1. page_purpose: What is this page for? (1 sentence)
2. testable_features: What can be tested here without auth? (list)
3. auth_required_features: What needs login? (list)
4. visual_issues: Any immediately visible problems? (broken layout, missing images, errors) (list, empty if none)
5. disabled_elements: Which elements appear disabled/non-interactive? (list of indices, empty if none)

Respond in JSON:
{{"page_purpose": "...", "testable_features": [...], "auth_required_features": [...], "visual_issues": [...], "disabled_elements": [...]}}""")

        result = await self._call(parts)
        return result if isinstance(result, dict) else {}

    # ═══════════════════════════════════════════════════════
    # STAGE 3: Journey Planning (per page, multi-step)
    # ═══════════════════════════════════════════════════════

    async def plan_journeys(
        self, page: Page, elements_summary: str,
        page_assessment: dict, already_tested: list[str],
    ) -> list[dict]:
        """Plan test journeys with low-level browser commands.

        Returns journeys with direct browser actions (type/click/wait),
        not abstract categories (fill_form/search/nav).
        """
        testable = page_assessment.get("testable_features", [])
        disabled = page_assessment.get("disabled_elements", [])

        shot = await self._screenshot_b64(page)
        parts = []
        if shot:
            parts.append({"mime_type": "image/png", "data": shot})

        critical_flow_instruction = ""
        if self.site_context.critical_flow and "critical_flow" not in str(already_tested):
            critical_flow_instruction = f"""
MANDATORY FIRST JOURNEY:
The site's critical flow is: "{self.site_context.critical_flow}"
Your FIRST journey MUST test this. Plan exact browser actions to execute it.
This is priority 10. If this fails, the site is fundamentally broken.
"""

        parts.append(f"""You are a senior QA engineer. Plan test journeys using DIRECT BROWSER ACTIONS.

{self.site_context.summary()}

Current page: {page.url} — {page_assessment.get('page_purpose', '')}
Auth: {self.site_context.auth_state}
Disabled elements (DO NOT interact): {disabled}
Already tested: {already_tested[:15]}
{critical_flow_instruction}
Elements on page:
{elements_summary}

Plan 2-4 journeys. Each journey uses LOW-LEVEL BROWSER ACTIONS:

AVAILABLE ACTIONS:
- "type": Type text into an element. Needs: selector (CSS selector), value (text to type)
- "click": Click an element. Needs: selector (CSS selector) OR element_index (from element list)
- "press_key": Press a key. Needs: key (e.g. "Enter", "Tab")
- "wait": Wait for something. Needs: condition ("url_changes", "content_loads", "element_appears")
- "verify": Check the page state. Needs: check (what to verify)

DO NOT use abstract actions like "fill_form" or "search". Use type + click + wait instead.

EXAMPLE for a site with a URL input + scan button:
{{"name": "Test core scan feature", "priority": 10, "requires_auth": false,
  "steps": [
    {{"action": "type", "selector": "input[type=text], input[type=url], input[placeholder]", "value": "youtube.com", "describe": "Enter URL in scan input"}},
    {{"action": "click", "selector": "button", "text_contains": "scan", "describe": "Click scan button"}},
    {{"action": "wait", "condition": "url_changes", "describe": "Wait for redirect to results"}},
    {{"action": "verify", "check": "page shows scan results or loading state", "describe": "Verify scan started"}}
  ]
}}

EXAMPLE for a site with search:
{{"name": "Search and explore", "priority": 10, "requires_auth": false,
  "steps": [
    {{"action": "type", "selector": "input[name=q], input[type=search], [role=search] input", "value": "machine learning", "describe": "Type search query"}},
    {{"action": "press_key", "key": "Enter", "describe": "Submit search"}},
    {{"action": "wait", "condition": "content_loads", "describe": "Wait for results"}},
    {{"action": "verify", "check": "search results are displayed", "describe": "Verify results appear"}}
  ]
}}

RULES:
- ALWAYS use element_index from the element list above. This is the MOST RELIABLE way to target elements.
- Only use CSS "selector" field as a FALLBACK if element_index doesn't apply (e.g. on a new page after navigation)
- For buttons: use text_contains to match button text (case insensitive) as additional fallback
- For type/input actions: ALWAYS include both element_index AND a selector
- DO NOT interact with disabled elements
- NEVER test footer links, legal pages, language selectors
- The first journey MUST be the most critical user action on this site

Respond JSON:
{{"journeys": [...], "auth_blocked_features": [...]
}}""")

        result = await self._call(parts)
        if isinstance(result, dict) and "journeys" in result:
            return result["journeys"]
        return []

    # ═══════════════════════════════════════════════════════
    # STAGE 4: Element Finding (per step)
    # ═══════════════════════════════════════════════════════

    async def find_element_for_step(self, page: Page, step_description: str) -> dict | None:
        """AI finds the right element on a NEW page (after navigation)."""
        shot = await self._screenshot_b64(page)
        parts = []
        if shot:
            parts.append({"mime_type": "image/png", "data": shot})

        elements = await page.evaluate("""() => {
            const els = [];
            const interactive = document.querySelectorAll(
                'a[href], button, input:not([type=hidden]), select, textarea, ' +
                '[role="button"], [role="link"], [role="menuitem"], [onclick], summary'
            );
            for (let i = 0; i < Math.min(interactive.length, 50); i++) {
                const el = interactive[i];
                const rect = el.getBoundingClientRect();
                if (rect.width === 0 && rect.height === 0) continue;
                const text = (el.textContent || '').trim().substring(0, 80);
                const ariaLabel = el.getAttribute('aria-label') || '';
                const href = el.href || '';
                const disabled = el.disabled || el.getAttribute('aria-disabled') === 'true';
                els.push({i, tag: el.tagName, text, ariaLabel, href: href.substring(0, 80), disabled});
            }
            return els;
        }""")

        if not elements:
            return None

        elements_str = "\n".join(
            f"[{e['i']}] <{e['tag']}> text='{e['text'][:50]}' aria='{e['ariaLabel'][:30]}' href='{e['href'][:50]}' disabled={e['disabled']}"
            for e in elements
        )

        parts.append(f"""Find the element that best matches: "{step_description}"

Page: {page.url}
Elements:
{elements_str}

Pick the best match. DO NOT pick disabled elements.
Respond JSON: {{"index": <number>, "reasoning": "why"}}
If no match: {{"index": -1, "reasoning": "why not found"}}""")

        return await self._call(parts)

    async def decide_search_query(self, page: Page) -> str:
        """AI decides what to search for based on the site context."""
        result = await self._call([
            f"""What would a real user search for on this site?

Site: {self.site_context.site_type} — {', '.join(self.site_context.main_features[:3])}
URL: {page.url}
Title: {await page.title()}

Pick a specific, realistic search query. Not "test" — something a real person would type.

Respond JSON: {{"query": "...", "reasoning": "..."}}"""
        ])
        if isinstance(result, dict) and "query" in result:
            return result["query"]
        return "test"

    async def analyze_form(self, page: Page, form_selector: str) -> list[dict]:
        """AI analyzes form fields and decides what data to enter."""
        form_info = await page.evaluate("""(sel) => {
            const form = document.querySelector(sel);
            if (!form) return null;
            const fields = [];
            for (const el of form.querySelectorAll('input, select, textarea')) {
                const type = (el.getAttribute('type') || el.tagName.toLowerCase()).toLowerCase();
                if (['hidden','submit','button','reset','image'].includes(type)) continue;
                const rect = el.getBoundingClientRect();
                if (rect.width === 0 && rect.height === 0) continue;
                let label = '';
                if (el.id) { const lbl = document.querySelector(`label[for="${el.id}"]`); if (lbl) label = lbl.textContent.trim().substring(0, 80); }
                if (!label) { const p = el.closest('label'); if (p) label = p.textContent.trim().substring(0, 80); }
                let selector = el.id ? '#' + CSS.escape(el.id) : (el.name ? `${sel} [name="${el.name}"]` : `${sel} ${el.tagName.toLowerCase()}[type="${type}"]`);
                fields.push({selector, tag: el.tagName.toLowerCase(), type, name: el.name||'', placeholder: el.placeholder||'', label, required: el.required, autocomplete: el.autocomplete||'', disabled: el.disabled});
            }
            return {fields, url: location.href, title: document.title, action: form.action||''};
        }""", form_selector)

        if not form_info or not form_info.get("fields"):
            return []

        fields_str = "\n".join(
            f"- [{f['selector']}] type={f['type']} name='{f['name']}' label='{f['label'][:40]}' placeholder='{f['placeholder'][:40]}' required={f['required']} disabled={f['disabled']}"
            for f in form_info["fields"]
        )

        result = await self._call([
            f"""Fill this form with realistic test data.

Site: {self.site_context.site_type}
Page: {form_info.get('url', '')}
Form action: {form_info.get('action', '')}

Fields:
{fields_str}

Rules:
- Use unique email like flowlens.test.{os.urandom(4).hex()}@gmail.com
- Use strong password: TestPass2026!
- Use realistic names, phones, addresses
- Skip disabled fields
- Required fields MUST be filled

Respond JSON: {{"fields": [{{"selector": "...", "value": "...", "action": "fill|select|check"}}]}}"""])

        if isinstance(result, dict) and "fields" in result:
            return result["fields"]
        return []

    # ═══════════════════════════════════════════════════════
    # STAGE 5: Outcome Verification (per step, nuanced)
    # ═══════════════════════════════════════════════════════

    async def verify_step(self, page: Page, action_desc: str, expected: str) -> dict:
        """Verify a step outcome with nuance. Returns status + reason.

        Possible statuses: passed, failed, blocked, inconclusive
        """
        shot = await self._screenshot_b64(page)
        parts = []
        if shot:
            parts.append({"mime_type": "image/png", "data": shot})

        parts.append(f"""You performed: {action_desc}
Expected: {expected}
URL: {page.url}

Look at the screenshot and determine the outcome. Choose ONE:

- "passed": The expected outcome clearly occurred. Describe the evidence.
- "failed": Something UNEXPECTED happened that indicates a BUG. (Error message, wrong content, broken UI, crash). Describe the bug.
- "blocked": Cannot proceed because of auth/permissions/CAPTCHA. This is NOT a bug — it's a prerequisite we don't have.
- "inconclusive": Can't determine the outcome. Don't have enough information.

IMPORTANT distinctions:
- A login page appearing is BLOCKED, not failed (auth required)
- A disabled button is an OBSERVATION, not a failure
- An error message like "404" or "500" IS a failure (actual bug)
- A page loading with content IS a pass
- A blank page with no content IS a failure
- A slow page is a PERFORMANCE NOTE, not a failure

Respond JSON: {{"status": "passed|failed|blocked|inconclusive", "reason": "1-2 sentences", "issues": ["any bugs or problems noticed"], "notes": "any observations"}}""")

        result = await self._call(parts)
        if isinstance(result, dict) and "status" in result:
            return result
        return {"status": "inconclusive", "reason": "AI verification unavailable"}

    async def assess_page_quality(self, page: Page) -> list[dict]:
        """Visual quality check of the page."""
        shot = await self._screenshot_b64(page)
        if not shot:
            return []

        result = await self._call([
            {"mime_type": "image/png", "data": shot},
            f"""Senior QA engineer reviewing page quality.

URL: {page.url}

Report ONLY clear, definite issues (not subjective opinions):
- Broken images, overlapping text, cut-off content
- Error messages, warning banners
- Empty sections that should have content
- Broken navigation or layout

Do NOT report: subjective design opinions, minor spacing issues, expected login gates.

Respond JSON: {{"issues": [{{"title": "...", "severity": "P1|P2|P3|P4", "description": "..."}}], "quality": "good|acceptable|poor"}}
If the page looks fine: {{"issues": [], "quality": "good"}}""",
        ])

        if isinstance(result, dict):
            return result.get("issues", [])
        return []

    async def investigate_failure(self, page: Page, flow_name: str, error: str) -> dict | None:
        """When the critical flow fails, investigate WHY and suggest a retry approach."""
        shot = await self._screenshot_b64(page)
        parts = []
        if shot:
            parts.append({"mime_type": "image/png", "data": shot})

        # Also check console errors
        console_errors = await page.evaluate("""() => {
            return window.__flowlens_console_errors || [];
        }""") if True else []

        parts.append(f"""The site's CRITICAL FLOW just failed. This is a serious issue.

Flow: {flow_name}
Error: {error}
URL: {page.url}
Console errors: {str(console_errors)[:500] if console_errors else "none"}

Look at the screenshot and investigate:
1. WHY did it fail? What went wrong?
2. Is there an ALTERNATIVE way to accomplish the same action?
3. Should we retry with a different approach?

Possible causes:
- Button was outside a form tag (try clicking directly)
- Element selector was wrong (try a different selector)
- Page requires interaction first (dismiss popup, accept cookies)
- Element was dynamically loaded (need to wait longer)

Respond JSON:
{{"cause": "why it failed", "severity": "P0|P1|P2", "retry_steps": [{{"action": "...", "selector": "...", "value": "..."}}], "is_bug": true/false, "bug_description": "if it's a real bug, describe it"}}""")

        return await self._call(parts)

    async def decide_recovery(self, page: Page, error: str, context: str) -> dict | None:
        """AI decides how to recover from an error."""
        result = await self._call([
            f"""QA testing error. URL: {page.url}
Error: {error}
Context: {context}

Options: dismiss (click close button), navigate_back, refresh, skip, abort
Respond JSON: {{"action": "...", "reasoning": "..."}}"""])

        return result if isinstance(result, dict) else None
