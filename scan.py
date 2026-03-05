#!/usr/bin/env python3
"""
FlowLens v2 CLI Scanner — Browser-Use Powered
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
        description="FlowLens v2 — AI QA Engineer (Browser-Use powered)",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="Examples:\n"
               "  python scan.py https://example.com\n"
               "  python scan.py https://myapp.com --pages 10\n"
               "  python scan.py https://dashboard.app --no-headless\n"
               "  python scan.py https://shop.com --storage-state auth.json",
    )
    parser.add_argument("url", help="Website URL to scan")
    parser.add_argument("--pages", type=int, default=20, help="Max pages to test (default: 20)")
    parser.add_argument("--viewport", default="desktop", help="Viewports: desktop,mobile (default: desktop)")
    parser.add_argument("--no-headless", action="store_true", help="Show browser window")
    parser.add_argument("--storage-state", type=str, default=None, help="Path to auth cookies JSON")
    parser.add_argument("--user-data-dir", type=str, default=None, help="Chrome profile directory")
    parser.add_argument("--json", action="store_true", help="Output results as JSON")
    # Legacy compat
    parser.add_argument("--headful", action="store_true", help=argparse.SUPPRESS)

    args = parser.parse_args()

    url = args.url
    if not url.startswith("http"):
        url = f"https://{url}"

    viewports = [v.strip() for v in args.viewport.split(",")]
    headless = not (args.no_headless or args.headful)

    print(f"\n  FlowLens v2 scanning {url}")
    print(f"  Max pages: {args.pages} | Viewports: {', '.join(viewports)}")
    print(f"  Navigation: Browser-Use (CDP + LLM)")
    if not headless:
        print(f"  Browser: visible")
    if args.storage_state:
        print(f"  Auth: loading from {args.storage_state}")
    print()

    result = asyncio.run(run_scan(
        url, args.pages, viewports, headless,
        args.storage_state, args.user_data_dir,
    ))

    if args.json:
        output = {
            "url": result.url,
            "health_score": result.health_score,
            "pages_tested": result.pages_tested,
            "bugs": [b.to_dict() for b in result.bugs],
            "flows": [f.to_dict() for f in result.flows] if result.flows else [],
            "pages_visited": result.pages_visited,
            "errors": result.errors,
        }
        print(json.dumps(output, indent=2))
    else:
        print_report(result)


def _cli_progress(event_type: str, data: dict):
    if event_type == "visiting_page":
        print(f"   [{data.get('page_number', '?')}/{data.get('total_discovered', '?')}] Visiting {data.get('url', '')[:80]}")
    elif event_type == "bug_found":
        print(f"         [BUG] {data.get('severity', '')} {data.get('title', '')[:80]}")
    elif event_type == "page_discovered":
        via = data.get("via", "")
        if via:
            print(f"         -> Discovered {data.get('url', '')[:60]} (via {via})")
    elif event_type == "scan_complete":
        print(f"\n   Done: {data.get('pages', 0)} pages, {data.get('bugs', 0)} bugs, "
              f"{data.get('flows', 0)} flows ({data.get('flows_passed', 0)} passed)\n")
    elif event_type == "flow_step":
        print(f"   [Flow: {data.get('flow', '')}] {data.get('step_action', '')} -> {data.get('step_target', '')[:60]}")
    elif event_type == "flow_complete":
        print(f"   [Flow: {data.get('flow', '')}] {data.get('status', '').upper()} ({data.get('duration_ms', 0)}ms)")
    elif event_type == "agent_thinking":
        thought = data.get("thought", "")
        if thought and not thought.startswith("Browser agent"):
            print(f"         AI: {thought[:80]}")


async def run_scan(
    url: str, max_pages: int, viewports: list[str],
    headless: bool, storage_state: str | None, user_data_dir: str | None,
):
    try:
        scanner = FlowLensScanner(
            url=url,
            max_pages=max_pages,
            viewports=viewports,
            on_progress=_cli_progress,
            headless=headless,
            storage_state=storage_state,
            user_data_dir=user_data_dir,
        )
        return await scanner.scan()
    except Exception as e:
        print(f"\n  Error during scan: {e}")
        sys.exit(1)


if __name__ == "__main__":
    main()
