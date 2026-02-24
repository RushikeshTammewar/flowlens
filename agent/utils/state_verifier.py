"""Deep browser state verification after each flow step.

Checks cookies, localStorage, sessionStorage, console errors,
and network requests to detect silent failures that aren't
visible in the UI.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from playwright.async_api import Page


@dataclass
class StateSnapshot:
    """Browser state at a point in time."""
    url: str = ""
    cookies: list[dict] = field(default_factory=list)
    local_storage: dict[str, str] = field(default_factory=dict)
    session_storage: dict[str, str] = field(default_factory=dict)
    console_errors: list[str] = field(default_factory=list)
    network_errors: list[dict] = field(default_factory=list)
    dom_hash: str = ""


@dataclass
class StateChange:
    """What changed between two state snapshots."""
    cookies_added: list[str] = field(default_factory=list)
    cookies_removed: list[str] = field(default_factory=list)
    storage_changes: dict[str, str] = field(default_factory=dict)
    new_console_errors: list[str] = field(default_factory=list)
    new_network_errors: list[dict] = field(default_factory=list)
    url_changed: bool = False
    dom_changed: bool = False

    @property
    def has_errors(self) -> bool:
        return bool(self.new_console_errors) or bool(self.new_network_errors)

    def summary(self) -> str:
        parts = []
        if self.url_changed:
            parts.append("URL changed")
        if self.cookies_added:
            parts.append(f"Cookies set: {', '.join(self.cookies_added[:3])}")
        if self.new_console_errors:
            parts.append(f"{len(self.new_console_errors)} new JS error(s)")
        if self.new_network_errors:
            parts.append(f"{len(self.new_network_errors)} failed request(s)")
        if self.dom_changed:
            parts.append("DOM changed")
        return "; ".join(parts) if parts else "No state changes"


class StateVerifier:
    """Tracks and compares browser state across flow steps."""

    def __init__(self):
        self._console_errors: list[str] = []
        self._network_errors: list[dict] = []
        self._listeners_attached = False

    def attach_listeners(self, page: Page):
        """Attach event listeners to track console errors and network failures."""
        if self._listeners_attached:
            return

        def on_console(msg):
            if msg.type == "error":
                self._console_errors.append(msg.text[:300])

        def on_page_error(error):
            self._console_errors.append(f"Uncaught: {str(error)[:300]}")

        def on_response(response):
            if response.status >= 400:
                self._network_errors.append({
                    "url": response.url[:200],
                    "status": response.status,
                    "method": response.request.method,
                })

        page.on("console", on_console)
        page.on("pageerror", on_page_error)
        page.on("response", on_response)
        self._listeners_attached = True

    async def take_snapshot(self, page: Page) -> StateSnapshot:
        """Capture current browser state."""
        snapshot = StateSnapshot(url=page.url)

        try:
            cookies = await page.context.cookies()
            snapshot.cookies = [{"name": c["name"], "domain": c.get("domain", "")} for c in cookies]
        except Exception:
            pass

        try:
            snapshot.local_storage = await page.evaluate("""() => {
                const data = {};
                for (let i = 0; i < localStorage.length; i++) {
                    const key = localStorage.key(i);
                    data[key] = (localStorage.getItem(key) || '').substring(0, 100);
                }
                return data;
            }""")
        except Exception:
            pass

        try:
            snapshot.session_storage = await page.evaluate("""() => {
                const data = {};
                for (let i = 0; i < sessionStorage.length; i++) {
                    const key = sessionStorage.key(i);
                    data[key] = (sessionStorage.getItem(key) || '').substring(0, 100);
                }
                return data;
            }""")
        except Exception:
            pass

        try:
            snapshot.dom_hash = await page.evaluate("""() => {
                const el = document.body;
                if (!el) return '';
                const text = el.innerHTML.substring(0, 5000);
                let hash = 0;
                for (let i = 0; i < text.length; i++) {
                    const c = text.charCodeAt(i);
                    hash = ((hash << 5) - hash) + c;
                    hash |= 0;
                }
                return hash.toString();
            }""")
        except Exception:
            pass

        snapshot.console_errors = list(self._console_errors)
        snapshot.network_errors = list(self._network_errors)

        return snapshot

    def compare(self, before: StateSnapshot, after: StateSnapshot) -> StateChange:
        """Compare two state snapshots and return what changed."""
        change = StateChange()

        change.url_changed = before.url != after.url

        before_cookies = {c["name"] for c in before.cookies}
        after_cookies = {c["name"] for c in after.cookies}
        change.cookies_added = list(after_cookies - before_cookies)
        change.cookies_removed = list(before_cookies - after_cookies)

        for key in set(after.local_storage) - set(before.local_storage):
            change.storage_changes[key] = after.local_storage[key]

        before_errors = set(before.console_errors)
        change.new_console_errors = [e for e in after.console_errors if e not in before_errors]

        before_net = {(e["url"], e["status"]) for e in before.network_errors}
        change.new_network_errors = [
            e for e in after.network_errors
            if (e["url"], e["status"]) not in before_net
        ]

        change.dom_changed = before.dom_hash != after.dom_hash

        return change

    def reset(self):
        """Reset accumulated errors."""
        self._console_errors.clear()
        self._network_errors.clear()
