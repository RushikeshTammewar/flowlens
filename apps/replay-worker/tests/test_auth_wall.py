"""Auth-wall detection unit tests."""
from __future__ import annotations

from typing import Any

import pytest

from app.auth_wall import detect_auth_wall


class _FakeSession:
    def __init__(self, url: str = "https://example.com/", has_password: bool = False) -> None:
        self._url = url
        self._has_password = has_password

    async def get_current_page_url(self) -> str:
        return self._url

    async def evaluate(self, _js: str) -> Any:
        return self._has_password


@pytest.mark.asyncio
async def test_401_marks_auth_wall() -> None:
    session = _FakeSession(url="https://example.com/")
    is_wall, hint = await detect_auth_wall(session, last_status_code=401)
    assert is_wall
    assert hint and "401" in hint


@pytest.mark.asyncio
async def test_login_url_marks_auth_wall() -> None:
    session = _FakeSession(url="https://example.com/login?next=/dashboard")
    is_wall, hint = await detect_auth_wall(session, last_status_code=None)
    assert is_wall
    assert hint and "login" in hint


@pytest.mark.asyncio
async def test_password_input_marks_auth_wall() -> None:
    # URL must NOT match the auth-URL regex, otherwise the URL branch wins
    # (early-out on first positive signal). `/profile` is non-auth so the
    # password-input branch is exercised.
    session = _FakeSession(url="https://example.com/profile", has_password=True)
    is_wall, hint = await detect_auth_wall(session, last_status_code=None)
    assert is_wall
    assert hint and "password" in hint


@pytest.mark.asyncio
async def test_clean_page_no_auth_wall() -> None:
    session = _FakeSession(url="https://example.com/dashboard")
    is_wall, _ = await detect_auth_wall(session, last_status_code=200)
    assert not is_wall
