"""Auth-wall detection for the replay loop.

Returns True if the current page state looks like the user got redirected
to a login wall mid-replay. Triggers a `paused_auth` SSE event so the TS
workflow caller can checkpoint and ask the user to refresh cookies.

Heuristics (all required to be cheap; this runs after every step):
  - URL pattern match: /(login|signin|sign-in|sso|auth|account)/ in path
  - HTTP 401/403 on the most recent main-frame request
  - DOM has a visible password input that wasn't there in the recorded
    screenshot (we approximate by just "has a password input" since the
    server doesn't have the recorded screenshot loaded).
"""
from __future__ import annotations

import re
from typing import Any

_AUTH_URL_RE = re.compile(r"/(login|signin|sign-in|sso|auth|account)\b", re.IGNORECASE)


async def detect_auth_wall(
    session: Any, last_status_code: int | None
) -> tuple[bool, str | None]:
    """Returns `(is_auth_wall, hint)`."""
    if last_status_code in (401, 403):
        return True, f"replay received HTTP {last_status_code}"

    # Current URL probe — works on every browser-use version we've seen.
    try:
        url_getter = getattr(session, "get_current_page_url", None)
        if url_getter is not None:
            url = await url_getter()
            if isinstance(url, str) and _AUTH_URL_RE.search(url):
                return True, f"navigated to login URL {url}"
    except Exception:
        pass

    # DOM probe: any visible <input type=password> is a strong signal.
    try:
        evaluator = getattr(session, "evaluate", None) or getattr(session, "execute_javascript", None)
        if evaluator is not None:
            has_pwd = await evaluator(
                "(() => { const el = document.querySelector('input[type=\"password\"]');"
                " return !!(el && (el.offsetWidth > 0 || el.offsetHeight > 0)); })()"
            )
            if has_pwd:
                return True, "visible password input detected"
    except Exception:
        pass

    return False, None
