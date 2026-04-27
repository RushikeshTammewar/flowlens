"""POST /resolve — selector resolution endpoint.

Used by the TS replay-engine when it wants to probe the live DOM without
running a full step. Returns the same `ResolveResultFound | ResolveResultMissing`
shape that the Python `resolve_backend_node_id` returns.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends

from .contracts import ResolveRequest, ResolveResultFound, ResolveResultMissing
from .resolve import resolve_backend_node_id
from .security import require_bearer


router = APIRouter()


@router.post("/resolve", dependencies=[Depends(require_bearer)])
async def post_resolve(
    req: ResolveRequest,
) -> ResolveResultFound | ResolveResultMissing:
    return await resolve_backend_node_id(req.cdpUrl, req.selectors)
