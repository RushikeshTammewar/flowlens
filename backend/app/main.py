"""FlowLens API — Backend server for scan orchestration."""

import asyncio
import uuid
import sys
import os
from datetime import datetime
from pathlib import Path

from fastapi import FastAPI, BackgroundTasks
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, HttpUrl

sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent))

from agent.core.scanner import FlowLensScanner
from agent.models.types import CrawlResult

app = FastAPI(title="FlowLens API", version="0.1.0")

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
    return {"status": "ok", "service": "flowlens-api", "version": "0.1.0"}


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

    background_tasks.add_task(run_scan, scan_id, url, req.max_pages, req.viewports)

    return ScanResponse(scan_id=scan_id, status="running", url=url)


@app.get("/api/v1/scan/{scan_id}")
async def get_scan(scan_id: str):
    if scan_id not in scans:
        return {"error": "Scan not found"}, 404

    scan = scans[scan_id]

    if scan["status"] == "completed" and scan["result"]:
        result: CrawlResult = scan["result"]
        return {
            "scan_id": scan_id,
            "status": "completed",
            "url": scan["url"],
            "started_at": scan["started_at"],
            "health_score": result.health_score,
            "pages_tested": result.pages_tested,
            "bugs": [b.to_dict() for b in result.bugs],
            "metrics": [
                {
                    "url": m.url,
                    "viewport": m.viewport,
                    "load_time_ms": m.load_time_ms,
                    "fcp_ms": m.fcp_ms,
                    "dom_node_count": m.dom_node_count,
                }
                for m in result.metrics
            ],
            "pages_visited": result.pages_visited,
            "errors": result.errors,
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


async def run_scan(scan_id: str, url: str, max_pages: int, viewports: list[str]):
    try:
        scanner = FlowLensScanner(url=url, max_pages=max_pages, viewports=viewports)
        result = await scanner.scan()
        scans[scan_id]["status"] = "completed"
        scans[scan_id]["result"] = result
    except Exception as e:
        scans[scan_id]["status"] = "failed"
        scans[scan_id]["error"] = str(e)[:500]
