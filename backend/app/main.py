"""FlowLens API — Backend server with SSE streaming for live scan progress."""

import asyncio
import json
import uuid
import sys
import os
from datetime import datetime
from pathlib import Path

from fastapi import FastAPI, BackgroundTasks, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent))

from agent.core.scanner import FlowLensScanner
from agent.models.types import CrawlResult

app = FastAPI(title="FlowLens API", version="0.2.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:3000",
        "https://flowlens.in",
        "https://www.flowlens.in",
        "https://flowlens-pi.vercel.app",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

scans: dict[str, dict] = {}
# Per-scan event queues for SSE streaming
_event_queues: dict[str, list[asyncio.Queue]] = {}


class ScanRequest(BaseModel):
    url: str
    max_pages: int = 10
    viewports: list[str] = ["desktop", "mobile"]


class ScanResponse(BaseModel):
    scan_id: str
    status: str
    url: str


@app.get("/health")
def health():
    return {"status": "ok", "service": "flowlens-api", "version": "0.2.0"}


@app.post("/api/v1/scan", response_model=ScanResponse)
async def start_scan(req: ScanRequest, background_tasks: BackgroundTasks):
    url = req.url.strip()
    if not url.startswith("http"):
        url = f"https://{url}"

    scan_id = str(uuid.uuid4())[:8]

    scans[scan_id] = {
        "scan_id": scan_id,
        "url": url,
        "status": "running",
        "started_at": datetime.now().isoformat(),
        "result": None,
        "error": None,
    }
    _event_queues[scan_id] = []

    background_tasks.add_task(run_scan, scan_id, url, req.max_pages, req.viewports)

    return ScanResponse(scan_id=scan_id, status="running", url=url)


@app.get("/api/v1/scan/{scan_id}/stream")
async def scan_stream(scan_id: str, request: Request):
    """SSE endpoint that streams live progress events during a scan."""
    if scan_id not in scans:
        return {"error": "Scan not found"}

    queue: asyncio.Queue = asyncio.Queue()

    if scan_id not in _event_queues:
        _event_queues[scan_id] = []
    _event_queues[scan_id].append(queue)

    async def event_generator():
        try:
            while True:
                if await request.is_disconnected():
                    break

                try:
                    event = await asyncio.wait_for(queue.get(), timeout=30.0)
                except asyncio.TimeoutError:
                    yield f": keepalive\n\n"
                    continue

                if event is None:
                    break

                event_type = event.get("type", "update")
                data = json.dumps(event)
                yield f"event: {event_type}\ndata: {data}\n\n"

                if event_type == "scan_complete":
                    break
        finally:
            if scan_id in _event_queues and queue in _event_queues[scan_id]:
                _event_queues[scan_id].remove(queue)

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@app.get("/api/v1/scan/{scan_id}")
async def get_scan(scan_id: str):
    if scan_id not in scans:
        return {"error": "Scan not found"}, 404

    scan = scans[scan_id]

    if scan["status"] == "completed" and scan["result"]:
        result: CrawlResult = scan["result"]
        screenshots = scan.get("screenshots", {})

        bugs_with_details = []
        for b in result.bugs:
            bug_data = b.to_dict()
            screenshot_key = b.evidence.get("screenshot_key", "")
            if screenshot_key in screenshots:
                bug_data["screenshot_b64"] = screenshots[screenshot_key]
            bug_data["repro_steps"] = b.evidence.get("repro_steps", [])
            bugs_with_details.append(bug_data)

        return {
            "scan_id": scan_id,
            "status": "completed",
            "url": scan["url"],
            "started_at": scan["started_at"],
            "completed_at": result.completed_at.isoformat() if result.completed_at else None,
            "duration_seconds": (result.completed_at - result.started_at).total_seconds() if result.completed_at and result.started_at else None,
            "health_score": result.health_score,
            "pages_tested": result.pages_tested,
            "bugs": bugs_with_details,
            "bug_summary": {
                "total": len(result.bugs),
                "by_severity": _count_by(result.bugs, "severity"),
                "by_category": _count_by(result.bugs, "category"),
                "by_confidence": _count_by(result.bugs, "confidence"),
            },
            "metrics": [
                {
                    "url": m.url,
                    "viewport": m.viewport,
                    "load_time_ms": m.load_time_ms,
                    "ttfb_ms": m.ttfb_ms,
                    "fcp_ms": m.fcp_ms,
                    "dom_node_count": m.dom_node_count,
                    "request_count": m.request_count,
                    "transfer_bytes": m.transfer_bytes,
                }
                for m in result.metrics
            ],
            "pages_visited": result.pages_visited,
            "site_graph": scan.get("site_graph", {}),
            "screenshots": {k: v for k, v in list(screenshots.items())[:20]},
            "errors": result.errors,
            "flows": [r.to_dict() for r in result.flows] if getattr(result, "flows", None) else [],
        }

    return {
        "scan_id": scan_id,
        "status": scan["status"],
        "url": scan["url"],
        "started_at": scan["started_at"],
        "error": scan.get("error"),
    }


@app.get("/api/v1/scans")
async def list_scans():
    return [
        {
            "scan_id": s["scan_id"],
            "url": s["url"],
            "status": s["status"],
            "started_at": s["started_at"],
            "health_score": s["result"].health_score if s.get("result") else None,
        }
        for s in scans.values()
    ]


def _broadcast_event(scan_id: str, event_type: str, data: dict):
    """Push an SSE event to all connected clients for this scan."""
    event = {"type": event_type, **data}
    queues = _event_queues.get(scan_id, [])
    for q in queues:
        try:
            q.put_nowait(event)
        except asyncio.QueueFull:
            pass


async def run_scan(scan_id: str, url: str, max_pages: int, viewports: list[str]):
    try:
        def on_progress(event_type: str, data: dict):
            _broadcast_event(scan_id, event_type, data)

        scanner = FlowLensScanner(
            url=url,
            max_pages=max_pages,
            viewports=viewports,
            on_progress=on_progress,
        )
        result = await scanner.scan()
        scans[scan_id]["status"] = "completed"
        scans[scan_id]["result"] = result
        scans[scan_id]["screenshots"] = scanner.get_screenshots()
        scans[scan_id]["site_graph"] = scanner.get_site_graph()
    except Exception as e:
        scans[scan_id]["status"] = "failed"
        scans[scan_id]["error"] = str(e)[:500]
        _broadcast_event(scan_id, "scan_failed", {"error": str(e)[:500]})

    # Signal end to all SSE listeners
    for q in _event_queues.get(scan_id, []):
        try:
            q.put_nowait(None)
        except asyncio.QueueFull:
            pass


def _count_by(bugs, attr: str) -> dict[str, int]:
    counts: dict[str, int] = {}
    for bug in bugs:
        val = getattr(bug, attr).value if hasattr(getattr(bug, attr), "value") else str(getattr(bug, attr))
        counts[val] = counts.get(val, 0) + 1
    return counts
