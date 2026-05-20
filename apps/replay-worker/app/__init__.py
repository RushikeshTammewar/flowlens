"""Flowlens v3 Python replay sidecar.

Hosts the bits that browser-use (Python-only library) needs to run:
the Agent loop and tools.act() direct CDP execution. Everything else
(orchestration, persistence, judge, T1+T2 verifiers, run state) lives
in the TS web app.

See `docs/v3/LLD.md` §5.5 and §6 for the full architecture.
"""

# Side-effect import: defuses browser-use's macOS-AppKit display detection
# before any module imports browser_use. See _browser_use_compat.py for the
# full crash-cause writeup. Without this, importing browser_use.BrowserSession
# under a sandboxed macOS environment SIGABRTs the process.
from . import _browser_use_compat  # noqa: F401

__version__ = "0.0.1"
