"""cTrader Open API OAuth 2.0 — the "Connect cTrader" flow.

WHY OAUTH AND NOT A LOGIN BOX
-----------------------------
Green Terminal never asks a user for their cTrader password. The user is sent
to cTrader's own consent page, signs in there, picks which trading account to
share, and we receive only a revocable token. We hold no credentials that
could be used to log in as them, and they can withdraw access at any time from
their cTrader settings.

This also keeps the data licensing clean: each user authorises their OWN broker
account, so each user receives their own feed. Green Terminal is a tool acting
on their behalf - it is not redistributing one account's market data to others,
which broker and liquidity-provider agreements forbid.

THE FLOW
--------
1. /api/ctrader/connect  -> redirect user to ``auth_url()`` on cTrader
2. user approves on cTrader, browser returns to our ``redirect_uri`` with ?code=
3. /api/ctrader/callback -> ``exchange_code()`` swaps that code for tokens
4. tokens are stored locally; ``refresh()`` keeps them alive

ONE APP, MANY USERS
-------------------
The Client ID/Secret identify *Green Terminal as an application*, registered
once by the operator. End users never see them and never visit the Open API
portal. That is the whole point of OAuth.

Endpoints and parameters per the official documentation:
    https://help.ctrader.com/open-api/account-authentication/

No third-party SDK: this module uses only the standard library, so it adds no
dependency and cannot drag a Twisted event loop into the FastAPI process.
"""

from __future__ import annotations

import json
import os
import secrets
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Optional

from lse_terminal.engine import config as _config

__all__ = [
    "AUTH_URI", "TOKEN_URI", "DEMO_HOST", "LIVE_HOST", "PROTOBUF_PORT",
    "CTraderNotConfigured", "CTraderAuthError",
    "app_credentials", "is_configured", "environment", "host_for_env",
    "new_state", "auth_url", "exchange_code", "refresh",
    "load_tokens", "save_tokens", "clear_tokens", "tokens_valid",
    "status",
]

# Official endpoints (ctrader_open_api/endpoints.py, help.ctrader.com)
AUTH_URI = "https://id.ctrader.com/my/settings/openapi/grantingaccess/"
TOKEN_URI = "https://openapi.ctrader.com/apps/token"
DEMO_HOST = "demo.ctraderapi.com"
LIVE_HOST = "live.ctraderapi.com"
PROTOBUF_PORT = 5035

# Read-only by default. 'accounts' can see prices, symbols and account info but
# CANNOT place or close a trade. We only widen to 'trading' deliberately.
DEFAULT_SCOPE = "accounts"

_CONFIG_KEY = "ctrader"


class CTraderNotConfigured(RuntimeError):
    """Raised when the operator has not supplied the application credentials."""


class CTraderAuthError(RuntimeError):
    """Raised when cTrader rejects an authorisation or token request."""


# ── Application credentials (operator-level, never per-user) ────────────────

def app_credentials() -> tuple[str, str]:
    """(client_id, client_secret). Environment wins over the config file.

    Deliberately read at call time, not import time, so adding the variables in
    Render takes effect on the next request without a code change.
    """
    cfg = _config.load().get(_CONFIG_KEY) or {}
    cid = (os.environ.get("CTRADER_CLIENT_ID") or cfg.get("client_id") or "").strip()
    sec = (os.environ.get("CTRADER_CLIENT_SECRET") or cfg.get("client_secret") or "").strip()
    if not cid or not sec:
        raise CTraderNotConfigured(
            "cTrader application credentials are missing. Set CTRADER_CLIENT_ID "
            "and CTRADER_CLIENT_SECRET (see design/CTRADER_SETUP.md)."
        )
    return cid, sec


def is_configured() -> bool:
    try:
        app_credentials()
        return True
    except CTraderNotConfigured:
        return False


def environment() -> str:
    """'demo' or 'live'. Demo is the default: never point at real money by accident."""
    cfg = _config.load().get(_CONFIG_KEY) or {}
    env = (os.environ.get("CTRADER_ENV") or cfg.get("env") or "demo").strip().lower()
    return "live" if env == "live" else "demo"


def host_for_env(env: Optional[str] = None) -> str:
    return LIVE_HOST if (env or environment()) == "live" else DEMO_HOST


# ── Step 1: send the user to cTrader ────────────────────────────────────────

def new_state() -> str:
    """Unguessable CSRF token tying a callback to the request that started it."""
    return secrets.token_urlsafe(24)


def auth_url(redirect_uri: str, *, scope: str = DEFAULT_SCOPE,
             state: Optional[str] = None) -> str:
    """The cTrader consent page URL to send the user to."""
    cid, _ = app_credentials()
    if scope not in ("accounts", "trading"):
        raise ValueError("scope must be 'accounts' (read-only) or 'trading'")
    params = {
        "client_id": cid,
        "redirect_uri": redirect_uri,
        "scope": scope,
        # 'web' drops the header/footer so it reads better in a popup.
        "product": "web",
    }
    if state:
        params["state"] = state
    return AUTH_URI + "?" + urllib.parse.urlencode(params)


# ── Step 2: swap the code for tokens ────────────────────────────────────────

def _token_request(params: dict, *, timeout: float = 20.0) -> dict:
    """GET the token endpoint and return its JSON, raising on any error.

    cTrader answers 200 with an ``errorCode`` in the body for logical failures,
    so a 200 is not on its own a success - we check the payload too.
    """
    cid, sec = app_credentials()
    params = {**params, "client_id": cid, "client_secret": sec}
    url = TOKEN_URI + "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={
        "Accept": "application/json",
        "Content-Type": "application/json",
    })
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            body = resp.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "replace")[:300]
        raise CTraderAuthError(f"token endpoint returned HTTP {e.code}: {detail}") from e
    except urllib.error.URLError as e:
        raise CTraderAuthError(f"could not reach cTrader: {e.reason}") from e

    try:
        data = json.loads(body)
    except json.JSONDecodeError as e:
        raise CTraderAuthError(f"token endpoint returned non-JSON: {body[:200]}") from e

    if isinstance(data, dict) and data.get("errorCode"):
        raise CTraderAuthError(
            f"{data.get('errorCode')}: {data.get('description') or 'no description'}")
    # Some responses nest the payload one level down.
    if isinstance(data, dict) and "accessToken" not in data and isinstance(data.get("data"), dict):
        data = data["data"]
    if not isinstance(data, dict) or not data.get("accessToken"):
        raise CTraderAuthError(f"no accessToken in response: {str(data)[:200]}")
    return data


def _normalise(data: dict) -> dict:
    """cTrader's token payload -> our stored shape, with an absolute expiry."""
    expires_in = int(data.get("expiresIn") or 0)
    return {
        "access_token": data["accessToken"],
        "refresh_token": data.get("refreshToken") or "",
        "token_type": data.get("tokenType") or "bearer",
        "expires_in": expires_in,
        # Absolute, so a restart does not reset the clock.
        "expires_at": int(time.time()) + expires_in if expires_in else 0,
        "env": environment(),
        "obtained_at": int(time.time()),
    }


def exchange_code(code: str, redirect_uri: str) -> dict:
    """Authorisation code -> access/refresh tokens."""
    if not code:
        raise CTraderAuthError("no authorisation code supplied")
    return _normalise(_token_request({
        "grant_type": "authorization_code",
        "code": code,
        "redirect_uri": redirect_uri,
    }))


def refresh(refresh_token: str) -> dict:
    """Refresh token -> a fresh access token."""
    if not refresh_token:
        raise CTraderAuthError("no refresh token stored; reconnect is required")
    return _normalise(_token_request({
        "grant_type": "refresh_token",
        "refresh_token": refresh_token,
    }))


# ── Token storage ───────────────────────────────────────────────────────────
# Stored in the same 0600 config file as the LSE key. Tokens are secrets: they
# are never logged, never returned by the status route, and never committed.

def load_tokens() -> dict:
    return (_config.load().get(_CONFIG_KEY) or {}).get("tokens") or {}


def save_tokens(tokens: dict) -> None:
    cfg = _config.load()
    section = dict(cfg.get(_CONFIG_KEY) or {})
    section["tokens"] = tokens
    cfg[_CONFIG_KEY] = section
    _config.save(cfg)


def clear_tokens() -> None:
    cfg = _config.load()
    section = dict(cfg.get(_CONFIG_KEY) or {})
    section.pop("tokens", None)
    section.pop("accounts", None)
    cfg[_CONFIG_KEY] = section
    _config.save(cfg)


def tokens_valid(tokens: Optional[dict] = None, *, skew: int = 60) -> bool:
    """True when we hold an access token that has not (nearly) expired."""
    t = load_tokens() if tokens is None else tokens
    if not t or not t.get("access_token"):
        return False
    exp = int(t.get("expires_at") or 0)
    return True if exp == 0 else (time.time() + skew) < exp


def access_token() -> str:
    """A usable access token, refreshing transparently when it has expired."""
    t = load_tokens()
    if not t:
        raise CTraderAuthError("not connected to cTrader; press Connect cTrader")
    if tokens_valid(t):
        return t["access_token"]
    fresh = refresh(t.get("refresh_token", ""))
    # Keep the old refresh token if the response omitted a new one.
    if not fresh.get("refresh_token"):
        fresh["refresh_token"] = t.get("refresh_token", "")
    save_tokens(fresh)
    return fresh["access_token"]


# ── Honest status for the UI ────────────────────────────────────────────────

def status() -> dict:
    """What is actually true right now. Never claims connected when it is not,
    and never leaks a token or secret."""
    configured = is_configured()
    t = load_tokens()
    cfg = _config.load().get(_CONFIG_KEY) or {}
    return {
        "configured": configured,
        "connected": bool(t) and tokens_valid(t),
        "has_tokens": bool(t),
        "expired": bool(t) and not tokens_valid(t),
        "env": environment(),
        "host": host_for_env(),
        "port": PROTOBUF_PORT,
        "scope": cfg.get("scope") or DEFAULT_SCOPE,
        "accounts": cfg.get("accounts") or [],
        "expires_at": int(t.get("expires_at") or 0) if t else 0,
        "detail": (
            "" if configured else
            "Set CTRADER_CLIENT_ID and CTRADER_CLIENT_SECRET to enable cTrader."
        ),
    }
