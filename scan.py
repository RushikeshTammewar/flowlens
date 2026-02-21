#!/usr/bin/env python3
"""
FlowLens CLI Scanner
Usage: python scan.py https://example.com [--pages 20] [--viewport desktop,mobile]
"""

import argparse
import asyncio
import json
import sys
from pathlib import Path

from agent.core.scanner import FlowLensScanner
from agent.core.report import print_report


def main():
    parser = argparse.ArgumentParser(
        description="FlowLens — Scan a website for bugs",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="Example: python scan.py https://example.com --pages 10",
    )
    parser.add_argument("url", help="Website URL to scan")
    parser.add_argument("--pages", type=int, default=20, help="Max pages to crawl (default: 20)")
    parser.add_argument("--viewport", default="desktop,mobile", help="Viewports to test (default: desktop,mobile)")
    parser.add_argument("--json", action="store_true", help="Output results as JSON instead of table")

    args = parser.parse_args()

    url = args.url
    if not url.startswith("http"):
        url = f"https://{url}"

    viewports = [v.strip() for v in args.viewport.split(",")]

    print(f"\n🔍 FlowLens scanning {url}")
    print(f"   Max pages: {args.pages} | Viewports: {', '.join(viewports)}\n")

    result = asyncio.run(run_scan(url, args.pages, viewports))

    if args.json:
        output = {
            "url": result.url,
            "health_score": result.health_score,
            "pages_tested": result.pages_tested,
            "bugs": [b.to_dict() for b in result.bugs],
            "pages_visited": result.pages_visited,
            "errors": result.errors,
        }
        print(json.dumps(output, indent=2))
    else:
        print_report(result)


def _cli_progress(event_type: str, data: dict):
    if event_type == "visiting_page":
        print(f"   [{data.get('page_number', '?')}/{data.get('total_discovered', '?')}] Visiting {data.get('url', '')[:80]}")
    elif event_type == "elements_found":
        total = data.get("total", 0)
        print(f"         Found {total} interactive elements")
    elif event_type == "bug_found":
        print(f"         🐛 {data.get('severity', '')} {data.get('title', '')[:80]}")
    elif event_type == "page_discovered":
        via = data.get("via", "")
        if via:
            print(f"         → Discovered {data.get('url', '')[:60]} (via {via})")
    elif event_type == "scan_complete":
        print(f"\n   ✓ Complete: {data.get('pages', 0)} pages, {data.get('bugs', 0)} bugs, {data.get('actions_taken', 0)} actions\n")


async def run_scan(url: str, max_pages: int, viewports: list[str]):
    try:
        scanner = FlowLensScanner(url=url, max_pages=max_pages, viewports=viewports, on_progress=_cli_progress)
        return await scanner.scan()
    except Exception as e:
        print(f"\n  Error during scan: {e}")
        sys.exit(1)


if __name__ == "__main__":
    main()
