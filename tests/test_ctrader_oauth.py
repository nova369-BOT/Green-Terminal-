"""Tests for the cTrader OAuth flow.

No network: the token endpoint is stubbed. These assert the things that break
silently in OAuth integrations - wrong endpoint, missing parameter, a 200 that
actually carries an error, tokens leaking into status output, and expiry maths.

Every test points the config at a temp dir so a developer's real tokens are
never read or overwritten by the suite.
"""

import json
import os
import tempfile
import time

from lse_terminal.engine.ctrader import oauth


def _isolate():
    """Point config at a throwaway dir and clear the credential env vars."""
    d = tempfile.mkdtemp(prefix="ctrader-test-")
    os.environ["LSE_TERMINAL_CONFIG_DIR"] = d
    for k in ("CTRADER_CLIENT_ID", "CTRADER_CLIENT_SECRET", "CTRADER_ENV"):
        os.environ.pop(k, None)
    return d


def _configure(env="demo"):
    os.environ["CTRADER_CLIENT_ID"] = "test-client-id"
    os.environ["CTRADER_CLIENT_SECRET"] = "test-client-secret"
    os.environ["CTRADER_ENV"] = env


def test_not_configured_is_reported_honestly_not_crashed():
    _isolate()
    assert oauth.is_configured() is False
    s = oauth.status()
    assert s["configured"] is False
    assert s["connected"] is False
    assert "CTRADER_CLIENT_ID" in s["detail"]


def test_auth_url_has_every_required_parameter():
    _isolate(); _configure()
    state = oauth.new_state()
    url = oauth.auth_url("https://example.com/cb", state=state)
    assert url.startswith(oauth.AUTH_URI)
    for part in ("client_id=test-client-id", "scope=accounts",
                 "product=web", f"state={state}"):
        assert part in url, f"missing {part}"
    assert "redirect_uri=https%3A%2F%2Fexample.com%2Fcb" in url
    # the secret must never appear in a URL the user's browser will visit
    assert "test-client-secret" not in url


def test_default_scope_is_read_only():
    _isolate(); _configure()
    assert oauth.DEFAULT_SCOPE == "accounts"
    assert "scope=accounts" in oauth.auth_url("https://e.com/cb")
    assert "scope=trading" in oauth.auth_url("https://e.com/cb", scope="trading")
    try:
        oauth.auth_url("https://e.com/cb", scope="everything")
    except ValueError:
        pass
    else:
        raise AssertionError("an unknown scope must be rejected")


def test_state_tokens_are_unguessable_and_unique():
    a, b = oauth.new_state(), oauth.new_state()
    assert a != b
    assert len(a) >= 20


def test_demo_is_the_default_environment():
    _isolate(); _configure()
    os.environ.pop("CTRADER_ENV", None)
    assert oauth.environment() == "demo"
    assert oauth.host_for_env() == oauth.DEMO_HOST
    os.environ["CTRADER_ENV"] = "live"
    assert oauth.environment() == "live"
    assert oauth.host_for_env() == oauth.LIVE_HOST
    # anything unrecognised must fall back to demo, never to live money
    os.environ["CTRADER_ENV"] = "production?"
    assert oauth.environment() == "demo"


def test_exchange_code_normalises_the_payload(monkeypatch=None):
    _isolate(); _configure()
    captured = {}

    def fake(params, timeout=20.0):
        captured.update(params)
        return {"accessToken": "AT", "refreshToken": "RT",
                "tokenType": "bearer", "expiresIn": 2628000}

    oauth._token_request = fake
    tok = oauth.exchange_code("the-code", "https://example.com/cb")

    assert captured["grant_type"] == "authorization_code"
    assert captured["code"] == "the-code"
    assert captured["redirect_uri"] == "https://example.com/cb"
    assert tok["access_token"] == "AT"
    assert tok["refresh_token"] == "RT"
    assert tok["expires_at"] > time.time(), "expiry must be absolute, not relative"


def test_a_200_carrying_an_errorCode_is_treated_as_failure():
    _isolate(); _configure()
    import urllib.request

    class FakeResp:
        def read(self): return json.dumps(
            {"errorCode": "INVALID_REQUEST", "description": "bad code"}).encode()
        def __enter__(self): return self
        def __exit__(self, *a): return False

    orig = urllib.request.urlopen
    urllib.request.urlopen = lambda *a, **k: FakeResp()
    try:
        oauth._token_request({"grant_type": "authorization_code"})
    except oauth.CTraderAuthError as e:
        assert "INVALID_REQUEST" in str(e)
    else:
        raise AssertionError("an errorCode body must raise even on HTTP 200")
    finally:
        urllib.request.urlopen = orig


def test_tokens_round_trip_and_clear():
    _isolate(); _configure()
    assert oauth.load_tokens() == {}
    oauth.save_tokens({"access_token": "AT", "refresh_token": "RT",
                       "expires_at": int(time.time()) + 999})
    assert oauth.load_tokens()["access_token"] == "AT"
    assert oauth.tokens_valid() is True
    oauth.clear_tokens()
    assert oauth.load_tokens() == {}
    assert oauth.tokens_valid() is False


def test_expired_tokens_are_not_reported_as_connected():
    _isolate(); _configure()
    oauth.save_tokens({"access_token": "AT", "refresh_token": "RT",
                       "expires_at": int(time.time()) - 10})
    s = oauth.status()
    assert s["has_tokens"] is True
    assert s["expired"] is True
    assert s["connected"] is False, "an expired token must never read as connected"


def test_status_never_leaks_secrets():
    _isolate(); _configure()
    oauth.save_tokens({"access_token": "SUPER-SECRET-TOKEN",
                       "refresh_token": "SECRET-REFRESH",
                       "expires_at": int(time.time()) + 999})
    blob = json.dumps(oauth.status())
    assert "SUPER-SECRET-TOKEN" not in blob
    assert "SECRET-REFRESH" not in blob
    assert "test-client-secret" not in blob


def test_access_token_refreshes_when_expired():
    _isolate(); _configure()
    oauth.save_tokens({"access_token": "OLD", "refresh_token": "RT",
                       "expires_at": int(time.time()) - 5})
    oauth._token_request = lambda params, timeout=20.0: {
        "accessToken": "NEW", "expiresIn": 1000}
    assert oauth.access_token() == "NEW"
    stored = oauth.load_tokens()
    assert stored["access_token"] == "NEW"
    # the old refresh token must be kept when the response omits a new one
    assert stored["refresh_token"] == "RT"


def test_sandbox_token_from_env_is_used_and_labelled():
    """Playground path: develop before the app is approved."""
    _isolate(); _configure()
    os.environ["CTRADER_ACCESS_TOKEN"] = "playground-token-43-chars"
    os.environ["CTRADER_ACCOUNT_ID"] = "123456"
    try:
        t = oauth.load_tokens()
        assert t["access_token"] == "playground-token-43-chars"
        assert t["source"] == "sandbox"
        assert oauth.tokens_valid(t) is True, "no expiry means usable, not expired"

        s = oauth.status()
        assert s["connected"] is True
        assert s["token_source"] == "sandbox"
        assert s["account_id"] == 123456
        assert "Playground" in s["detail"], "the UI must say this is a dev token"
        assert "playground-token-43-chars" not in json.dumps(s)
    finally:
        os.environ.pop("CTRADER_ACCESS_TOKEN", None)
        os.environ.pop("CTRADER_ACCOUNT_ID", None)


def test_sandbox_token_overrides_stored_oauth_tokens():
    _isolate(); _configure()
    oauth.save_tokens({"access_token": "STORED", "refresh_token": "R",
                       "expires_at": int(time.time()) + 999})
    assert oauth.load_tokens()["access_token"] == "STORED"
    os.environ["CTRADER_ACCESS_TOKEN"] = "ENVTOKEN"
    try:
        assert oauth.load_tokens()["access_token"] == "ENVTOKEN"
        assert oauth.status()["token_source"] == "sandbox"
    finally:
        os.environ.pop("CTRADER_ACCESS_TOKEN", None)
    # removing it falls straight back to the stored per-user token
    assert oauth.load_tokens()["access_token"] == "STORED"
    assert oauth.status()["token_source"] == "oauth"


def test_account_id_defaults_to_zero_meaning_discover():
    _isolate(); _configure()
    assert oauth.account_id() == 0
    os.environ["CTRADER_ACCOUNT_ID"] = "not-a-number"
    try:
        assert oauth.account_id() == 0, "garbage must not crash the status route"
    finally:
        os.environ.pop("CTRADER_ACCOUNT_ID", None)
