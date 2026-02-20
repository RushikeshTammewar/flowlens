"""Site discovery crawler. Phase A: zero AI, pure Playwright link-following."""

from __future__ import annotations
import asyncio
from urllib.parse import urljoin, urlparse, urlunparse, parse_qs, urlencode
from playwright.async_api import Page


class SiteCrawler:
    """BFS link crawler that builds a site graph by rendering pages in a real browser."""

    def __init__(self, base_url: str, max_pages: int = 20):
        self.base_url = base_url.rstrip("/")
        self.base_domain = urlparse(base_url).netloc
        self.max_pages = max_pages
        self.visited: set[str] = set()
        self.site_graph: dict[str, list[str]] = {}
        self.page_titles: dict[str, str] = {}

    async def discover(self, page: Page) -> dict:
        """BFS crawl from base_url, return site graph."""
        queue = [self.base_url]

        while queue and len(self.visited) < self.max_pages:
            url = queue.pop(0)
            normalized = self._normalize(url)

            if normalized in self.visited:
                continue

            try:
                response = await page.goto(url, wait_until="domcontentloaded", timeout=15000)
                if not response:
                    continue

                await page.wait_for_timeout(1000)

                self.visited.add(normalized)
                self.page_titles[normalized] = await page.title() or ""

                links = await self._extract_links(page)
                self.site_graph[normalized] = links

                for link in links:
                    link_normalized = self._normalize(link)
                    if link_normalized not in self.visited:
                        queue.append(link)

            except Exception:
                continue

        return {
            "pages": list(self.visited),
            "page_count": len(self.visited),
            "graph": self.site_graph,
            "titles": self.page_titles,
        }

    async def _extract_links(self, page: Page) -> list[str]:
        """Extract all same-domain links from the rendered page."""
        raw_links = await page.evaluate("""() => {
            const links = new Set();
            for (const a of document.querySelectorAll('a[href]')) {
                try {
                    const url = new URL(a.href, window.location.origin);
                    if (url.protocol === 'http:' || url.protocol === 'https:') {
                        url.hash = '';
                        links.add(url.href);
                    }
                } catch {}
            }
            return [...links];
        }""")

        return [
            link for link in raw_links
            if self._is_same_domain(link) and not self._should_skip(link)
        ]

    def _is_same_domain(self, url: str) -> bool:
        return urlparse(url).netloc == self.base_domain

    def _should_skip(self, url: str) -> bool:
        skip_extensions = {".pdf", ".zip", ".png", ".jpg", ".jpeg", ".gif", ".svg",
                          ".css", ".js", ".ico", ".woff", ".woff2", ".ttf", ".mp4", ".mp3"}
        path = urlparse(url).path.lower()
        return any(path.endswith(ext) for ext in skip_extensions)

    def _normalize(self, url: str) -> str:
        parsed = urlparse(url)
        params = sorted(parse_qs(parsed.query).items())
        normalized = parsed._replace(
            fragment="",
            query=urlencode(params, doseq=True),
            path=parsed.path.rstrip("/") or "/",
        )
        return urlunparse(normalized)
