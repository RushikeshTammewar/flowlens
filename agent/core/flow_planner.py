"""Flow identification from site graph using Gemini Flash.

Identifies testable user flows (Search, Login, Checkout, etc.) from
the discovered site structure. Falls back to heuristic flows when LLM fails.
"""

from __future__ import annotations

import json
import os
import re
from urllib.parse import urlparse

from agent.models.graph import SiteGraph, SiteNode
from agent.models.flow import Flow, FlowStep


_FLOW_PROMPT = """You are a senior QA engineer analyzing a website to identify critical user flows for automated testing.

SITE: {url}

PAGES DISCOVERED:
{pages}

NAVIGATION:
{links}

TASK: Identify 3-8 critical user flows that would catch the most important bugs.

PRIORITY GUIDE (use these exact numbers):
- Revenue-critical (checkout, payment, purchase): Priority 1
- Core functionality (search, login, signup): Priority 1-2
- Content access (view article, browse products): Priority 2-3
- Secondary features (filters, sorting): Priority 3-4
- Peripheral (footer links, about pages): Priority 4-5

ACTION TYPES:
- navigate: Go to a specific URL
- click: Click a button/link (e.g., "click 'Products' nav link")
- search: Enter text in search box (e.g., "search for 'laptop'")
- fill_form: Fill and submit a form (e.g., "fill signup form")
- verify: Check something on the page (e.g., "verify results displayed")

EXAMPLES:

E-commerce site:
{{"name": "Product Search to Cart", "priority": 1, "steps": [
  {{"action": "navigate", "target": "homepage", "url_hint": "/", "verify": ""}},
  {{"action": "search", "target": "search box", "url_hint": "/search", "verify": "search results displayed"}},
  {{"action": "click", "target": "first product", "url_hint": "/product/", "verify": "product page loaded"}},
  {{"action": "click", "target": "add to cart button", "url_hint": "/cart", "verify": "item added to cart"}}
]}}

SaaS/Tool site:
{{"name": "Sign Up", "priority": 1, "steps": [
  {{"action": "click", "target": "sign up button", "url_hint": "/signup", "verify": "signup form visible"}},
  {{"action": "fill_form", "target": "signup form", "url_hint": "/verify", "verify": "confirmation or welcome message"}}
]}}

News/Content site:
{{"name": "Search & Read Article", "priority": 2, "steps": [
  {{"action": "search", "target": "search box", "url_hint": "/search", "verify": "article results shown"}},
  {{"action": "click", "target": "first article", "url_hint": "/", "verify": "article content loads"}}
]}}

RULES:
- Each flow should test ONE critical user journey end-to-end
- 2-6 steps per flow (concise but complete)
- Higher priority = what would hurt the business most if broken
- If no checkout/login/search is found, focus on navigation flows
- url_hint can be partial ("/product/", "/cart") or empty if URL doesn't change
- verify should describe what a human QA would check ("results appear", "button is clickable", "no errors")

OUTPUT: Valid JSON only, no markdown, no code blocks. Format:
{{"flows": [{{"name": "...", "priority": 1, "steps": [...]}}]}}
"""


def _graph_to_prompt(graph: SiteGraph) -> str:
    """Build the prompt content from the site graph."""
    pages_lines = []
    for node in graph.nodes.values():
        if node.status != "visited":
            continue
        forms = sum(1 for e in node.elements if e.type == "form")
        has_search = any(e.type == "search" for e in node.elements)
        types = list({e.type for e in node.elements})[:5]
        pages_lines.append(
            f"- {node.url} | title: {node.title or '(none)'} | "
            f"page_type: {node.page_type} | forms: {forms} | "
            f"has_search: {has_search} | element_types: {', '.join(types)}"
        )
    pages_text = "\n".join(pages_lines) if pages_lines else "(no pages visited)"

    links_lines = [f"{f} -> {t}" for f, t in graph.edges[:50]]
    links_text = "\n".join(links_lines) if links_lines else "(no links)"

    return _FLOW_PROMPT.format(
        url=graph.root_url,
        pages=pages_text,
        links=links_text,
    )


def _parse_flows_response(text: str) -> list[Flow]:
    """Parse LLM JSON response into Flow objects."""
    # Strip markdown code blocks if present
    cleaned = text.strip()
    if cleaned.startswith("```"):
        cleaned = re.sub(r"^```\w*\n?", "", cleaned)
        cleaned = re.sub(r"\n?```\s*$", "", cleaned)

    data = json.loads(cleaned)
    flows_data = data.get("flows", [])
    flows = []
    for f in flows_data:
        if not isinstance(f, dict) or "name" not in f or "steps" not in f:
            continue
        steps = []
        for s in f.get("steps", []):
            if not isinstance(s, dict) or "action" not in s:
                continue
            steps.append(FlowStep(
                action=str(s.get("action", "click")),
                target=str(s.get("target", "")),
                url_hint=str(s.get("url_hint", "")),
                verify=str(s.get("verify", "")),
            ))
        if steps:
            flows.append(Flow(
                name=str(f["name"]),
                priority=int(f.get("priority", 3)),
                steps=steps,
            ))
    return flows


def _heuristic_flows(graph: SiteGraph) -> list[Flow]:
    """Fallback: build flows from graph structure when LLM fails."""
    flows = []
    root = graph.root_url
    parsed = urlparse(root)
    base = f"{parsed.scheme}://{parsed.netloc}"

    # Search flow if any page has search
    for node in graph.nodes.values():
        if any(e.type == "search" for e in node.elements):
            flows.append(Flow(
                name="Search",
                priority=1,
                steps=[
                    FlowStep("navigate", "homepage", "/", ""),
                    FlowStep("search", "search box", "", "results appear"),
                ],
            ))
            break

    # Login flow if any page has login form or login-like URL
    for node in graph.nodes.values():
        url_lower = node.url.lower()
        has_login_url = "login" in url_lower or "signin" in url_lower or "sign-in" in url_lower
        has_login_form = node.page_type == "login" or any(
            "login" in (e.text or "").lower() or "sign in" in (e.text or "").lower()
            for e in node.elements if getattr(e, "type", "") == "form"
        )
        if has_login_url or has_login_form:
            flows.append(Flow(
                name="Login",
                priority=2,
                steps=[
                    FlowStep("navigate", "login page", node.url, ""),
                    FlowStep("fill_form", "login form", "", "redirected or no error"),
                ],
            ))
            break

    # Browse flow: home -> first few links
    if not flows:
        flows.append(Flow(
            name="Browse",
            priority=3,
            steps=[
                FlowStep("navigate", "homepage", "/", ""),
                FlowStep("click", "first nav link", "", "page loads"),
            ],
        ))

    return flows


async def identify_flows(graph: SiteGraph) -> list[Flow]:
    """Identify user flows from the site graph using Gemini Flash.

    Falls back to heuristic flows if the API is unavailable or fails.
    """
    api_key = os.environ.get("GEMINI_API_KEY")
    if not api_key:
        return _heuristic_flows(graph)

    try:
        import google.generativeai as genai

        genai.configure(api_key=api_key)
        model = genai.GenerativeModel(
            os.environ.get("GEMINI_MODEL", "gemini-2.0-flash"),
            generation_config={"temperature": 0.0},
        )

        prompt = _graph_to_prompt(graph)
        response = await _call_gemini_async(model, prompt)
        if response:
            flows = _parse_flows_response(response)
            if flows:
                flows.sort(key=lambda f: f.priority)
                return flows[:8]
    except Exception:
        pass

    return _heuristic_flows(graph)


async def _call_gemini_async(model, prompt: str) -> str | None:
    """Call Gemini API. Sync API wrapped for async compatibility."""
    import asyncio

    def _sync_call():
        try:
            resp = model.generate_content(prompt)
            if resp and resp.text:
                return resp.text
        except Exception:
            pass
        return None

    return await asyncio.to_thread(_sync_call)
