"""Tier 2 detector: mobile/responsive layout issues."""

from __future__ import annotations
from agent.models.types import BugFinding, Severity, Category, Confidence


class ResponsiveDetector:

    async def detect(self, page, page_url: str, viewport: str) -> list[BugFinding]:
        """Check for responsive design issues. Most relevant on mobile viewport."""
        findings = []

        # 1. Horizontal overflow
        has_overflow = await page.evaluate("""() => {
            return document.documentElement.scrollWidth > document.documentElement.clientWidth + 5;
        }""")
        if has_overflow:
            findings.append(BugFinding(
                title="Horizontal scroll detected",
                category=Category.RESPONSIVE,
                severity=Severity.P2,
                confidence=Confidence.MEDIUM,
                page_url=page_url,
                viewport=viewport,
                description="Page content extends beyond viewport width, causing unwanted horizontal scrolling.",
            ))

        # 2. Small touch targets (only check on mobile)
        if viewport == "mobile":
            small_targets = await page.evaluate("""() => {
                const els = document.querySelectorAll('a, button, input, select, textarea, [role="button"]');
                const small = [];
                for (const el of els) {
                    const rect = el.getBoundingClientRect();
                    if (rect.width > 0 && rect.height > 0 && (rect.width < 44 || rect.height < 44)) {
                        small.push({
                            tag: el.tagName.toLowerCase(),
                            text: (el.textContent || '').trim().substring(0, 40),
                            width: Math.round(rect.width),
                            height: Math.round(rect.height),
                        });
                    }
                }
                return small;
            }""")
            if len(small_targets) > 5:
                findings.append(BugFinding(
                    title=f"{len(small_targets)} touch targets below 44x44px",
                    category=Category.RESPONSIVE,
                    severity=Severity.P3,
                    confidence=Confidence.MEDIUM,
                    page_url=page_url,
                    viewport=viewport,
                    description="Multiple interactive elements are too small for comfortable mobile touch interaction.",
                    evidence={"count": len(small_targets), "examples": small_targets[:5]},
                ))

        # 3. Text too small on mobile
        if viewport == "mobile":
            small_text = await page.evaluate("""() => {
                const body = document.body;
                if (!body) return false;
                const style = window.getComputedStyle(body);
                const fontSize = parseFloat(style.fontSize);
                return fontSize < 14;
            }""")
            if small_text:
                findings.append(BugFinding(
                    title="Body font size below 14px on mobile",
                    category=Category.RESPONSIVE,
                    severity=Severity.P3,
                    confidence=Confidence.MEDIUM,
                    page_url=page_url,
                    viewport=viewport,
                    description="Base font size is too small for comfortable mobile reading.",
                ))

        return findings
