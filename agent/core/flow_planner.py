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

CRITICAL REQUIREMENT: You MUST identify 5-8 diverse flows. Not just search and login - identify ALL major user journeys.

FLOW CATEGORIES TO CONSIDER:
1. **Transactional**: Search, add to cart, checkout, login, signup, submit forms
2. **Navigation**: Browse categories, explore sections, click through menu items
3. **Content Access**: View articles, read posts, watch videos, download files
4. **Discovery**: Filter results, sort lists, paginate through items
5. **Engagement**: Comment, like, share, subscribe, follow
6. **Account**: Profile view, settings, logout, password reset

PRIORITY GUIDE (use these exact numbers):
- Revenue-critical (checkout, payment, purchase): Priority 1
- Core functionality (search, login, signup, account actions): Priority 1-2
- Content access (view article, browse products, watch video): Priority 2-3
- Navigation & Discovery (menu browsing, filters, categories): Priority 2-4
- Secondary features (sort, paginate, share): Priority 3-4
- Peripheral (footer links, about pages, help): Priority 4-5

ACTION TYPES:
- navigate: Go to a specific URL or page section
- click: Click a button/link/menu item
- search: Enter text in search box
- fill_form: Fill and submit a form
- verify: Check something on the page

COMPREHENSIVE EXAMPLES:

E-commerce (identify 6+ flows):
1. {{"name": "Browse Category to Product", "priority": 2, "steps": [
  {{"action": "click", "target": "products menu", "url_hint": "/products", "verify": "category list displayed"}},
  {{"action": "click", "target": "electronics category", "url_hint": "/category/electronics", "verify": "products shown"}},
  {{"action": "click", "target": "first product", "url_hint": "/product/", "verify": "product details loaded"}}
]}}
2. {{"name": "Product Search to Details", "priority": 1, "steps": [
  {{"action": "search", "target": "search box", "url_hint": "/search", "verify": "search results displayed"}},
  {{"action": "click", "target": "first result", "url_hint": "/product/", "verify": "product page loaded"}}
]}}
3. {{"name": "Add to Cart", "priority": 1, "steps": [
  {{"action": "navigate", "target": "product page", "url_hint": "/product/", "verify": ""}},
  {{"action": "click", "target": "add to cart button", "url_hint": "", "verify": "item added confirmation"}}
]}}
4. {{"name": "View Cart", "priority": 2, "steps": [
  {{"action": "click", "target": "cart icon", "url_hint": "/cart", "verify": "cart page loads with items"}}
]}}
5. {{"name": "User Login", "priority": 1, "steps": [
  {{"action": "click", "target": "login button", "url_hint": "/login", "verify": "login form visible"}},
  {{"action": "fill_form", "target": "login form", "url_hint": "", "verify": "redirected or logged in"}}
]}}
6. {{"name": "Filter Products", "priority": 3, "steps": [
  {{"action": "navigate", "target": "products page", "url_hint": "/products", "verify": ""}},
  {{"action": "click", "target": "price filter", "url_hint": "", "verify": "filtered results shown"}}
]}}

News/Content site (identify 5+ flows):
1. {{"name": "Browse Homepage Articles", "priority": 2, "steps": [
  {{"action": "navigate", "target": "homepage", "url_hint": "/", "verify": "articles displayed"}},
  {{"action": "click", "target": "featured article", "url_hint": "/article/", "verify": "article content loads"}}
]}}
2. {{"name": "Navigate Section", "priority": 3, "steps": [
  {{"action": "click", "target": "technology section", "url_hint": "/tech", "verify": "tech articles shown"}},
  {{"action": "click", "target": "first article", "url_hint": "/article/", "verify": "article loads"}}
]}}
3. {{"name": "Search Articles", "priority": 2, "steps": [
  {{"action": "search", "target": "search box", "url_hint": "/search", "verify": "search results displayed"}},
  {{"action": "click", "target": "first result", "url_hint": "/", "verify": "article opens"}}
]}}
4. {{"name": "Browse Categories", "priority": 3, "steps": [
  {{"action": "click", "target": "categories menu", "url_hint": "/categories", "verify": "category list shown"}},
  {{"action": "click", "target": "first category", "url_hint": "/category/", "verify": "category page loads"}}
]}}
5. {{"name": "View Author Profile", "priority": 4, "steps": [
  {{"action": "navigate", "target": "article page", "url_hint": "/article/", "verify": ""}},
  {{"action": "click", "target": "author name", "url_hint": "/author/", "verify": "author bio displayed"}}
]}}

SaaS/Tool site (identify 5+ flows):
1. {{"name": "Sign Up", "priority": 1, "steps": [
  {{"action": "click", "target": "sign up button", "url_hint": "/signup", "verify": "signup form visible"}},
  {{"action": "fill_form", "target": "signup form", "url_hint": "", "verify": "account created or email sent"}}
]}}
2. {{"name": "Login", "priority": 1, "steps": [
  {{"action": "click", "target": "login link", "url_hint": "/login", "verify": "login form shown"}},
  {{"action": "fill_form", "target": "login form", "url_hint": "", "verify": "redirected to dashboard"}}
]}}
3. {{"name": "Explore Features", "priority": 3, "steps": [
  {{"action": "click", "target": "features menu", "url_hint": "/features", "verify": "features list displayed"}},
  {{"action": "click", "target": "feature details", "url_hint": "/features/", "verify": "feature page loads"}}
]}}
4. {{"name": "Pricing Page", "priority": 2, "steps": [
  {{"action": "click", "target": "pricing link", "url_hint": "/pricing", "verify": "pricing plans shown"}}
]}}
5. {{"name": "Documentation Browse", "priority": 3, "steps": [
  {{"action": "click", "target": "docs link", "url_hint": "/docs", "verify": "documentation index shown"}},
  {{"action": "click", "target": "getting started", "url_hint": "/docs/", "verify": "guide content loads"}}
]}}

RULES:
1. MUST identify 5-8 flows minimum (not just 2!)
2. Include flows from multiple categories: transactional, navigation, content access, discovery
3. Each flow tests ONE complete user journey (2-6 steps)
4. Start with high-priority flows (Priority 1-2) but also include navigation flows (Priority 3-4)
5. Use discovered pages and links to infer what flows are possible
6. url_hint can be partial ("/product/", "/article/") or empty if URL doesn't change
7. verify should describe observable outcomes ("results appear", "page loads", "button visible", "content displayed")

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
    """Fallback: build diverse flows from graph structure when LLM fails.

    Generates 5-8 flows based on discovered pages, links, and elements.
    """
    flows = []
    root = graph.root_url
    parsed = urlparse(root)
    base = f"{parsed.scheme}://{parsed.netloc}"
    visited_nodes = [n for n in graph.nodes.values() if n.status == "visited"]

    # 1. Search flow if any page has search
    for node in visited_nodes:
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

    # 2. Login flow if any page has login
    for node in visited_nodes:
        url_lower = node.url.lower()
        has_login = "login" in url_lower or "signin" in url_lower or "sign-in" in url_lower
        if not has_login:
            has_login = node.page_type == "login" or any(
                "login" in (e.text or "").lower() or "sign in" in (e.text or "").lower()
                for e in node.elements if getattr(e, "type", "") == "form"
            )
        if has_login:
            flows.append(Flow(
                name="Login",
                priority=2,
                steps=[
                    FlowStep("navigate", "login page", node.url, ""),
                    FlowStep("fill_form", "login form", "", "redirected or no error"),
                ],
            ))
            break

    # 3. Homepage Browse - always add this
    flows.append(Flow(
        name="Browse Homepage",
        priority=2,
        steps=[
            FlowStep("navigate", "homepage", "/", ""),
            FlowStep("verify", "content loaded", "", "page content displayed"),
        ],
    ))

    # 4. Navigation flows - for each discovered page type
    for node in visited_nodes[:3]:  # Top 3 pages
        if node.url == root:
            continue  # Skip homepage (already covered)

        page_name = node.title or node.url.split('/')[-1] or "page"
        # Clean up page name
        page_name = page_name[:30].strip()

        flows.append(Flow(
            name=f"Navigate to {page_name}",
            priority=3,
            steps=[
                FlowStep("navigate", "homepage", "/", ""),
                FlowStep("click", f"link to {page_name}", node.url, "page loads"),
            ],
        ))

    # 5. Click first link/article/item flows
    content_types = set()
    for node in visited_nodes:
        for elem in node.elements:
            elem_type = getattr(elem, "type", "")
            if elem_type in ("nav", "link"):
                content_types.add("link")
            if node.page_type in ("content", "article"):
                content_types.add("article")

    if "article" in content_types or "link" in content_types:
        flows.append(Flow(
            name="Click First Content Item",
            priority=3,
            steps=[
                FlowStep("navigate", "homepage", "/", ""),
                FlowStep("click", "first article", "", "content loads"),
            ],
        ))

    # 6. Form submission flow if forms found (other than login)
    for node in visited_nodes:
        has_form = any(e.type == "form" for e in node.elements)
        is_login = "login" in node.url.lower() or node.page_type == "login"
        if has_form and not is_login:
            flows.append(Flow(
                name="Submit Form",
                priority=3,
                steps=[
                    FlowStep("navigate", "form page", node.url, ""),
                    FlowStep("fill_form", "form", "", "form submitted"),
                ],
            ))
            break

    # 7. Deep navigation flow - homepage -> page1 -> page2
    if len(visited_nodes) >= 3:
        flows.append(Flow(
            name="Multi-Level Navigation",
            priority=4,
            steps=[
                FlowStep("navigate", "homepage", "/", ""),
                FlowStep("click", "first link", "", "page loads"),
                FlowStep("click", "any link", "", "deeper page loads"),
            ],
        ))

    # Ensure we return at least 5 flows
    while len(flows) < 5:
        flows.append(Flow(
            name=f"Browse Flow {len(flows) + 1}",
            priority=4,
            steps=[
                FlowStep("navigate", "homepage", "/", ""),
                FlowStep("click", "any visible link", "", "page loads"),
            ],
        ))

    return flows[:8]  # Cap at 8 flows


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
