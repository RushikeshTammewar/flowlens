"""Tier 2 detector: basic accessibility checks (without axe-core for PoC)."""

from __future__ import annotations
from agent.models.types import BugFinding, Severity, Category, Confidence


class AccessibilityDetector:

    async def detect(self, page, page_url: str) -> list[BugFinding]:
        """Run basic accessibility checks using DOM queries."""
        findings = []

        # 1. Images without alt text
        missing_alt = await page.evaluate("""() => {
            return [...document.images]
                .filter(img => img.src && !img.hasAttribute('alt'))
                .map(img => ({ src: img.src.substring(0, 100) }));
        }""")
        if len(missing_alt) > 0:
            findings.append(BugFinding(
                title=f"{len(missing_alt)} images missing alt text",
                category=Category.ACCESSIBILITY,
                severity=Severity.P3,
                confidence=Confidence.MEDIUM,
                page_url=page_url,
                description="Images without alt attributes are inaccessible to screen readers.",
                evidence={"count": len(missing_alt), "examples": missing_alt[:5]},
            ))

        # 2. Form inputs without labels
        unlabeled = await page.evaluate("""() => {
            const inputs = document.querySelectorAll('input:not([type="hidden"]):not([type="submit"]):not([type="button"]), select, textarea');
            const missing = [];
            for (const input of inputs) {
                const id = input.id;
                const hasLabel = id && document.querySelector(`label[for="${id}"]`);
                const hasAriaLabel = input.hasAttribute('aria-label') || input.hasAttribute('aria-labelledby');
                const wrappedInLabel = input.closest('label');
                const hasPlaceholder = input.hasAttribute('placeholder');
                if (!hasLabel && !hasAriaLabel && !wrappedInLabel && !hasPlaceholder) {
                    missing.push({
                        tag: input.tagName.toLowerCase(),
                        type: input.type || '',
                        name: input.name || '',
                    });
                }
            }
            return missing;
        }""")
        if len(unlabeled) > 0:
            findings.append(BugFinding(
                title=f"{len(unlabeled)} form inputs without labels",
                category=Category.ACCESSIBILITY,
                severity=Severity.P3,
                confidence=Confidence.MEDIUM,
                page_url=page_url,
                description="Form inputs without associated labels are difficult to use with assistive technology.",
                evidence={"count": len(unlabeled), "examples": unlabeled[:5]},
            ))

        # 3. Missing page language
        has_lang = await page.evaluate("() => !!document.documentElement.lang")
        if not has_lang:
            findings.append(BugFinding(
                title="Missing lang attribute on <html>",
                category=Category.ACCESSIBILITY,
                severity=Severity.P3,
                confidence=Confidence.HIGH,
                page_url=page_url,
                description="The <html> element should have a lang attribute for screen readers.",
            ))

        # 4. Missing page title
        title = await page.title()
        if not title or not title.strip():
            findings.append(BugFinding(
                title="Page has no <title>",
                category=Category.ACCESSIBILITY,
                severity=Severity.P2,
                confidence=Confidence.HIGH,
                page_url=page_url,
            ))

        return findings
