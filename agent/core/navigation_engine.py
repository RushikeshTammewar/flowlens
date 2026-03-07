"""Navigation engine powered by Browser-Use.

All browser interaction goes through this module. FlowLens's QA logic
treats it as a black box: give it a task in natural language, get back
the result and page state.

Architecture:
- ONE BrowserSession lives for the entire scan (keep_alive=True).
- Each task creates a fresh Agent that reuses the same session.
- After Agent.run(), a health check detects if Chrome died (heavy sites
  like YouTube can crash Chrome between tasks) and auto-restarts.
- navigate_to() moves to the next page between tasks.
- stop() tears down the session at the very end.
"""

from __future__ import annotations

import asyncio
import base64
import logging
import os
from dataclasses import dataclass, field
from typing import Any, Callable

logger = logging.getLogger(__name__)

TASK_TIMEOUT_SECONDS = 120


@dataclass
class PageState:
    """Snapshot of the current browser page for QA analysis."""
    url: str = ""
    title: str = ""
    screenshot_b64: str | None = None


@dataclass
class NavigationResult:
    """Result of a Browser-Use navigation task."""
    success: bool = False
    final_url: str = ""
    actions_taken: int = 0
    extracted_content: str | None = None
    errors: list[str] = field(default_factory=list)


ProgressCallback = Callable[[str, dict], None]


def _ensure_google_api_key():
    """Browser-Use's ChatGoogle expects GOOGLE_API_KEY."""
    if os.environ.get("GEMINI_API_KEY") and not os.environ.get("GOOGLE_API_KEY"):
        os.environ["GOOGLE_API_KEY"] = os.environ["GEMINI_API_KEY"]


def _write_chrome_prefs(user_data_dir: str):
    """Disable password manager and safe-browsing at the Chrome profile level."""
    import json

    default_dir = os.path.join(user_data_dir, "Default")
    os.makedirs(default_dir, exist_ok=True)
    prefs_path = os.path.join(default_dir, "Preferences")

    prefs: dict = {}
    if os.path.exists(prefs_path):
        try:
            with open(prefs_path) as f:
                prefs = json.load(f)
        except Exception:
            prefs = {}

    prefs.setdefault("credentials_enable_service", False)
    prefs.setdefault("credentials_enable_autosignin", False)
    prefs.setdefault("profile", {})
    prefs["profile"]["password_manager_enabled"] = False
    prefs["profile"]["password_manager_leak_detection"] = False
    prefs.setdefault("password_manager", {})
    prefs["password_manager"]["password_leak_detection_enabled"] = False
    prefs["password_manager"]["credentials_enable_service"] = False
    prefs.setdefault("safebrowsing", {})
    prefs["safebrowsing"]["enabled"] = False
    prefs["safebrowsing"]["enhanced"] = False

    with open(prefs_path, "w") as f:
        json.dump(prefs, f)


class NavigationEngine:
    """LLM-driven browser navigation via Browser-Use.

    Lifecycle follows browser-use's intended pattern:
      1. start() launches ONE BrowserSession with keep_alive=True.
      2. execute_task() creates a per-task Agent that reuses the session.
      3. After Agent.run(), AboutBlankWatchdog keeps Chrome alive.
      4. navigate_to() moves to the next page — no restart needed.
      5. stop() tears down the session at the very end.
    """

    def __init__(
        self,
        on_progress: ProgressCallback | None = None,
        headless: bool = True,
        storage_state: str | None = None,
        user_data_dir: str | None = None,
        sensitive_data: dict[str, Any] | None = None,
    ):
        self._emit = on_progress or (lambda *_: None)
        self._headless = headless
        self._storage_state = storage_state
        self._user_data_dir = user_data_dir
        self._sensitive_data = sensitive_data
        self._browser = None
        self._llm = None

    def _get_llm(self):
        if self._llm is not None:
            return self._llm

        _ensure_google_api_key()

        if os.environ.get("GOOGLE_API_KEY"):
            from browser_use import ChatGoogle
            model = os.environ.get("GEMINI_MODEL", "gemini-2.5-flash")
            self._llm = ChatGoogle(model=model)
            return self._llm

        if os.environ.get("ANTHROPIC_API_KEY"):
            from browser_use import ChatAnthropic
            self._llm = ChatAnthropic(model="claude-sonnet-4-20250514")
            return self._llm

        if os.environ.get("OPENAI_API_KEY"):
            from browser_use import ChatOpenAI
            self._llm = ChatOpenAI(model="gpt-4o-mini")
            return self._llm

        raise RuntimeError(
            "No LLM API key found. Set GEMINI_API_KEY, GOOGLE_API_KEY, "
            "ANTHROPIC_API_KEY, or OPENAI_API_KEY."
        )

    # ──────────────────────────────────────────────
    # Lifecycle
    # ──────────────────────────────────────────────

    async def start(self):
        """Launch ONE BrowserSession for the entire scan."""
        from browser_use import BrowserSession

        user_data_dir = self._user_data_dir
        if user_data_dir:
            _write_chrome_prefs(user_data_dir)

        kwargs: dict[str, Any] = {
            "headless": self._headless,
            "keep_alive": True,
            "disable_security": True,
        }
        if user_data_dir:
            kwargs["user_data_dir"] = user_data_dir
        if self._storage_state:
            kwargs["storage_state"] = self._storage_state

        self._browser = BrowserSession(**kwargs)
        await self._browser.start()
        self._emit("debug", {"msg": "Browser launched via Browser-Use (CDP)"})

    async def stop(self):
        """Close browser at the end of the scan."""
        if self._browser:
            try:
                async with asyncio.timeout(10):
                    await self._browser.stop()
            except Exception:
                pass
        self._browser = None

    @property
    def is_running(self) -> bool:
        return self._browser is not None

    async def _ensure_browser_alive(self):
        """Detect if Chrome died (common on heavy sites) and auto-restart."""
        if not self._browser:
            return
        try:
            async with asyncio.timeout(5):
                url = await self._browser.get_current_page_url()
            if url is not None:
                return
        except Exception:
            pass
        self._emit("debug", {"msg": "Chrome process died, restarting browser..."})
        try:
            await self._browser.stop()
        except Exception:
            pass
        self._browser = None
        await self.start()

    # ──────────────────────────────────────────────
    # Navigation
    # ──────────────────────────────────────────────

    async def navigate_to(self, url: str) -> PageState:
        """Navigate to a URL. Auto-restarts Chrome if it crashed."""
        await self._ensure_browser_alive()
        if not self._browser:
            return PageState()

        self._emit("debug", {"msg": f"Navigating to {url}"})
        try:
            await self._browser.navigate_to(url)
        except Exception as e:
            logger.warning(f"navigate_to {url} failed: {e}")
            await self._ensure_browser_alive()
            if self._browser:
                try:
                    await self._browser.navigate_to(url)
                except Exception:
                    pass

        return await self.get_page_state()

    async def execute_task(
        self,
        task: str,
        max_steps: int = 15,
    ) -> NavigationResult:
        """Execute a natural-language task via a fresh Agent on the shared session.

        Includes a hard timeout (TASK_TIMEOUT_SECONDS) and auto-restarts
        Chrome if it died between tasks.
        """
        await self._ensure_browser_alive()
        if not self._browser:
            return NavigationResult(success=False, errors=["Browser not started"])

        self._emit("agent_thinking", {
            "thought": f"Browser agent: {task[:100]}",
        })

        from browser_use import Agent

        agent = Agent(
            task=task,
            llm=self._get_llm(),
            browser=self._browser,
            max_actions_per_step=5,
            use_vision=True,
            max_failures=3,
            sensitive_data=self._sensitive_data,
            use_judge=False,
        )

        try:
            async with asyncio.timeout(TASK_TIMEOUT_SECONDS):
                history = await agent.run(max_steps=max_steps)
        except TimeoutError:
            self._emit("agent_thinking", {
                "thought": f"Browser agent timed out after {TASK_TIMEOUT_SECONDS}s",
            })
            return NavigationResult(
                success=False,
                final_url=await self._current_url(),
                errors=[f"Task timed out after {TASK_TIMEOUT_SECONDS}s"],
            )
        except Exception as e:
            return NavigationResult(
                success=False,
                final_url=await self._current_url(),
                errors=[str(e)[:300]],
            )

        is_done = history.is_done() if hasattr(history, "is_done") else True
        final_content = (
            history.final_result()
            if hasattr(history, "final_result")
            else None
        )

        agent_success = False
        errors: list[str] = []
        if history.history:
            last_entry = history.history[-1]
            if last_entry.result:
                last_result = last_entry.result[-1]
                agent_success = bool(getattr(last_result, "success", False))
                if last_result.error:
                    errors.append(str(last_result.error)[:200])

        success = is_done and agent_success
        status = "completed" if success else "had errors"
        self._emit("agent_thinking", {
            "thought": f"Browser agent {status} ({len(history.history)} steps)",
        })

        return NavigationResult(
            success=success,
            final_url=await self._current_url(),
            actions_taken=len(history.history),
            extracted_content=str(final_content) if final_content else None,
            errors=errors,
        )

    # ──────────────────────────────────────────────
    # Page inspection
    # ──────────────────────────────────────────────

    async def get_page_state(self) -> PageState:
        """Get current page URL, title, and screenshot."""
        if not self._browser:
            return PageState()

        url = await self._current_url()
        title = await self._current_title()
        screenshot_b64 = await self._take_screenshot()

        return PageState(url=url, title=title, screenshot_b64=screenshot_b64)

    async def execute_javascript(self, script: str) -> Any:
        """Run JavaScript on the current page via CDP Runtime.evaluate."""
        if not self._browser:
            return None

        try:
            cdp = self._browser.cdp_client
            if cdp is None:
                return None

            result = await cdp.send(
                "Runtime.evaluate",
                {"expression": script, "returnByValue": True},
            )
            val = result.get("result", {})
            if val.get("type") == "undefined":
                return None
            return val.get("value")
        except Exception as e:
            logger.debug(f"execute_javascript failed: {e}")
            return None

    async def get_links(self, base_domain: str) -> list[dict]:
        """Discover links on the current page."""
        raw = await self.execute_javascript("""(() => {
            const links = [];
            const seen = new Set();
            for (const a of document.querySelectorAll('a[href]')) {
                try {
                    const u = new URL(a.href, location.origin);
                    if (!u.protocol.startsWith('http')) continue;
                    u.hash = '';
                    const href = u.href;
                    if (seen.has(href)) continue;
                    seen.add(href);
                    const text = (a.textContent || '').trim().substring(0, 80);
                    const inNav = !!a.closest('nav, header, [role="navigation"]');
                    links.push({href, text, inNav});
                } catch {}
            }
            return links;
        })()""")

        if not raw or not isinstance(raw, list):
            return []
        return [l for l in raw if base_domain in l.get("href", "")]

    # ──────────────────────────────────────────────
    # Internals
    # ──────────────────────────────────────────────

    async def _current_url(self) -> str:
        if not self._browser:
            return ""
        try:
            url = await self._browser.get_current_page_url()
            return str(url) if url else ""
        except Exception:
            return ""

    async def _current_title(self) -> str:
        if not self._browser:
            return ""
        try:
            title = await self._browser.get_current_page_title()
            return str(title) if title else ""
        except Exception:
            return ""

    async def _take_screenshot(self) -> str | None:
        if not self._browser:
            return None
        try:
            raw = await self._browser.take_screenshot(format="jpeg", quality=60)
            if isinstance(raw, bytes):
                return base64.b64encode(raw).decode()
            return None
        except Exception:
            return None
