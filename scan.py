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


async def run_scan(url: str, max_pages: int, viewports: list[str]):
    scanner = FlowLensScanner(url=url, max_pages=max_pages, viewports=viewports)
    return await scanner.scan()


if __name__ == "__main__":
    main()
