"""Bearer-token auth tests."""
from __future__ import annotations

import pytest
from fastapi import HTTPException

from app.security import require_bearer


def test_missing_header_rejects() -> None:
    with pytest.raises(HTTPException) as exc:
        require_bearer(None)
    assert exc.value.status_code == 401


def test_wrong_scheme_rejects() -> None:
    with pytest.raises(HTTPException) as exc:
        require_bearer("Basic abcdef")
    assert exc.value.status_code == 401


def test_wrong_token_rejects() -> None:
    with pytest.raises(HTTPException) as exc:
        require_bearer("Bearer not-the-right-secret")
    assert exc.value.status_code == 401


def test_correct_token_accepted() -> None:
    # No exception means it accepted.
    require_bearer("Bearer test-secret-32-chars-aaaaaaaaaaaa")
