"""Bearer-token authentication shared with apps/web.

The TS replay-engine signs every request with `REPLAY_WORKER_SHARED_SECRET`.
We do constant-time comparison so timing attacks don't leak the secret.
"""
from __future__ import annotations

import hmac

from fastapi import Header, HTTPException, status

from .config import get_settings


def require_bearer(authorization: str | None = Header(default=None)) -> None:
    """Reject any request that doesn't carry a valid bearer token.

    Use as a FastAPI dependency:

        @app.post("/run", dependencies=[Depends(require_bearer)])
    """
    settings = get_settings()
    expected = settings.replay_worker_shared_secret
    if not expected:
        # Dev / local without a secret set — disallow rather than auth-bypass
        # to make sure misconfiguration fails loud.
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="REPLAY_WORKER_SHARED_SECRET is not configured.",
        )
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="missing bearer")
    presented = authorization.split(" ", 1)[1].strip()
    if not hmac.compare_digest(presented.encode(), expected.encode()):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="invalid bearer")
