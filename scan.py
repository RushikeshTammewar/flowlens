#!/usr/bin/env python3
"""
FlowLens CLI Scanner
Usage: python scan.py https://example.com [--pages 20] [--viewport desktop,mobile] [--headful]
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
        description="FlowLens — AI QA Engineer for websites",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="Examples:\n"
               "  python scan.py https://example.com\n"
               "  python scan.py https://myapp.com --pages 10 --headful\n"
               "  python scan.py https://dashboard.app --headful   # for sites requiring login",
    )
    parser.add_argument("url", help="Website URL to scan")
    parser.add_argument("--pages", type=int, default=20, help="Max pages to crawl (default: 20)")
    parser.add_argument("--viewport", default="desktop,mobile", help="Viewports to test (default: desktop,mobile)")
    parser.add_argument("--headful", action="store_true", help="Run browser visibly (required for login with OTP/2FA)")
    parser.add_argument("--json", action="store_true", help="Output results as JSON instead of table")

    args = parser.parse_args()

    url = args.url
    if not url.startswith("http"):
        url = f"https://{url}"

    viewports = [v.strip() for v in args.viewport.split(",")]

    print(f"\n  FlowLens scanning {url}")
    print(f"  Max pages: {args.pages} | Viewports: {', '.join(viewports)}", end="")
    if args.headful:
        print(" | Mode: headful (visible browser)")
    else:
        print(" | Mode: headless (login window opens if needed)")
    print()

    result = asyncio.run(run_scan(url, args.pages, viewports, args.headful))

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
    elif event_type == "elements_found":
        total = data.get("total", 0)
        print(f"         Found {total} interactive elements")
    elif event_type == "bug_found":
        print(f"         [BUG] {data.get('severity', '')} {data.get('title', '')[:80]}")
    elif event_type == "page_discovered":
        via = data.get("via", "")
        if via:
            print(f"         -> Discovered {data.get('url', '')[:60]} (via {via})")
    elif event_type == "scan_complete":
        print(f"\n   Done: {data.get('pages', 0)} pages, {data.get('bugs', 0)} bugs, {data.get('actions_taken', 0)} actions\n")
    elif event_type == "flow_step":
        print(f"   [Flow: {data.get('flow', '')}] Step: {data.get('step_action', '')} -> {data.get('step_target', '')[:50]}")
    elif event_type == "flow_complete":
        ctx = data.get("context", {})
        print(f"   [Flow: {data.get('flow', '')}] {data.get('status', '').upper()} ({data.get('duration_ms', 0)}ms)")
    elif event_type == "auth_attempted":
        status = "SUCCESS" if data.get("success") else "FAILED"
        method = data.get("method", "")
        cookies = data.get("cookies_injected", 0)
        msg = data.get("message", "")[:80]
        if data.get("success") and cookies:
            print(f"   [AUTH] {status} via {method}: {cookies} cookies injected. {msg}")
        else:
            print(f"   [AUTH] {status}: {msg}")
    elif event_type == "auth_required":
        pass  # The auth handler prints its own instructions
    elif event_type == "popup_dismissed":
        print(f"         Dismissed overlay: {', '.join(data.get('types', []))}")
    elif event_type == "state_errors":
        for err in data.get("js_errors", [])[:2]:
            print(f"         [JS ERROR] {err[:80]}")
        for url in data.get("network_errors", [])[:2]:
            print(f"         [NET ERROR] {url}")


async def run_scan(url: str, max_pages: int, viewports: list[str], headful: bool = False):
    try:
        scanner = FlowLensScanner(
            url=url,
            max_pages=max_pages,
            viewports=viewports,
            on_progress=_cli_progress,
            headful=headful,
        )
        return await scanner.scan()
    except Exception as e:
        print(f"\n  Error during scan: {e}")
        sys.exit(1)


if __name__ == "__main__":
    main()
