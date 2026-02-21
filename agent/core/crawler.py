"""Site discovery crawler. Phase A: zero AI, pure Playwright link-following.

Implements the decisions from CORE_ENGINEERING_DECISIONS.md:
- BFS traversal with rendered DOM link extraction
- Scrolling to trigger lazy content and find hidden links
- Rate limiting between page visits
- Subdomain handling (stay on same root domain)
- Pagination detection and capping
- Skip non-page resources
"""

from __future__ import annotations
import asyncio
import hashlib
import time
from urllib.parse import urljoin, urlparse, urlunparse, parse_qs, urlencode
from playwright.async_api import Page


class SiteCrawler:
    """BFS link crawler that builds a site graph by rendering pages in a real browser."""

    def __init__(self, base_url: str, max_pages: int = 20, delay_ms: int = 1000):
        self.base_url = base_url.rstrip("/")
        parsed = urlparse(base_url)
        self.base_domain = parsed.netloc
        self.root_domain = _extract_root_domain(parsed.netloc)
        self.max_pages = max_pages
        self.delay_ms = delay_ms
        self.visited: set[str] = set()
        self.site_graph: dict[str, list[str]] = {}
        self.page_titles: dict[str, str] = {}
        self.page_meta: dict[str, dict] = {}
        self._pagination_chains: dict[str, int] = {}

    async def discover(self, page: Page) -> dict:
        """BFS crawl from base_url, return site graph."""
        queue = [self.base_url]
        visit_count = 0

        while queue and len(self.visited) < self.max_pages:
            url = queue.pop(0)
            normalized = self._normalize(url)

            if normalized in self.visited:
                continue

            # Rate limiting
            if visit_count > 0:
                await page.wait_for_timeout(self.delay_ms)

            try:
                response = await page.goto(url, wait_until="domcontentloaded", timeout=20000)
                if not response:
                    continue

                status = response.status
                if status >= 400:
                    continue

                await page.wait_for_timeout(1500)

                # Scroll down to trigger lazy loading and reveal hidden links
                await _scroll_for_links(page)

                self.visited.add(normalized)
                visit_count += 1
                self.page_titles[normalized] = await page.title() or ""

                # Collect page metadata
                meta = await _collect_page_meta(page)
                self.page_meta[normalized] = meta

                # Extract links from rendered DOM
                links = await self._extract_links(page)
                self.site_graph[normalized] = links

                for link in links:
                    link_normalized = self._normalize(link)
                    if link_normalized not in self.visited:
                        # Pagination capping: don't follow more than 5 pages in a pagination chain
                        if self._is_pagination(link, normalized):
                            chain_key = self._pagination_chain_key(link)
                            count = self._pagination_chains.get(chain_key, 0)
                            if count >= 5:
                                continue
                            self._pagination_chains[chain_key] = count + 1

                        queue.append(link)

            except Exception:
                continue

        return {
            "pages": list(self.visited),
            "page_count": len(self.visited),
            "graph": self.site_graph,
            "titles": self.page_titles,
            "meta": self.page_meta,
        }

    async def _extract_links(self, page: Page) -> list[str]:
        """Extract all same-domain links from the rendered page."""
        raw_links = await page.evaluate("""() => {
            const links = new Set();
            // Standard <a> tags
            for (const a of document.querySelectorAll('a[href]')) {
                try {
                    const url = new URL(a.href, window.location.origin);
                    if (url.protocol === 'http:' || url.protocol === 'https:') {
                        url.hash = '';
                        links.add(url.href);
                    }
                } catch {}
            }
            // Buttons and elements with onclick handlers that navigate
            for (const el of document.querySelectorAll('[onclick], [data-href], [data-url]')) {
                const href = el.getAttribute('data-href') || el.getAttribute('data-url');
                if (href) {
                    try {
                        const url = new URL(href, window.location.origin);
                        links.add(url.href);
                    } catch {}
                }
            }
            return [...links];
        }""")

        return [
            link for link in raw_links
            if self._is_allowed_domain(link) and not self._should_skip(link)
        ]

    def _is_allowed_domain(self, url: str) -> bool:
        """Allow same domain AND subdomains of the same root domain."""
        netloc = urlparse(url).netloc
        if netloc == self.base_domain:
            return True
        link_root = _extract_root_domain(netloc)
        return link_root == self.root_domain

    def _should_skip(self, url: str) -> bool:
        path = urlparse(url).path.lower()
        skip_extensions = {
            ".pdf", ".zip", ".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp",
            ".css", ".js", ".ico", ".woff", ".woff2", ".ttf", ".eot",
            ".mp4", ".mp3", ".webm", ".avi", ".mov",
            ".xml", ".rss", ".atom", ".json",
        }
        if any(path.endswith(ext) for ext in skip_extensions):
            return True
        skip_patterns = ["/wp-admin", "/admin/", "mailto:", "tel:", "javascript:"]
        return any(p in url.lower() for p in skip_patterns)

    def _is_pagination(self, link: str, current: str) -> bool:
        """Detect if a link is part of a pagination chain."""
        parsed = urlparse(link)
        query = parsed.query.lower()
        path = parsed.path.lower()
        return any(p in query or p in path for p in ["page=", "/page/", "offset=", "p=", "pg="])

    def _pagination_chain_key(self, url: str) -> str:
        parsed = urlparse(url)
        return parsed.netloc + parsed.path.rsplit("/", 1)[0]

    def _normalize(self, url: str) -> str:
        parsed = urlparse(url)
        params = sorted(parse_qs(parsed.query).items())
        normalized = parsed._replace(
            fragment="",
            query=urlencode(params, doseq=True),
            path=parsed.path.rstrip("/") or "/",
        )
        return urlunparse(normalized)


async def _scroll_for_links(page: Page):
    """Scroll page to trigger lazy loading and reveal hidden links."""
    try:
        for _ in range(3):
            await page.evaluate("window.scrollBy(0, window.innerHeight)")
            await page.wait_for_timeout(500)
        await page.evaluate("window.scrollTo(0, 0)")
        await page.wait_for_timeout(300)
    except Exception:
        pass


async def _collect_page_meta(page: Page) -> dict:
    """Collect metadata about the page for site context."""
    try:
        return await page.evaluate("""() => ({
            title: document.title || '',
            h1: document.querySelector('h1')?.textContent?.trim()?.substring(0, 100) || '',
            description: document.querySelector('meta[name="description"]')?.content || '',
            linkCount: document.querySelectorAll('a').length,
            imageCount: document.images.length,
            formCount: document.forms.length,
            buttonCount: document.querySelectorAll('button').length,
            inputCount: document.querySelectorAll('input, select, textarea').length,
            hasSearch: !!document.querySelector('input[type="search"], [role="search"], [name="q"], [name="search"]'),
            hasLogin: !!document.querySelector('input[type="password"]'),
        })""")
    except Exception:
        return {}


def _extract_root_domain(netloc: str) -> str:
    """Extract root domain: 'en.wikipedia.org' -> 'wikipedia.org'"""
    parts = netloc.split(".")
    if len(parts) >= 2:
        return ".".join(parts[-2:])
    return netloc
