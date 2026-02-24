"""Graph-based site explorer. Replaces the passive BFS crawler.

Navigates a website like a human: clicks links, expands menus, fills forms,
tests buttons, uses search boxes. Builds a SiteGraph as it goes and streams
progress events via a callback for real-time frontend updates.
"""

from __future__ import annotations

import asyncio
import base64
import heapq
import hashlib
from urllib.parse import urlparse, urlunparse, parse_qs, urlencode
from playwright.async_api import Page, BrowserContext

from agent.models.graph import (
    SiteGraph, SiteNode, PageElement, ActionResult, ProgressCallback,
)
from agent.models.types import BugFinding, PageMetrics
from agent.detectors.functional import FunctionalDetector
from agent.detectors.performance import PerformanceDetector
from agent.detectors.responsive import ResponsiveDetector
from agent.utils.form_filler import fill_form
from agent.utils.smart_wait import install_request_tracker, wait_for_stable_page
from agent.utils.popup_guard import dismiss_overlays


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
                if (u.protocol === 'http:' || u.protocol === 'https:') {
                    u.hash = '';
                    href = u.href;
                }
            } catch {}
        }

        // Build a robust selector
        let selector;
        if (el.id) {
            selector = '#' + CSS.escape(el.id);
        } else if (el.getAttribute('data-testid')) {
            selector = `[data-testid="${el.getAttribute('data-testid')}"]`;
        } else {
            // Use a positional selector
            const parent = el.parentElement;
            if (parent) {
                const siblings = [...parent.children].filter(c => c.tagName === el.tagName);
                const idx = siblings.indexOf(el) + 1;
                const parentSel = parent.id ? '#' + CSS.escape(parent.id) : parent.tagName.toLowerCase();
                selector = `${parentSel} > ${el.tagName.toLowerCase()}:nth-of-type(${idx})`;
            } else {
                selector = el.tagName.toLowerCase();
            }
        }

        const key = type + '|' + (href || selector);
        if (seen.has(key)) return;
        seen.add(key);

        const rect = el.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0 && type !== 'form') return;

        results.push({ type, selector, text: text.substring(0, 80), href, priority });
    }

    // 1. Nav links (priority 9)
    for (const a of document.querySelectorAll('nav a[href], header a[href], [role="navigation"] a[href]')) {
        add(a, 'nav_link', 9);
    }

    // 2. Dropdown/menu triggers (priority 8)
    for (const el of document.querySelectorAll('[aria-haspopup], [data-toggle="dropdown"], .dropdown-toggle, details > summary')) {
        add(el, 'dropdown', 8);
    }

    // 3. Forms (priority 8)
    for (const form of document.querySelectorAll('form')) {
        const inputs = form.querySelectorAll('input:not([type=hidden]):not([type=submit]):not([type=button]), select, textarea');
        if (inputs.length === 0) continue;
        let selector = form.id ? '#' + CSS.escape(form.id) : null;
        if (!selector && form.getAttribute('name')) {
            selector = `form[name="${form.getAttribute('name')}"]`;
        }
        if (!selector && form.action) {
            selector = `form[action="${form.getAttribute('action')}"]`;
        }
        if (!selector) {
            const allForms = [...document.querySelectorAll('form')];
            const idx = allForms.indexOf(form) + 1;
            selector = `form:nth-of-type(${idx})`;
        }
        const key = 'form|' + selector;
        if (seen.has(key)) continue;
        seen.add(key);

        const label = form.getAttribute('aria-label') || '';
        const text = label || `Form with ${inputs.length} field(s)`;
        results.push({ type: 'form', selector, text, href: null, priority: 8 });
    }

    // 4. Search inputs (priority 7)
    for (const el of document.querySelectorAll('input[type="search"], [role="search"] input, input[name="q"], input[name="search"], input[name="query"]')) {
        add(el, 'search', 7);
    }

    // 5. CTA buttons (priority 6)
    for (const el of document.querySelectorAll('button:not([type="submit"]), a.btn, [role="button"], .cta')) {
        if (el.closest('form')) continue;  // skip form submit buttons
        add(el, 'cta', 6);
    }

    // 6. Main content links (priority 5)
    for (const a of document.querySelectorAll('main a[href], article a[href], .content a[href], #content a[href]')) {
        add(a, 'content_link', 5);
    }

    // 7. Footer links (priority 2)
    for (const a of document.querySelectorAll('footer a[href]')) {
        add(a, 'footer_link', 2);
    }

    // 8. Sidebar links (priority 2)
    for (const a of document.querySelectorAll('aside a[href], [role="complementary"] a[href]')) {
        add(a, 'sidebar_link', 2);
    }

    // 9. Fallback: if we found very few links, grab any <a> on the page (priority 4)
    const linkCount = results.filter(r => r.href).length;
    if (linkCount < 5) {
        for (const a of document.querySelectorAll('a[href]')) {
            if (a.closest('nav') || a.closest('header') || a.closest('footer')) continue;
            add(a, 'content_link', 4);
        }
    }

    return results;
}"""


class SiteExplorer:
    """Explores a website by interacting with elements and building a graph."""

    def __init__(
        self,
        base_url: str,
        max_pages: int = 20,
        on_progress: ProgressCallback | None = None,
    ):
        self.base_url = base_url.rstrip("/")
        parsed = urlparse(base_url)
        self.base_domain = parsed.netloc
        self.root_domain = _extract_root_domain(parsed.netloc)
        self.max_pages = max_pages
        self._progress = on_progress or (lambda *_: None)

        self.graph = SiteGraph(root_url=self.base_url)
        self._visit_count = 0
        self._total_elements = 0
        self._total_actions = 0

        # Priority queue entries: (-priority, depth, url)
        self._queue: list[tuple[int, int, str]] = []

        # Detectors
        self._functional = FunctionalDetector()
        self._performance = PerformanceDetector()
        self._responsive = ResponsiveDetector()

    async def explore(self, page: Page, viewport: str = "desktop") -> SiteGraph:
        """Main entry point. Explores the site and returns a SiteGraph."""
        self._functional.attach_listeners(page)

        # Seed the graph with the start URL
        node = self.graph.add_node(self.base_url, depth=0, page_type="home")
        heapq.heappush(self._queue, (-10, 0, self.base_url))
        self._emit("page_discovered", {"url": self.base_url, "depth": 0, "from": None})

        while self._queue and self._visit_count < self.max_pages:
            neg_pri, depth, url = heapq.heappop(self._queue)

            node = self.graph.get_node(url)
            if not node or node.status != "discovered":
                continue

            await self._visit_page(page, node, viewport)

        self._emit("scan_complete", {
            "pages": self._visit_count,
            "bugs": sum(len(n.bugs) for n in self.graph.nodes.values()),
            "elements_tested": self._total_elements,
            "actions_taken": self._total_actions,
        })

        return self.graph

    async def _visit_page(self, page: Page, node: SiteNode, viewport: str):
        """Navigate to a page, discover elements, interact, run detectors."""
        node.status = "visiting"
        self._emit("visiting_page", {
            "url": node.url,
            "page_number": self._visit_count + 1,
            "total_discovered": len(self.graph.nodes),
        })

        # Rate limiting
        if self._visit_count > 0:
            await page.wait_for_timeout(800)

        try:
            response = await page.goto(node.url, wait_until="domcontentloaded", timeout=20000)
            if not response or response.status >= 400:
                node.status = "failed"
                self._emit("page_complete", {"url": node.url, "status": "failed"})
                return

            await install_request_tracker(page)
            await _install_spa_observer(page)
            await wait_for_stable_page(page, timeout_ms=5000)

            # Scroll to trigger lazy loading
            await _scroll_page(page)

            node.title = await page.title() or ""
            self._visit_count += 1

            self._functional.reset_for_page()

        except Exception as e:
            node.status = "failed"
            self._emit("page_complete", {"url": node.url, "status": "failed", "error": str(e)[:200]})
            return

        # Close popups/cookie banners using the smarter popup guard
        await dismiss_overlays(page)

        # Discover elements
        elements = await self._discover_elements(page)
        node.elements = elements
        self._total_elements += len(elements)

        element_summary = {}
        for el in elements:
            element_summary[el.type] = element_summary.get(el.type, 0) + 1

        self._emit("elements_found", {
            "url": node.url,
            "total": len(elements),
            **element_summary,
        })

        # Interact with elements
        await self._interact_with_elements(page, node, elements, viewport)

        # Capture screenshot
        node.screenshot_b64 = await _capture_screenshot(page)

        # Run detectors
        bugs = await self._run_detectors(page, node.url, viewport)
        node.bugs = bugs
        for bug in bugs:
            self._emit("bug_found", {
                "severity": bug.severity.value,
                "title": bug.title,
                "page": node.url,
                "category": bug.category.value,
            })

        # Collect metrics
        metrics = await self._performance.collect_metrics(page, viewport)
        node.metrics = metrics

        node.status = "visited"
        self._emit("page_complete", {
            "url": node.url,
            "status": "visited",
            "bugs": len(bugs),
            "elements": len(elements),
        })

    async def _discover_elements(self, page: Page) -> list[PageElement]:
        """Extract all interactive elements from the rendered page."""
        try:
            raw = await page.evaluate(_DISCOVER_ELEMENTS_JS)
        except Exception:
            return []

        elements = []
        for item in raw:
            elements.append(PageElement(
                type=item["type"],
                selector=item["selector"],
                text=item["text"],
                href=item.get("href"),
                priority=item["priority"],
            ))

        return elements

    async def _interact_with_elements(
        self, page: Page, node: SiteNode, elements: list[PageElement], viewport: str,
    ):
        """Interact with discovered elements in priority order."""
        # Sort by priority (highest first), but cap interactions per type
        sorted_els = sorted(elements, key=lambda e: -e.priority)

        link_count = 0
        max_links = 15
        form_count = 0
        max_forms = 3
        dropdown_count = 0
        max_dropdowns = 5
        button_count = 0
        max_buttons = 5
        search_count = 0
        max_searches = 1

        for el in sorted_els:
            if el.type in ("nav_link", "content_link", "footer_link", "sidebar_link"):
                if link_count >= max_links:
                    continue
                if el.href and self._is_allowed(el.href):
                    result = await self._follow_link(page, node, el)
                    node.actions.append(result)
                    self._total_actions += 1
                    link_count += 1

            elif el.type == "dropdown":
                if dropdown_count >= max_dropdowns:
                    continue
                result = await self._expand_menu(page, node, el)
                node.actions.append(result)
                self._total_actions += 1
                dropdown_count += 1

            elif el.type == "form":
                if form_count >= max_forms:
                    continue
                result = await self._test_form(page, node, el)
                node.actions.append(result)
                self._total_actions += 1
                form_count += 1

            elif el.type == "search":
                if search_count >= max_searches:
                    continue
                result = await self._test_search(page, node, el)
                node.actions.append(result)
                self._total_actions += 1
                search_count += 1

            elif el.type == "cta":
                if button_count >= max_buttons:
                    continue
                result = await self._click_button(page, node, el)
                node.actions.append(result)
                self._total_actions += 1
                button_count += 1

    async def _follow_link(self, page: Page, node: SiteNode, el: PageElement) -> ActionResult:
        """Record a link as a graph edge. Don't navigate -- just register the destination."""
        url = self._normalize(el.href)
        existing = self.graph.get_node(url)

        if not existing:
            depth = node.depth + 1
            new_node = self.graph.add_node(url, depth=depth)
            self.graph.add_edge(node.url, url)

            priority = el.priority
            if depth > 3:
                priority = max(1, priority - 2)
            heapq.heappush(self._queue, (-priority, depth, url))

            self._emit("page_discovered", {
                "url": url,
                "depth": depth,
                "from": node.url,
                "via": el.text[:60],
            })
        else:
            self.graph.add_edge(node.url, url)

        self._emit("action", {
            "action": "follow_link",
            "target": el.text[:60],
            "page": node.url,
            "href": url,
        })

        return ActionResult(
            action_type="click",
            target=el.text[:80],
            outcome="navigated" if not existing else "already_known",
            new_url=url,
        )

    async def _expand_menu(self, page: Page, node: SiteNode, el: PageElement) -> ActionResult:
        """Hover/click a dropdown trigger to reveal hidden links."""
        self._emit("action", {
            "action": "expand_menu",
            "target": el.text[:60],
            "page": node.url,
        })

        try:
            target = await page.query_selector(el.selector)
            if not target or not await target.is_visible():
                return ActionResult("expand_menu", el.text, "no_change", error="Element not found/visible")

            await target.hover()
            await page.wait_for_timeout(500)

            # Check if new links appeared
            links_before = await page.evaluate("() => document.querySelectorAll('a[href]').length")
            await target.click()
            await page.wait_for_timeout(800)
            links_after = await page.evaluate("() => document.querySelectorAll('a[href]').length")

            if links_after > links_before:
                # Re-discover links from expanded content
                new_elements = await self._discover_elements(page)
                new_links = [e for e in new_elements
                             if e.type in ("nav_link", "content_link") and e.href
                             and self._is_allowed(e.href)
                             and self._normalize(e.href) not in self.graph.nodes]
                for link_el in new_links[:5]:
                    url = self._normalize(link_el.href)
                    new_node = self.graph.add_node(url, depth=node.depth + 1)
                    self.graph.add_edge(node.url, url)
                    heapq.heappush(self._queue, (-link_el.priority, node.depth + 1, url))
                    self._emit("page_discovered", {"url": url, "depth": node.depth + 1, "from": node.url, "via": f"menu: {el.text[:40]}"})

                return ActionResult("expand_menu", el.text, "new_content")

            return ActionResult("expand_menu", el.text, "no_change")

        except Exception as e:
            return ActionResult("expand_menu", el.text, "error", error=str(e)[:200])

    async def _test_form(self, page: Page, node: SiteNode, el: PageElement) -> ActionResult:
        """Fill and submit a form."""
        self._emit("action", {
            "action": "fill_form",
            "target": el.text[:60],
            "page": node.url,
        })

        try:
            url_before = page.url
            result = await fill_form(page, el.selector)

            if result.outcome == "navigated" and result.new_url:
                norm = self._normalize(result.new_url)
                if self._is_allowed(norm) and norm not in self.graph.nodes:
                    new_node = self.graph.add_node(norm, depth=node.depth + 1, page_type="form")
                    self.graph.add_edge(node.url, norm)
                    heapq.heappush(self._queue, (-7, node.depth + 1, norm))
                    self._emit("page_discovered", {"url": norm, "depth": node.depth + 1, "from": node.url, "via": f"form submit"})

                # Navigate back so we can continue on this page
                try:
                    await page.goto(url_before, wait_until="domcontentloaded", timeout=15000)
                    await page.wait_for_timeout(1000)
                except Exception:
                    pass

            return result

        except Exception as e:
            return ActionResult("fill_form", el.text, "error", error=str(e)[:200])

    async def _test_search(self, page: Page, node: SiteNode, el: PageElement) -> ActionResult:
        """Type a query into a search box and observe results."""
        self._emit("action", {
            "action": "search",
            "target": "search box",
            "page": node.url,
        })

        try:
            search_input = await page.query_selector(el.selector)
            if not search_input or not await search_input.is_visible():
                return ActionResult("search", "search box", "no_change", error="Search input not found/visible")

            url_before = page.url
            await search_input.fill("test")
            await search_input.press("Enter")
            await page.wait_for_timeout(2000)

            url_after = page.url
            if url_after != url_before:
                norm = self._normalize(url_after)
                if self._is_allowed(norm) and norm not in self.graph.nodes:
                    self.graph.add_node(norm, depth=node.depth + 1, page_type="search")
                    self.graph.add_edge(node.url, norm)
                    heapq.heappush(self._queue, (-6, node.depth + 1, norm))
                    self._emit("page_discovered", {"url": norm, "depth": node.depth + 1, "from": node.url, "via": "search"})

                # Go back
                try:
                    await page.goto(url_before, wait_until="domcontentloaded", timeout=15000)
                    await page.wait_for_timeout(1000)
                except Exception:
                    pass

                return ActionResult("search", "search box", "navigated", new_url=norm)

            return ActionResult("search", "search box", "new_content")

        except Exception as e:
            return ActionResult("search", "search box", "error", error=str(e)[:200])

    async def _click_button(self, page: Page, node: SiteNode, el: PageElement) -> ActionResult:
        """Click a button and observe what happens."""
        self._emit("action", {
            "action": "click_button",
            "target": el.text[:60],
            "page": node.url,
        })

        try:
            btn = await page.query_selector(el.selector)
            if not btn or not await btn.is_visible():
                return ActionResult("click", el.text, "no_change", error="Button not found/visible")

            url_before = page.url
            await btn.click()
            await page.wait_for_timeout(1500)

            url_after = page.url
            if url_after != url_before:
                norm = self._normalize(url_after)
                if self._is_allowed(norm) and norm not in self.graph.nodes:
                    self.graph.add_node(norm, depth=node.depth + 1)
                    self.graph.add_edge(node.url, norm)
                    heapq.heappush(self._queue, (-el.priority, node.depth + 1, norm))
                    self._emit("page_discovered", {"url": norm, "depth": node.depth + 1, "from": node.url, "via": el.text[:40]})

                try:
                    await page.goto(url_before, wait_until="domcontentloaded", timeout=15000)
                    await page.wait_for_timeout(1000)
                except Exception:
                    pass

                return ActionResult("click", el.text, "navigated", new_url=norm)

            return ActionResult("click", el.text, "no_change")

        except Exception as e:
            return ActionResult("click", el.text, "error", error=str(e)[:200])

    async def _run_detectors(self, page: Page, url: str, viewport: str) -> list[BugFinding]:
        """Run all bug detectors on the current page."""
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

    def _is_allowed(self, url: str) -> bool:
        """Check if URL is on the same domain and not a skip-type resource."""
        if not url:
            return False
        parsed = urlparse(url)

        netloc = parsed.netloc
        if netloc != self.base_domain:
            link_root = _extract_root_domain(netloc)
            if link_root != self.root_domain:
                return False

        path = parsed.path.lower()
        skip_ext = {
            ".pdf", ".zip", ".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp",
            ".css", ".js", ".ico", ".woff", ".woff2", ".ttf", ".eot",
            ".mp4", ".mp3", ".webm", ".avi", ".mov",
            ".xml", ".rss", ".atom", ".json",
        }
        if any(path.endswith(ext) for ext in skip_ext):
            return False

        skip_patterns = ["/wp-admin", "/admin/", "mailto:", "tel:", "javascript:"]
        return not any(p in url.lower() for p in skip_patterns)

    def _normalize(self, url: str) -> str:
        parsed = urlparse(url)
        params = sorted(parse_qs(parsed.query).items())
        normalized = parsed._replace(
            fragment="",
            query=urlencode(params, doseq=True),
            path=parsed.path.rstrip("/") or "/",
        )
        return urlunparse(normalized)

    def _emit(self, event_type: str, data: dict):
        try:
            self._progress(event_type, data)
        except Exception:
            pass


_INSTALL_SPA_OBSERVER_JS = """() => {
    if (window.__flowlens_spa_installed) return;
    window.__flowlens_spa_installed = true;
    window.__flowlens_mutations = 0;
    window.__flowlens_url_changes = [];

    const observer = new MutationObserver((mutations) => {
        window.__flowlens_mutations += mutations.length;
    });
    observer.observe(document.body || document.documentElement, {
        childList: true, subtree: true
    });

    // Track pushState/replaceState for SPA routing
    const origPush = history.pushState;
    const origReplace = history.replaceState;
    history.pushState = function(...args) {
        window.__flowlens_url_changes.push(args[2] || '');
        return origPush.apply(this, args);
    };
    history.replaceState = function(...args) {
        window.__flowlens_url_changes.push(args[2] || '');
        return origReplace.apply(this, args);
    };
}"""


async def _install_spa_observer(page: Page):
    """Install SPA mutation and route-change observer."""
    try:
        await page.evaluate(_INSTALL_SPA_OBSERVER_JS)
    except Exception:
        pass


async def _scroll_page(page: Page):
    """Scroll to trigger lazy loading."""
    try:
        for _ in range(3):
            await page.evaluate("window.scrollBy(0, window.innerHeight)")
            await page.wait_for_timeout(400)
        await page.evaluate("window.scrollTo(0, 0)")
        await page.wait_for_timeout(300)
    except Exception:
        pass


async def _dismiss_popups(page: Page):
    """Close common popups, cookie banners, modals."""
    selectors = [
        'button[aria-label*="close" i]',
        'button[aria-label*="dismiss" i]',
        'button[aria-label*="accept" i]',
        '[class*="cookie"] button',
        '[class*="consent"] button',
        '[class*="popup"] button[class*="close"]',
        '[class*="modal"] button[class*="close"]',
    ]
    for sel in selectors:
        try:
            el = await page.query_selector(sel)
            if el and await el.is_visible():
                await el.click()
                await page.wait_for_timeout(300)
                break
        except Exception:
            continue


async def _capture_screenshot(page: Page) -> str | None:
    try:
        buf = await page.screenshot(full_page=False, type="jpeg", quality=70)
        return base64.b64encode(buf).decode("utf-8")
    except Exception:
        return None


def _extract_root_domain(netloc: str) -> str:
    parts = netloc.split(".")
    if len(parts) >= 2:
        return ".".join(parts[-2:])
    return netloc
