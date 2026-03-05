"""Tier 2 detector: mobile/responsive layout issues.

v2: uses execute_javascript (CDP) instead of Playwright page.evaluate.
"""

from __future__ import annotations

from typing import Any, Callable, Awaitable

from agent.models.types import BugFinding, Severity, Category, Confidence

ExecuteJS = Callable[[str], Awaitable[Any]]

_OVERFLOW = """document.documentElement.scrollWidth > document.documentElement.clientWidth + 5"""

_SMALL_TARGETS = """(() => {
    const els = document.querySelectorAll('a, button, input, select, textarea, [role="button"]');
    const small = [];
    for (const el of els) {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.height > 0 && (r.width < 44 || r.height < 44)) {
            small.push({
                tag: el.tagName.toLowerCase(),
                text: (el.textContent || '').trim().substring(0, 40),
                width: Math.round(r.width),
                height: Math.round(r.height)
            });
        }
    }
    return small;
})()"""

_SMALL_FONT = """(() => {
    const body = document.body;
    if (!body) return false;
    const fontSize = parseFloat(window.getComputedStyle(body).fontSize);
    return fontSize < 14;
})()"""


class ResponsiveDetector:

    async def detect(self, execute_js: ExecuteJS, page_url: str, viewport: str) -> list[BugFinding]:
        findings: list[BugFinding] = []

        has_overflow = await execute_js(_OVERFLOW)
        if has_overflow:
            findings.append(BugFinding(
                title="Horizontal scroll detected",
                category=Category.RESPONSIVE,
                severity=Severity.P2,
                confidence=Confidence.MEDIUM,
                page_url=page_url,
                viewport=viewport,
                description="Page content extends beyond viewport width.",
            ))

        if viewport == "mobile":
            small_targets = await execute_js(_SMALL_TARGETS)
            if isinstance(small_targets, list) and len(small_targets) > 5:
                findings.append(BugFinding(
                    title=f"{len(small_targets)} touch targets below 44x44px",
                    category=Category.RESPONSIVE,
                    severity=Severity.P3,
                    confidence=Confidence.MEDIUM,
                    page_url=page_url,
                    viewport=viewport,
                    description="Multiple interactive elements are too small for mobile touch.",
                    evidence={"count": len(small_targets), "examples": small_targets[:5]},
                ))

            small_text = await execute_js(_SMALL_FONT)
            if small_text:
                findings.append(BugFinding(
                    title="Body font size below 14px on mobile",
                    category=Category.RESPONSIVE,
                    severity=Severity.P3,
                    confidence=Confidence.MEDIUM,
                    page_url=page_url,
                    viewport=viewport,
                    description="Base font size is too small for mobile reading.",
                ))

        return findings
