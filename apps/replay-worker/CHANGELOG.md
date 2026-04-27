# flowlens-replay-worker — CHANGELOG

## 0.0.2 — 2026-04-27 — SIGABRT on import + defensive `/run` error handling

### Fixed

- **SIGABRT (exit 134) at `BrowserSession` import time on macOS sandboxes.**
  `browser-use` 0.12.6 instantiates `DEFAULT_BROWSER_PROFILE = BrowserProfile()`
  at module load (`browser_use/browser/session.py:60`). The Pydantic
  `model_post_init` hook calls `detect_display_configuration()` →
  `get_display_size()`, which on macOS does
  `from AppKit import NSScreen` then `NSScreen.mainScreen().frame()`. That call
  contacts the macOS WindowServer; in sandboxed environments (Cursor terminals,
  restricted Docker on Mac, CI without a display) the syscall is denied and
  AppKit calls C-level `abort()` → SIGABRT. The native abort is **not** a
  Python exception, so `browser-use`'s `try/except Exception` around the
  AppKit call provides no protection.

  **Fix:** new `app/_browser_use_compat.py` shim that, on macOS only, replaces
  `browser_use.browser.profile.get_display_size` with a no-op returning `None`.
  `browser-use` then falls back to a `1920×1080` viewport (its existing default
  for headless/no-display paths) — exactly what we want for replay since each
  recording carries its own viewport metadata. Imported as a side-effect from
  `app/__init__.py` and `tests/conftest.py` so it runs before any code path
  that would import `browser_use.browser.session` (including
  `unittest.mock.patch("browser_use.X")` which calls `mock.get_original` and
  triggers the import). Linux/Windows production deploys are unaffected — the
  shim is a no-op there since AppKit isn't installed in the first place.

- **Defensive error handling around `BrowserSession.start()` and per-step
  execution in `_replay()`.** Before this change, any exception during CDP
  handshake or mid-step would propagate up through the SSE generator and tear
  down the stream — the TS-side caller would see a connection drop, identical
  to a hung run. Now:

  - `await session.start()` is wrapped; failure emits a clean
    `RunCompleteEvent(status=errored, errorClass=env)` with the underlying
    error in `summary`.
  - Per-step execution in the new `_drive_steps()` helper catches any
    exception and converts it to a `failed` `StepResult` with
    `errorMessage: "replay-worker exception: <e>"`, so the user sees which
    step actually broke.
  - Auth-wall probe is wrapped — a failed probe no longer halts the run.
  - An outer `try/except` in `_replay()` covers any orchestration bug we
    might introduce later.

### Added

- `tests/test_run_smoke.py` — two end-to-end-ish tests that mock
  `browser_use.{BrowserSession, Agent, llm.ChatOpenAI}` and exercise the full
  `/run` route via `fastapi.testclient`. Asserts a clean
  `step_started → step_finished → run_complete` sequence for the happy path,
  and a clean `run_complete(errored, errorClass=env)` for the
  CDP-handshake-failure path. **No live BU Cloud calls; zero credit spend.**
- `tests/conftest.py` — re-imports the shim before any test runs so
  `mock.patch("browser_use.X")` doesn't trigger the SIGABRT.
- `CHANGELOG.md` (this file).

### Verification

```
$ pytest tests/ -v
============================== 14 passed in 1.17s ==============================
```

vs. pre-fix:

```
$ pytest tests/ -v
... fatal Python error: ... SIGABRT in get_display_size ...
exit_code: 134
```

### Known limitations / next steps

- Test-coverage gap: the shim handles the *Python-level* import crash but
  cannot defend against a *native* abort triggered DEEPER inside `browser-use`
  (e.g. inside the CDP WebSocket layer when handed a real BU Cloud URL).
  We have no evidence of such a crash today, but if one shows up in the live
  /run integration, the right fix is process isolation (run the agent in a
  subprocess) or a version pin / upstream patch.
- An upstream issue should be filed with `browser-use` asking that
  `get_display_size`'s AppKit call be wrapped in a subprocess so the abort is
  contained. TODO when we have the issue tracker URL.
