"""Pre-import shim that defuses browser-use's macOS-AppKit display detection.

# Why this file exists

browser-use 0.12.6 instantiates `DEFAULT_BROWSER_PROFILE = BrowserProfile()`
at module-import time inside `browser_use.browser.session` (line 60). Pydantic
runs `model_post_init`, which calls
`detect_display_configuration() → get_display_size()` and that function does:

    from AppKit import NSScreen
    NSScreen.mainScreen().frame()

`NSScreen.mainScreen()` is a Cocoa call that contacts the macOS WindowServer.
In sandboxed environments (Cursor terminals, restricted Docker, CI without a
display server, AWS Sandbox / Vercel Sandbox-like microVMs) that syscall is
denied — and AppKit responds by calling C-level `abort()`, which raises
SIGABRT and kills the Python process with exit code 134.

That C-level abort is **not** a Python exception, so the `try/except Exception`
that browser-use wraps around the AppKit call provides no protection.
Empirically observed during Phase 3.8's `/run` E2E smoke: sidecar accepted
POST /run, returned HTTP 200, then died mid-stream. Stack trace via
`PYTHONFAULTHANDLER=1`:

    File ".../browser_use/browser/profile.py", line 206, in get_display_size
    File ".../browser_use/browser/profile.py", line 1190, in detect_display_configuration
    File ".../browser_use/browser/profile.py", line 799, in model_post_init
    File ".../browser_use/browser/session.py", line 60, in <module>

# What this shim does

Replaces `browser_use.browser.profile.get_display_size` with a no-op that
returns `None`. Browser-use then defaults to a 1920×1080 viewport (same as
the headless Linux fallback path), which is exactly what we want for replay:
the recording carries its own viewport metadata and we override per-step.

# Why it's safe

* No-op only on macOS — Linux/Windows skip the AppKit branch by definition,
  so monkey-patching there would be a no-op anyway and we leave it alone for
  defensiveness.
* The function is lru-cached. We replace the wrapped function before any
  caller invokes it, so no stale cached result.
* Production target (AWS App Runner Linux) never hits this path; the shim
  only affects local dev + sandboxed-Mac testing.

# Long-term

We've filed an upstream issue (TODO once we have the issue tracker URL).
When browser-use ships a fix that wraps the AppKit call in `os.fork()` or
similar (so the abort is contained in a child process), this shim becomes
redundant and can be deleted.
"""
from __future__ import annotations

import sys


def _install_shim() -> None:
    if sys.platform != "darwin":
        # Linux + Windows skip AppKit naturally; no shim needed.
        return
    try:
        from browser_use.browser import profile  # type: ignore[import-not-found]
    except ImportError:
        # browser-use not installed yet (e.g. type-checking with stub). Silent skip.
        return

    def _safe_get_display_size() -> None:
        """Return None unconditionally — browser-use falls back to 1920×1080."""
        return None

    profile.get_display_size = _safe_get_display_size  # type: ignore[assignment]


_install_shim()
