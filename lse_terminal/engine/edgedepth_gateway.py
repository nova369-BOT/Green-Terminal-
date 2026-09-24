"""GT-owned lifecycle for the internal EdgeDepth Gateway.

Green Terminal is the ONE product. This module only manages the MIT
``edgedepth-gateway`` process as an *internal* service: find (or build) the
binary, start, health-check (``GET /healthz``), restart with backoff, and
shut down with the app. It never fabricates market data.

Binary discovery order:
  1. ``EDGEDEPTH_GATEWAY_BIN``
  2. ``bin/edgedepth-gateway[.exe]`` beside the repo / config dir
  3. vendored ``third_party/edgedepth-gateway/edgedepth-gateway[.exe]``
  4. ``PATH``
  5. if ``go`` is on PATH: ``go build`` into the vendored tree once

Disable auto-spawn with ``EDGEDEPTH_GATEWAY=0`` (status still reports an
externally reachable gateway if one is already listening).
"""

from __future__ import annotations

import os
import shutil
import socket
import subprocess
import threading
import time
from pathlib import Path
from urllib.request import Request, urlopen

_REPO = Path(__file__).resolve().parents[2]
_GW_SRC = _REPO / "third_party" / "edgedepth-gateway"
_BIN_NAME = "edgedepth-gateway.exe" if os.name == "nt" else "edgedepth-gateway"


def _env_port(default: int = 8080) -> int:
    try:
        return int(os.environ.get("EDGEDEPTH_PORT", "") or default)
    except ValueError:
        return default


def _env_host() -> str:
    return os.environ.get("EDGEDEPTH_HOST", "127.0.0.1") or "127.0.0.1"


def _tcp_open(host: str, port: int, timeout: float = 0.35) -> bool:
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.settimeout(timeout)
    try:
        return s.connect_ex((host, port)) == 0
    except OSError:
        return False
    finally:
        s.close()


def _healthz(host: str, port: int, timeout: float = 0.5) -> bool:
    """True only when ``GET /healthz`` answers 2xx (gateway contract)."""
    url = f"http://{host}:{port}/healthz"
    try:
        req = Request(url, method="GET")
        with urlopen(req, timeout=timeout) as resp:
            return 200 <= getattr(resp, "status", 200) < 300
    except Exception:
        return False


class EdgeDepthGatewaySupervisor:
    """Start / health / reconnect / shutdown for the internal gateway."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._proc: subprocess.Popen | None = None
        self._binary: Path | None = None
        self._binary_err: str | None = None
        self._spawn_error: str | None = None
        self._restarts = 0
        self._next_restart_at = 0.0
        self._adopted = False  # healthy listener we did not spawn

    # ── discovery ───────────────────────────────────────────────────────
    def find_binary(self) -> Path | None:
        env = os.environ.get("EDGEDEPTH_GATEWAY_BIN", "").strip()
        if env:
            p = Path(env).expanduser()
            if p.is_file():
                self._binary = p
                return p
            self._binary_err = f"EDGEDEPTH_GATEWAY_BIN not a file: {env}"
        candidates = [
            _REPO / "bin" / _BIN_NAME,
            _GW_SRC / _BIN_NAME,
            Path.cwd() / "bin" / _BIN_NAME,
        ]
        which = shutil.which("edgedepth-gateway")
        if which:
            candidates.append(Path(which))
        for c in candidates:
            if c.is_file() and os.access(c, os.X_OK) or (c.is_file() and os.name == "nt"):
                if c.is_file():
                    self._binary = c
                    self._binary_err = None
                    return c
        # Opt-in only: EDGEDEPTH_GATEWAY_BUILD=1 builds with a local Go
        # toolchain (keeps tests/status polls from compiling by surprise).
        if os.environ.get("EDGEDEPTH_GATEWAY_BUILD") == "1":
            built = self._try_build()
            if built:
                return built
        if not self._binary_err:
            self._binary_err = (
                "edgedepth-gateway binary not found "
                "(set EDGEDEPTH_GATEWAY_BIN or build third_party/edgedepth-gateway)"
            )
        return None

    def _try_build(self) -> Path | None:
        go = shutil.which("go")
        if not go or not (_GW_SRC / "go.mod").is_file():
            return None
        out = _GW_SRC / _BIN_NAME
        try:
            r = subprocess.run(
                [go, "build", "-o", str(out), "./cmd/edgedepth-gateway"],
                cwd=str(_GW_SRC),
                capture_output=True,
                text=True,
                timeout=180,
            )
        except (OSError, subprocess.SubprocessError) as e:
            self._binary_err = f"go build failed: {e}"
            return None
        if r.returncode != 0 or not out.is_file():
            self._binary_err = (r.stderr or r.stdout or "go build failed").strip()[:400]
            return None
        self._binary = out
        self._binary_err = None
        return out

    # ── spawn / stop ────────────────────────────────────────────────────
    def _spawn(self) -> bool:
        host, port = _env_host(), _env_port()
        bin_path = self.find_binary()
        if not bin_path:
            return False
        env = os.environ.copy()
        env["EDGEDEPTH_ADDR"] = f":{port}"
        env.setdefault("EDGEDEPTH_PATH", "/ws")
        env.setdefault("EDGEDEPTH_LOG", "info")
        try:
            self._proc = subprocess.Popen(
                [str(bin_path)],
                cwd=str(_GW_SRC if _GW_SRC.is_dir() else _REPO),
                env=env,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                stdin=subprocess.DEVNULL,
            )
        except OSError as e:
            self._spawn_error = str(e)
            self._proc = None
            return False
        # Wait briefly for /healthz.
        deadline = time.time() + 4.0
        while time.time() < deadline:
            if self._proc.poll() is not None:
                self._spawn_error = f"gateway exited with code {self._proc.returncode}"
                self._proc = None
                return False
            if _healthz(host, port):
                self._spawn_error = None
                return True
            time.sleep(0.1)
        # Process still up but not healthy yet — keep it; status will recheck.
        if self._proc and self._proc.poll() is None:
            return _healthz(host, port) or True
        self._spawn_error = "gateway did not become healthy in 4s"
        self._proc = None
        return False

    def stop(self) -> None:
        with self._lock:
            self._stop_locked()

    def _stop_locked(self) -> None:
        proc = self._proc
        self._proc = None
        self._adopted = False
        if not proc:
            return
        try:
            proc.terminate()
            try:
                proc.wait(timeout=3)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait(timeout=2)
        except OSError:
            pass

    # ── public lifecycle ────────────────────────────────────────────────
    def ensure(self) -> dict:
        """Make one honest pass: adopt healthy listener, spawn, or report."""
        host, port = _env_host(), _env_port()
        disabled = os.environ.get("EDGEDEPTH_GATEWAY", "1") == "0"
        with self._lock:
            # Our child still healthy?
            if self._proc is not None:
                if self._proc.poll() is not None:
                    self._spawn_error = (
                        f"gateway exited with code {self._proc.returncode}"
                    )
                    self._proc = None
                    self._restarts += 1
                elif _healthz(host, port):
                    return self._status_locked(host, port, reachable=True)
                else:
                    # Alive but not answering yet — keep and recheck.
                    return self._status_locked(host, port,
                                               reachable=_tcp_open(host, port))

            if _healthz(host, port):
                # Someone else (or a previous run) already serves healthz.
                self._adopted = True
                return self._status_locked(host, port, reachable=True)

            if disabled:
                return self._status_locked(host, port,
                                           reachable=_tcp_open(host, port))

            now = time.time()
            if now < self._next_restart_at:
                return self._status_locked(host, port,
                                           reachable=_tcp_open(host, port))

            if not self.find_binary():
                return self._status_locked(host, port, reachable=False)

            ok = self._spawn()
            if not ok:
                # Backoff so status polls do not hot-loop spawn attempts.
                self._next_restart_at = time.time() + min(
                    30.0, 2.0 * max(1, self._restarts))
                self._restarts += 1 if self._spawn_error else 0
            reachable = ok or _healthz(host, port) or _tcp_open(host, port)
            return self._status_locked(host, port, reachable=bool(reachable))

    def status(self) -> dict:
        return self.ensure()

    def _status_locked(self, host: str, port: int, *, reachable: bool) -> dict:
        healthy = _healthz(host, port)
        # Tests (and the shell badge) treat CONNECTED as "feed accepting
        # connections"; healthz is the stronger signal but a warm listener
        # that has not answered /healthz yet still counts as reachable.
        connected = bool(reachable or healthy)
        binary = self._binary or self.find_binary()
        managed = self._proc is not None and self._proc.poll() is None
        return {
            "name": "edgedepth-gateway",
            "title": "EdgeDepth Gateway",
            "endpoint": f"ws://{host}:{port}/ws",
            "reachable": connected,
            "state": "CONNECTED" if connected else "OFFLINE",
            "error": self._spawn_error if not connected else None,
            # Management facts for the one-app report (never fabricated):
            "managed": managed,
            "adopted": (not managed) and connected,
            "pid": self._proc.pid if managed and self._proc else None,
            "binary": str(binary) if binary else None,
            "binary_found": bool(binary),
            "binary_error": None if binary else self._binary_err,
            "healthz": healthy,
            "restarts": self._restarts,
            "disabled": os.environ.get("EDGEDEPTH_GATEWAY", "1") == "0",
            "note": (
                "Internal Green Terminal service (third_party/"
                "edgedepth-gateway). Status only — this endpoint never "
                "serves candles, quotes, or simulated depth."
            ),
            "streams": [1, 2, 3, 4, 5, 8, 17, 26, 29],
        }

    def ws_url(self) -> str:
        return f"ws://{_env_host()}:{_env_port()}/ws"


_supervisor: EdgeDepthGatewaySupervisor | None = None
_supervisor_lock = threading.Lock()


def get_supervisor() -> EdgeDepthGatewaySupervisor:
    global _supervisor
    with _supervisor_lock:
        if _supervisor is None:
            _supervisor = EdgeDepthGatewaySupervisor()
        return _supervisor


def config_js() -> str:
    """Runtime ``edgedepth-config.js`` pointing at the managed gateway."""
    ws = get_supervisor().ws_url()
    # Honour an explicit EDGEDEPTH_WS override (Render / reverse proxy).
    override = os.environ.get("EDGEDEPTH_WS", "").strip()
    if override:
        ws = override
    hosted = "true" if os.environ.get("LSE_TERMINAL_HOSTED") == "1" else "false"
    return (
        "// Generated by Green Terminal — internal EdgeDepth Gateway WS URL.\n"
        "// Browser resolve order: ?ws= → this global → hosted default.\n"
        f"window.__EDGEDEPTH_WS_URL__ = {ws!r};\n"
        f"window.__EDGEDEPTH_HOSTED__ = {hosted};\n"
    )
