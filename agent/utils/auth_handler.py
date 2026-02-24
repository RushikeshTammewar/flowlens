"""Headful browser authentication handler.

When a login screen is detected during scanning, launches a VISIBLE
browser window so the user can log in manually -- handling OTP, 2FA,
CAPTCHA, SSO, OAuth, magic links, or anything else the site requires.

Once login succeeds, captures the authenticated cookies, injects them
into the headless scanning session, and continues. Credentials never
touch FlowLens -- the user types directly into the real browser.
"""

from __future__ import annotations

import asyncio
import sys
from dataclasses import dataclass, field
from urllib.parse import urlparse

from playwright.async_api import Page, BrowserContext, Playwright


@dataclass
class AuthResult:
    """Result of an authentication attempt."""
    success: bool
    method: str  # "headful", "skipped", "cached_cookies"
    message: str = ""
    url_after: str = ""
    cookies_injected: int = 0


_LOGIN_DETECT_JS = """() => {
    const url = window.location.href.toLowerCase();
    const bodyText = (document.body?.innerText || '').toLowerCase().substring(0, 3000);

    const urlSignals = ['login', 'signin', 'sign-in', 'sign_in', 'auth', 'account/login',
                        'sso', 'oauth', 'authenticate', 'identifier'];
    const hasUrlSignal = urlSignals.some(s => url.includes(s));

    const contentSignals = ['log in', 'sign in', 'login', 'signin',
                            'enter your password', 'enter your email',
                            'username', 'forgot password', 'remember me',
                            'don\\'t have an account', 'create account',
                            'continue with google', 'continue with email'];
    const hasContentSignal = contentSignals.some(s => bodyText.includes(s));

    const hasPasswordField = document.querySelectorAll('input[type="password"]').length > 0;
    const hasEmailField = document.querySelectorAll(
        'input[type="email"], input[name*="email"], input[name*="user"], ' +
        'input[autocomplete="email"], input[autocomplete="username"], ' +
        'input[name*="identifier"], input[name*="login"]'
    ).length > 0;

    const buttons = document.querySelectorAll('button, input[type="submit"], [role="button"]');
    let hasLoginButton = false;
    for (const btn of buttons) {
        const text = (btn.textContent || btn.value || btn.getAttribute('aria-label') || '').toLowerCase();
        if (['log in', 'sign in', 'login', 'signin', 'submit', 'continue', 'next'].some(kw => text.includes(kw))) {
            hasLoginButton = true;
            break;
        }
    }

    let score = 0;
    if (hasUrlSignal) score += 3;
    if (hasPasswordField) score += 4;
    if (hasEmailField) score += 2;
    if (hasLoginButton) score += 2;
    if (hasContentSignal) score += 1;

    return {
        isLoginPage: score >= 5,
        score,
        hasPasswordField,
        hasEmailField,
        url: window.location.href,
        title: document.title || '',
    };
}"""

_LOGIN_KEYWORDS = {"login", "signin", "sign-in", "sign_in", "auth", "authenticate",
                   "identifier", "sso", "oauth", "servicelog"}


class AuthHandler:
    """Manages authentication via headful browser or remote browser session."""

    def __init__(
        self,
        playwright_instance: Playwright | None = None,
        headless_context: BrowserContext | None = None,
        on_progress: callable | None = None,
        auth_cookie_event: asyncio.Event | None = None,
        auth_cookie_store: dict | None = None,
        scan_id: str | None = None,
    ):
        self._pw = playwright_instance
        self._headless_ctx = headless_context
        self._auth_attempted: set[str] = set()
        self._cached_cookies: list[dict] | None = None
        self._on_progress = on_progress or (lambda *_: None)
        self._cookie_event = auth_cookie_event
        self._cookie_store = auth_cookie_store or {}
        self._scan_id = scan_id

    def set_playwright(self, pw: Playwright, ctx: BrowserContext):
        self._pw = pw
        self._headless_ctx = ctx

    async def check_and_handle_login(self, page: Page) -> AuthResult | None:
        """Check if current page is a login screen. If so, handle via headful browser.

        Returns AuthResult if login was detected and handled, None otherwise.
        """
        try:
            login_info = await page.evaluate(_LOGIN_DETECT_JS)
        except Exception:
            return None

        if not login_info.get("isLoginPage"):
            return None

        page_url = login_info.get("url", page.url)
        domain = _extract_domain(page_url)

        if domain in self._auth_attempted:
            return AuthResult(
                success=False,
                method="skipped",
                message=f"Already attempted login on {domain}",
                url_after=page.url,
            )

        self._auth_attempted.add(domain)

        # If we have cached cookies from a previous login on this domain, inject them
        if self._cached_cookies:
            return await self._inject_cached_cookies(page)

        # Server mode: no local display -- use remote browser via web UI
        if not self._pw:
            self._on_progress("auth_required", {
                "url": page_url,
                "title": login_info.get("title", ""),
                "message": "Login detected. Please log in via the browser window.",
            })

            # Wait briefly for cookies from remote browser (started by web UI)
            # Use a short timeout so the scan doesn't hang if nobody is watching
            if self._cookie_event:
                try:
                    await asyncio.wait_for(self._cookie_event.wait(), timeout=60)
                    cookies = self._cookie_store.get(self._scan_id, [])
                    if cookies and self._headless_ctx:
                        await self._headless_ctx.add_cookies(cookies)
                        self._cached_cookies = cookies
                        try:
                            await page.reload(wait_until="domcontentloaded", timeout=15000)
                            await page.wait_for_timeout(2000)
                        except Exception:
                            pass
                        return AuthResult(
                            success=True,
                            method="remote_browser",
                            message=f"Login via remote browser. {len(cookies)} cookies injected.",
                            url_after=page.url,
                            cookies_injected=len(cookies),
                        )
                except asyncio.TimeoutError:
                    self._on_progress("auth_timeout", {
                        "url": page_url,
                        "message": "Login timeout. Continuing scan without auth.",
                    })

            return AuthResult(
                success=False,
                method="skipped",
                message=f"Login page detected. Continuing without auth — auth-gated flows may fail.",
                url_after=page.url,
            )

        return await self._headful_login(page, page_url)

    async def _headful_login(self, headless_page: Page, login_url: str) -> AuthResult:
        """Launch a visible browser, let the user log in, capture cookies."""

        self._on_progress("auth_required", {
            "url": login_url,
            "message": "Opening browser window for login...",
        })

        headful_browser = None
        try:
            headful_browser = await self._pw.chromium.launch(
                headless=False,
                args=["--start-maximized"],
            )
            context = await headful_browser.new_context(
                viewport={"width": 1280, "height": 900},
                user_agent="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            )
            page = await context.new_page()
            await page.goto(login_url, wait_until="domcontentloaded", timeout=30000)

            # Print instructions to CLI
            _print_login_instructions(login_url)

            # Poll for login completion
            success, final_url, message = await self._wait_for_login(page, login_url)

            if success:
                # Extract cookies from the headful browser
                cookies = await context.cookies()
                self._cached_cookies = cookies

                # Inject cookies into the headless scanning context
                injected = 0
                if self._headless_ctx:
                    await self._headless_ctx.add_cookies(cookies)
                    injected = len(cookies)

                # Navigate the headless page to the post-login URL
                try:
                    await headless_page.goto(final_url, wait_until="domcontentloaded", timeout=20000)
                    await headless_page.wait_for_timeout(2000)
                except Exception:
                    pass

                return AuthResult(
                    success=True,
                    method="headful",
                    message=f"Login successful. {injected} cookies injected. Redirected to {_short_url(final_url)}",
                    url_after=final_url,
                    cookies_injected=injected,
                )
            else:
                return AuthResult(
                    success=False,
                    method="headful",
                    message=message or "Login was not completed",
                    url_after=page.url,
                )

        except Exception as e:
            return AuthResult(
                success=False,
                method="headful",
                message=f"Headful login error: {str(e)[:200]}",
                url_after=headless_page.url,
            )
        finally:
            if headful_browser:
                try:
                    await headful_browser.close()
                except Exception:
                    pass

    async def _wait_for_login(
        self, page: Page, original_login_url: str, timeout_seconds: int = 300,
    ) -> tuple[bool, str, str]:
        """Poll the headful browser page until login succeeds or times out.

        Detection signals:
        1. URL no longer contains login keywords
        2. Session cookies appeared
        3. User closed the browser / pressed Enter in CLI

        Returns (success, final_url, message).
        """
        original_domain = _extract_domain(original_login_url)
        enter_pressed = asyncio.Event()

        # Listen for Enter key in CLI (in a background thread)
        async def _listen_for_enter():
            def _sync():
                try:
                    input()
                except (EOFError, KeyboardInterrupt):
                    pass
                enter_pressed.set()
            await asyncio.to_thread(_sync)

        enter_task = asyncio.create_task(_listen_for_enter())

        try:
            elapsed = 0
            poll_interval = 2
            while elapsed < timeout_seconds:
                # Check if user pressed Enter
                if enter_pressed.is_set():
                    final_url = page.url
                    return True, final_url, "User confirmed login complete"

                # Check if browser page is still open
                try:
                    current_url = page.url
                except Exception:
                    return False, "", "Browser window was closed"

                # Signal 1: URL left the login page
                url_lower = current_url.lower()
                still_on_login = any(kw in url_lower for kw in _LOGIN_KEYWORDS)
                same_domain = _extract_domain(current_url) == original_domain or _root_domain(current_url) == _root_domain(original_login_url)

                if not still_on_login and same_domain:
                    await page.wait_for_timeout(1500)
                    return True, page.url, f"Navigated away from login to {_short_url(page.url)}"

                # Signal 2: Session cookies appeared
                try:
                    cookies = await page.context.cookies()
                    session_cookies = [c for c in cookies if any(
                        kw in c["name"].lower()
                        for kw in ["session", "token", "auth", "jwt", "sid", "ssid", "logged"]
                    )]
                    if len(session_cookies) >= 2:
                        await page.wait_for_timeout(1000)
                        return True, page.url, f"Session cookies detected: {', '.join(c['name'] for c in session_cookies[:3])}"
                except Exception:
                    pass

                await asyncio.sleep(poll_interval)
                elapsed += poll_interval

            return False, page.url, f"Login timed out after {timeout_seconds}s"

        finally:
            enter_task.cancel()
            try:
                await enter_task
            except (asyncio.CancelledError, Exception):
                pass

    async def _inject_cached_cookies(self, page: Page) -> AuthResult:
        """Re-use cookies from a previous headful login."""
        if not self._cached_cookies or not self._headless_ctx:
            return AuthResult(success=False, method="cached_cookies", message="No cached cookies")

        try:
            await self._headless_ctx.add_cookies(self._cached_cookies)
            await page.reload(wait_until="domcontentloaded", timeout=15000)
            await page.wait_for_timeout(2000)
            return AuthResult(
                success=True,
                method="cached_cookies",
                message=f"Re-injected {len(self._cached_cookies)} cached cookies",
                url_after=page.url,
                cookies_injected=len(self._cached_cookies),
            )
        except Exception as e:
            return AuthResult(success=False, method="cached_cookies", message=str(e)[:200])


def _print_login_instructions(url: str):
    """Print clear instructions to the CLI."""
    print()
    print(f"  {'='*62}")
    print(f"  LOGIN REQUIRED")
    print(f"  {'='*62}")
    print(f"  A browser window has opened at:")
    print(f"  {_short_url(url, 58)}")
    print()
    print(f"  Please log in manually. FlowLens will detect when")
    print(f"  you're done and continue scanning automatically.")
    print()
    print(f"  Handles: passwords, OTP, 2FA, CAPTCHA, SSO -- anything.")
    print()
    print(f"  Or press ENTER here when you're logged in.")
    print(f"  {'='*62}")
    print()


def _extract_domain(url: str) -> str:
    return urlparse(url).netloc


def _root_domain(url: str) -> str:
    parts = urlparse(url).netloc.split(".")
    return ".".join(parts[-2:]) if len(parts) >= 2 else urlparse(url).netloc


def _short_url(url: str, max_len: int = 80) -> str:
    if len(url) <= max_len:
        return url
    return url[:max_len - 3] + "..."
