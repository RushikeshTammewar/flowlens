"""Remote browser session for web-based login.

Launches a headful Playwright browser on a virtual display (Xvfb),
streams screenshots to the frontend, and relays user interactions
(clicks, typing, keypresses) back to the browser. When login succeeds,
extracts cookies for injection into the scanning session.
"""

from __future__ import annotations

import asyncio
import base64
import os
import subprocess
from dataclasses import dataclass, field
from urllib.parse import urlparse

from playwright.async_api import async_playwright, Page, Browser, BrowserContext

_LOGIN_KEYWORDS = {"login", "signin", "sign-in", "sign_in", "auth", "authenticate",
                   "identifier", "sso", "oauth", "servicelog"}

_XVFB_DISPLAY = ":99"


@dataclass
class RemoteBrowserSession:
    """Manages a headful browser on a virtual display for remote login."""

    login_url: str
    on_frame: callable | None = None
    on_auth_complete: callable | None = None

    _browser: Browser | None = field(default=None, repr=False)
    _context: BrowserContext | None = field(default=None, repr=False)
    _page: Page | None = field(default=None, repr=False)
    _pw: object | None = field(default=None, repr=False)
    _streaming: bool = field(default=False, repr=False)
    _closed: bool = field(default=False, repr=False)
    _cookies: list[dict] = field(default_factory=list, repr=False)
    _auth_success: bool = field(default=False, repr=False)

    async def start(self):
        """Launch headful browser on Xvfb and navigate to login URL."""
        _ensure_xvfb()

        self._pw = await async_playwright().start()

        self._browser = await self._pw.chromium.launch(
            headless=False,
            args=[
                "--no-sandbox",
                "--disable-setuid-sandbox",
                f"--display={_XVFB_DISPLAY}",
            ],
        )
        self._context = await self._browser.new_context(
            viewport={"width": 1280, "height": 800},
            user_agent="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        )
        self._page = await self._context.new_page()
        await self._page.goto(self.login_url, wait_until="domcontentloaded", timeout=30000)
        await self._page.wait_for_timeout(1000)

        self._streaming = True
        asyncio.create_task(self._screenshot_loop())
        asyncio.create_task(self._login_detection_loop())

    async def click(self, x: float, y: float):
        if self._page and not self._closed:
            await self._page.mouse.click(x, y)
            await self._page.wait_for_timeout(100)

    async def type_text(self, text: str):
        if self._page and not self._closed:
            await self._page.keyboard.type(text, delay=50)

    async def press_key(self, key: str):
        if self._page and not self._closed:
            await self._page.keyboard.press(key)
            await self._page.wait_for_timeout(100)

    async def scroll(self, delta_x: float, delta_y: float):
        if self._page and not self._closed:
            await self._page.mouse.wheel(delta_x, delta_y)

    async def get_cookies(self) -> list[dict]:
        if self._context and not self._closed:
            return await self._context.cookies()
        return self._cookies

    async def close(self):
        self._closed = True
        self._streaming = False
        if self._context:
            self._cookies = await self._context.cookies()
        try:
            if self._browser:
                await self._browser.close()
        except Exception:
            pass
        try:
            if self._pw:
                await self._pw.stop()
        except Exception:
            pass

    @property
    def is_authenticated(self) -> bool:
        return self._auth_success

    @property
    def cookies(self) -> list[dict]:
        return self._cookies

    async def _screenshot_loop(self):
        """Capture and stream screenshots at ~2fps."""
        while self._streaming and not self._closed:
            try:
                if self._page:
                    buf = await self._page.screenshot(type="jpeg", quality=50)
                    b64 = base64.b64encode(buf).decode("utf-8")
                    if self.on_frame:
                        self.on_frame(b64)
            except Exception:
                pass
            await asyncio.sleep(0.5)

    async def _login_detection_loop(self):
        """Poll for login success signals."""
        original_url = self.login_url
        while self._streaming and not self._closed:
            try:
                if not self._page:
                    break

                current_url = self._page.url
                url_lower = current_url.lower()

                still_on_login = any(kw in url_lower for kw in _LOGIN_KEYWORDS)
                same_root = _root_domain(current_url) == _root_domain(original_url)

                if not still_on_login and same_root and current_url != original_url:
                    await self._page.wait_for_timeout(1500)
                    await self._finalize_auth("Navigated away from login page")
                    return

                cookies = await self._context.cookies() if self._context else []
                session_cookies = [c for c in cookies if any(
                    kw in c["name"].lower()
                    for kw in ["session", "token", "auth", "jwt", "sid", "ssid", "logged"]
                )]
                if len(session_cookies) >= 2 and not still_on_login:
                    await self._page.wait_for_timeout(1000)
                    await self._finalize_auth(f"Session cookies detected: {', '.join(c['name'] for c in session_cookies[:3])}")
                    return

            except Exception:
                pass
            await asyncio.sleep(2)

    async def _finalize_auth(self, message: str):
        self._auth_success = True
        if self._context:
            self._cookies = await self._context.cookies()
        if self.on_auth_complete:
            self.on_auth_complete(True, message, self._cookies)


def _ensure_xvfb():
    """Start Xvfb if not already running."""
    try:
        result = subprocess.run(
            ["pgrep", "-f", f"Xvfb {_XVFB_DISPLAY}"],
            capture_output=True, text=True,
        )
        if result.returncode != 0:
            subprocess.Popen(
                ["Xvfb", _XVFB_DISPLAY, "-screen", "0", "1280x800x24", "-ac"],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            import time
            time.sleep(0.5)
    except FileNotFoundError:
        pass

    os.environ["DISPLAY"] = _XVFB_DISPLAY


def _root_domain(url: str) -> str:
    parts = urlparse(url).netloc.split(".")
    return ".".join(parts[-2:]) if len(parts) >= 2 else urlparse(url).netloc
