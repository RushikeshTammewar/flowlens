"""Central AI engine for FlowLens -- the brain of the QA agent.

Every non-trivial decision goes through this engine. It uses Gemini 2.0
Flash for all calls (vision + text). Heuristics are used only as a
fast-path optimization; AI is the authoritative decision maker.

Usage: one GeminiEngine instance per scan, shared across all modules.
"""

from __future__ import annotations

import asyncio
import base64
import json
import os
import re
from dataclasses import dataclass

from playwright.async_api import Page


@dataclass
class AIDecision:
    """A decision made by the AI engine."""
    action: str
    target: str
    reasoning: str
    confidence: float  # 0.0 - 1.0
    raw_response: str = ""


class GeminiEngine:
    """Wraps all Gemini API interactions for the QA agent."""

    def __init__(self, model_name: str = "gemini-2.0-flash"):
        self._model_name = model_name
        self._model = None
        self._call_count = 0
        self._total_tokens = 0

    def _ensure_model(self):
        if self._model:
            return
        api_key = os.environ.get("GEMINI_API_KEY")
        if not api_key:
            raise RuntimeError("GEMINI_API_KEY not set")
        import google.generativeai as genai
        genai.configure(api_key=api_key)
        self._model = genai.GenerativeModel(
            self._model_name,
            generation_config={"temperature": 0.0},
        )

    @property
    def available(self) -> bool:
        return bool(os.environ.get("GEMINI_API_KEY"))

    @property
    def stats(self) -> dict:
        return {"calls": self._call_count, "model": self._model_name}

    async def _call(self, parts: list, expect_json: bool = True) -> str | dict | None:
        """Make a Gemini API call. Returns parsed JSON if expect_json, else raw text."""
        if not self.available:
            return None

        self._ensure_model()
        self._call_count += 1

        def _sync():
            resp = self._model.generate_content(parts)
            return resp.text if resp and resp.text else None

        text = await asyncio.to_thread(_sync)
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

    async def pick_element(self, page: Page, target_description: str) -> dict | None:
        """AI looks at the page and picks the best element to interact with.

        Returns {"index": int, "reasoning": str} or None.
        """
        elements = await page.evaluate("""() => {
            const els = [];
            const interactive = document.querySelectorAll(
                'a[href], button, input:not([type=hidden]), select, textarea, ' +
                '[role="button"], [role="link"], [role="menuitem"], [onclick], ' +
                '[role="tab"], [role="checkbox"], [role="radio"], summary'
            );
            for (let i = 0; i < Math.min(interactive.length, 50); i++) {
                const el = interactive[i];
                const rect = el.getBoundingClientRect();
                if (rect.width === 0 && rect.height === 0) continue;
                const text = (el.textContent || '').trim().substring(0, 80);
                const ariaLabel = el.getAttribute('aria-label') || '';
                const placeholder = el.placeholder || '';
                const href = el.href || el.getAttribute('data-href') || '';
                const type = el.type || el.tagName.toLowerCase();
                els.push({i, tag: el.tagName, type, text, ariaLabel, placeholder, href: href.substring(0, 100)});
            }
            return els;
        }""")

        if not elements:
            return None

        elements_str = "\n".join(
            f"[{e['i']}] <{e['tag']}> type={e['type']} text='{e['text'][:60]}' aria='{e['ariaLabel'][:40]}' href='{e['href'][:60]}'"
            for e in elements
        )

        result = await self._call([
            f"""You are a senior QA engineer testing a website. You need to interact with: "{target_description}"

Current page URL: {page.url}

Interactive elements on the page:
{elements_str}

Which element best matches what I need to interact with?

Respond in JSON: {{"index": <number>, "reasoning": "why this element"}}
If no element matches, respond: {{"index": -1, "reasoning": "why not found"}}"""
        ])

        return result

    async def decide_search_query(self, page: Page) -> str:
        """AI reads the page and decides what a real user would search for."""
        page_context = await page.evaluate("""() => {
            const title = document.title || '';
            const h1 = document.querySelector('h1')?.textContent?.trim() || '';
            const meta = document.querySelector('meta[name="description"]')?.content || '';
            const navLinks = [...document.querySelectorAll('nav a')].map(a => a.textContent.trim()).filter(Boolean).slice(0, 10);
            const bodyText = (document.body?.innerText || '').substring(0, 2000);
            return {title, h1, meta, navLinks, bodyText};
        }""")

        result = await self._call([
            f"""You are a senior QA engineer testing a website's search functionality.

Site URL: {page.url}
Page title: {page_context.get('title', '')}
Main heading: {page_context.get('h1', '')}
Description: {page_context.get('meta', '')}
Navigation links: {', '.join(page_context.get('navLinks', []))}
Page content (first 2000 chars): {page_context.get('bodyText', '')[:1500]}

What would a real user search for on this site? Pick a specific, realistic search query that would return meaningful results.

Respond in JSON: {{"query": "your search query", "reasoning": "why this query"}}"""
        ])

        if isinstance(result, dict) and "query" in result:
            return result["query"]
        return "test"

    async def analyze_form(self, page: Page, form_selector: str) -> list[dict]:
        """AI analyzes a form and decides what data to put in each field."""
        form_info = await page.evaluate("""(sel) => {
            const form = document.querySelector(sel);
            if (!form) return null;
            const fields = [];
            const inputs = form.querySelectorAll('input, select, textarea');
            for (const el of inputs) {
                const type = (el.getAttribute('type') || el.tagName.toLowerCase()).toLowerCase();
                if (['hidden', 'submit', 'button', 'reset', 'image'].includes(type)) continue;
                const rect = el.getBoundingClientRect();
                if (rect.width === 0 && rect.height === 0) continue;

                let label = '';
                if (el.id) {
                    const lbl = document.querySelector(`label[for="${el.id}"]`);
                    if (lbl) label = lbl.textContent.trim().substring(0, 100);
                }
                if (!label) {
                    const parent = el.closest('label');
                    if (parent) label = parent.textContent.trim().substring(0, 100);
                }

                let selector = '';
                if (el.id) selector = '#' + CSS.escape(el.id);
                else if (el.name) selector = `${sel} [name="${el.name}"]`;
                else selector = `${sel} ${el.tagName.toLowerCase()}[type="${type}"]`;

                fields.push({
                    selector,
                    tag: el.tagName.toLowerCase(),
                    type,
                    name: el.name || '',
                    placeholder: el.placeholder || '',
                    label,
                    required: el.required,
                    value: el.value || '',
                    autocomplete: el.autocomplete || '',
                });
            }
            const title = document.title || '';
            const url = window.location.href;
            const formAction = form.action || '';
            return {fields, title, url, formAction};
        }""", form_selector)

        if not form_info or not form_info.get("fields"):
            return []

        fields_str = "\n".join(
            f"- [{f['selector']}] type={f['type']} name='{f['name']}' "
            f"label='{f['label'][:50]}' placeholder='{f['placeholder'][:50]}' "
            f"required={f['required']} autocomplete='{f['autocomplete']}'"
            for f in form_info["fields"]
        )

        result = await self._call([
            f"""You are a senior QA engineer filling a form on a website.

Page URL: {form_info.get('url', '')}
Page title: {form_info.get('title', '')}
Form action: {form_info.get('formAction', '')}

Form fields:
{fields_str}

For each field, decide what test data a QA engineer would enter. Use realistic but fake data.
Rules:
- Email: use a unique test email like flowlens.test.xxx@gmail.com
- Password: use a strong test password like TestPass2026!
- Phone: use a realistic fake phone number
- Names: use realistic fake names
- Addresses: use realistic fake addresses
- For dropdowns/selects: pick the first non-empty option
- Required fields MUST be filled

Respond in JSON: {{"fields": [{{"selector": "...", "value": "...", "action": "fill|select|check"}}]}}"""
        ])

        if isinstance(result, dict) and "fields" in result:
            return result["fields"]
        return []

    async def verify_action(self, page: Page, action_description: str, expected_outcome: str) -> tuple[bool, str]:
        """AI looks at the page screenshot and verifies if an action succeeded."""
        try:
            screenshot = await page.screenshot(full_page=False, type="png")
            screenshot_b64 = base64.b64encode(screenshot).decode()
        except Exception:
            return (True, "Could not capture screenshot for verification")

        result = await self._call([
            {"mime_type": "image/png", "data": screenshot_b64},
            f"""You are a senior QA engineer verifying that a user action succeeded.

ACTION PERFORMED: {action_description}
EXPECTED OUTCOME: {expected_outcome}
CURRENT URL: {page.url}

Look at the screenshot carefully and answer:
1. Did the expected outcome occur? Be strict -- if it's ambiguous, say false.
2. Are there any error messages, broken layouts, or unexpected states visible?
3. Does the page look like it loaded correctly?

Respond in JSON only:
{{"success": true/false, "reason": "1-2 sentence explanation", "issues": ["any problems noticed"]}}"""
        ])

        if isinstance(result, dict):
            success = result.get("success", True)
            reason = result.get("reason", "AI verification")
            issues = result.get("issues", [])
            extra = f" Issues: {'; '.join(issues)}" if issues else ""
            return (success, f"{reason}{extra}")

        return (True, "AI verification inconclusive")

    async def assess_page_quality(self, page: Page) -> list[dict]:
        """AI looks at the page and reports anything that looks wrong -- like a QA engineer would."""
        try:
            screenshot = await page.screenshot(full_page=False, type="png")
            screenshot_b64 = base64.b64encode(screenshot).decode()
        except Exception:
            return []

        result = await self._call([
            {"mime_type": "image/png", "data": screenshot_b64},
            f"""You are a senior QA engineer reviewing a webpage for bugs and issues.

URL: {page.url}

Look at the screenshot and report ANY issues you see. Be thorough but avoid false positives.

Check for:
- Overlapping or cut-off text
- Broken layout or misaligned elements
- Missing images or icons
- Unreadable text (too small, low contrast)
- Broken navigation or menus
- Error messages or warnings
- Empty sections that should have content
- UI elements that look broken or incomplete

Respond in JSON: {{"issues": [{{"title": "...", "severity": "P1|P2|P3|P4", "description": "..."}}], "overall_quality": "good|acceptable|poor"}}
If the page looks fine, respond: {{"issues": [], "overall_quality": "good"}}"""
        ])

        if isinstance(result, dict):
            return result.get("issues", [])
        return []

    async def decide_recovery_action(self, page: Page, error_description: str, flow_context: str) -> dict | None:
        """AI decides how to recover from an unexpected state."""
        result = await self._call([
            f"""You are a senior QA engineer. An unexpected situation occurred during testing.

URL: {page.url}
Error: {error_description}
Flow context: {flow_context}

What should I do to recover and continue testing?

Options:
- "dismiss": Click a close/dismiss button (specify selector)
- "navigate_back": Go back to the previous page
- "refresh": Refresh the page and retry
- "skip": Skip this step and continue
- "abort": Stop this flow (unrecoverable)

Respond in JSON: {{"action": "dismiss|navigate_back|refresh|skip|abort", "target": "selector if needed", "reasoning": "why"}}"""
        ])

        return result if isinstance(result, dict) else None
