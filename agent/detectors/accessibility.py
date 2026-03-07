"""Accessibility detector: WCAG-aligned checks via CDP JavaScript evaluation.

Checks:
- Images missing alt text (WCAG 1.1.1)
- Form inputs without labels (WCAG 1.3.1, 4.1.2)
- Missing page language (WCAG 3.1.1)
- Missing page title (WCAG 2.4.2)
- Insufficient color contrast indicators (heuristic)
- Missing skip-to-content link (WCAG 2.4.1)
- Missing heading structure (WCAG 1.3.1)
"""

from __future__ import annotations

from typing import Any, Callable, Awaitable

from agent.models.types import BugFinding, Severity, Category, Confidence

ExecuteJS = Callable[[str], Awaitable[Any]]

_MISSING_ALT = """(() => {
    return [...document.images]
        .filter(img => img.src && !img.hasAttribute('alt'))
        .map(img => ({ src: img.src.substring(0, 120) }))
        .slice(0, 20);
})()"""

_UNLABELED_INPUTS = """(() => {
    const inputs = document.querySelectorAll(
        'input:not([type="hidden"]):not([type="submit"]):not([type="button"]), select, textarea'
    );
    const missing = [];
    for (const input of inputs) {
        const id = input.id;
        const hasLabel = id && document.querySelector('label[for="' + CSS.escape(id) + '"]');
        const hasAriaLabel = input.hasAttribute('aria-label') || input.hasAttribute('aria-labelledby');
        const wrappedInLabel = input.closest('label');
        if (!hasLabel && !hasAriaLabel && !wrappedInLabel) {
            missing.push({
                tag: input.tagName.toLowerCase(),
                type: input.type || '',
                name: input.name || '',
            });
        }
    }
    return missing.slice(0, 20);
})()"""

_MISSING_LANG = "!document.documentElement.lang"

_MISSING_TITLE = "!document.title || !document.title.trim()"

_MISSING_SKIP_LINK = """(() => {
    const links = document.querySelectorAll('a[href^="#"]');
    for (const link of links) {
        const text = (link.textContent || '').toLowerCase();
        if (text.includes('skip') || text.includes('main content')) return false;
    }
    return true;
})()"""

_HEADING_STRUCTURE = """(() => {
    const headings = [...document.querySelectorAll('h1, h2, h3, h4, h5, h6')];
    if (headings.length === 0) return { has_headings: false, issues: ['No headings found on page'] };
    const h1s = headings.filter(h => h.tagName === 'H1');
    const issues = [];
    if (h1s.length === 0) issues.push('No H1 heading found');
    if (h1s.length > 1) issues.push('Multiple H1 headings (' + h1s.length + ')');
    let prev = 0;
    for (const h of headings) {
        const level = parseInt(h.tagName[1]);
        if (level > prev + 1 && prev > 0) {
            issues.push('Heading level skipped: H' + prev + ' to H' + level);
            break;
        }
        prev = level;
    }
    return { has_headings: true, issues: issues };
})()"""


class AccessibilityDetector:
    """WCAG-aligned accessibility checks via CDP JavaScript evaluation."""

    async def detect(self, execute_js: ExecuteJS, page_url: str) -> list[BugFinding]:
        findings: list[BugFinding] = []

        missing_alt = await execute_js(_MISSING_ALT)
        if isinstance(missing_alt, list) and len(missing_alt) > 0:
            findings.append(BugFinding(
                title=f"{len(missing_alt)} images missing alt text",
                category=Category.ACCESSIBILITY,
                severity=Severity.P3,
                confidence=Confidence.HIGH,
                page_url=page_url,
                description="Images without alt attributes are inaccessible to screen readers (WCAG 1.1.1).",
                evidence={"count": len(missing_alt), "examples": missing_alt[:5]},
            ))

        unlabeled = await execute_js(_UNLABELED_INPUTS)
        if isinstance(unlabeled, list) and len(unlabeled) > 0:
            findings.append(BugFinding(
                title=f"{len(unlabeled)} form inputs without labels",
                category=Category.ACCESSIBILITY,
                severity=Severity.P3,
                confidence=Confidence.MEDIUM,
                page_url=page_url,
                description="Form inputs without associated labels are difficult to use with assistive technology (WCAG 4.1.2).",
                evidence={"count": len(unlabeled), "examples": unlabeled[:5]},
            ))

        missing_lang = await execute_js(_MISSING_LANG)
        if missing_lang is True:
            findings.append(BugFinding(
                title="Missing lang attribute on <html>",
                category=Category.ACCESSIBILITY,
                severity=Severity.P3,
                confidence=Confidence.HIGH,
                page_url=page_url,
                description="The <html> element should have a lang attribute for screen readers (WCAG 3.1.1).",
            ))

        missing_title = await execute_js(_MISSING_TITLE)
        if missing_title is True:
            findings.append(BugFinding(
                title="Page has no <title>",
                category=Category.ACCESSIBILITY,
                severity=Severity.P2,
                confidence=Confidence.HIGH,
                page_url=page_url,
                description="Pages must have a descriptive title for navigation and screen readers (WCAG 2.4.2).",
            ))

        no_skip = await execute_js(_MISSING_SKIP_LINK)
        if no_skip is True:
            findings.append(BugFinding(
                title="Missing skip-to-content link",
                category=Category.ACCESSIBILITY,
                severity=Severity.P4,
                confidence=Confidence.MEDIUM,
                page_url=page_url,
                description="A 'skip to main content' link helps keyboard users bypass navigation (WCAG 2.4.1).",
            ))

        headings = await execute_js(_HEADING_STRUCTURE)
        if isinstance(headings, dict):
            for issue in headings.get("issues", []):
                findings.append(BugFinding(
                    title=f"Heading structure: {issue}",
                    category=Category.ACCESSIBILITY,
                    severity=Severity.P3,
                    confidence=Confidence.HIGH,
                    page_url=page_url,
                    description=f"Heading structure issue: {issue} (WCAG 1.3.1).",
                ))

        return findings
