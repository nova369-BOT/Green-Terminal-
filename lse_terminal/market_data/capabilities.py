"""Formal capability model for data providers.

Providers advertise only what they actually implement. Missing capabilities
must stay false/absent — never fabricate L2/L3 to look complete.
"""

from __future__ import annotations

from enum import Enum


class Capability(str, Enum):
    """What a provider can serve. Values are stable wire strings."""

    SEARCH = "SEARCH"
    OHLCV = "OHLCV"
    HISTORICAL_BARS = "HISTORICAL_BARS"
    L1_QUOTES = "L1_QUOTES"
    TRADES = "TRADES"
    WEBSOCKET = "WEBSOCKET"
    L2 = "L2"
    L3_MBO = "L3_MBO"
    OPTIONS = "OPTIONS"
    GEX = "GEX"
    REPLAY = "REPLAY"
    PRICE_BOARD = "PRICE_BOARD"
    LOGOS = "LOGOS"
    SCREENER = "SCREENER"

    @property
    def ui_label(self) -> str:
        return {
            Capability.L1_QUOTES: "L1",
            Capability.L2: "L2",
            Capability.L3_MBO: "L3/MBO",
            Capability.OHLCV: "OHLCV",
            Capability.TRADES: "Trades",
            Capability.HISTORICAL_BARS: "History",
            Capability.WEBSOCKET: "Stream",
            Capability.OPTIONS: "Options",
            Capability.GEX: "GEX",
            Capability.REPLAY: "Replay",
            Capability.PRICE_BOARD: "Board",
            Capability.LOGOS: "Logos",
            Capability.SCREENER: "Screener",
            Capability.SEARCH: "Catalog",
        }.get(self, self.value)


# Legacy short strings used by /api/providers "capabilities" (pre-Phase-3).
_LEGACY_FROM_METHOD = {
    "search": Capability.SEARCH,
    "candles": Capability.OHLCV,
    "quote": Capability.L1_QUOTES,
    "stream": Capability.WEBSOCKET,
    "prices": Capability.PRICE_BOARD,
    "logos": Capability.LOGOS,
    "screener": Capability.SCREENER,
}


def _overridden(provider, name: str) -> bool:
    from lse_terminal.contracts.provider import Provider

    impl = getattr(type(provider), name, None)
    if impl is None:
        return False
    base = getattr(Provider, name, None)
    return impl is not base


def _method_caps(provider) -> set[Capability]:
    """Infer capabilities from which methods a provider actually provides."""
    caps: set[Capability] = {Capability.SEARCH, Capability.OHLCV, Capability.HISTORICAL_BARS}
    if _overridden(provider, "quote"):
        caps.add(Capability.L1_QUOTES)
    if _overridden(provider, "stream"):
        caps.add(Capability.WEBSOCKET)
        caps.add(Capability.TRADES)
    if _overridden(provider, "prices"):
        caps.add(Capability.PRICE_BOARD)
    if _overridden(provider, "logos"):
        caps.add(Capability.LOGOS)
    if _overridden(provider, "screener"):
        caps.add(Capability.SCREENER)
    # Options chain / flow is a real LSE surface (REST, not L2 depth).
    if _overridden(provider, "option_chain") or _overridden(provider, "options_flow"):
        caps.add(Capability.OPTIONS)
    return caps


def formal_capabilities(provider) -> list[str]:
    """Sorted formal capability strings for a provider instance.

    Starts from method reflection, then merges an explicit
    ``provider.FORMAL_CAPABILITIES`` / ``provider.capabilities()`` override
    if present (still never inventing L2/L3).
    """
    caps = _method_caps(provider)

    # Explicit class attribute for capabilities that method reflection cannot
    # see (e.g. OPTIONS on a dedicated chain provider).
    explicit = getattr(provider, "FORMAL_CAPABILITIES", None)
    if explicit is not None:
        for c in explicit:
            if isinstance(c, Capability):
                caps.add(c)
            else:
                key = str(c).upper()
                try:
                    caps.add(Capability(key))
                except ValueError:
                    # Accept legacy short names from overrides.
                    mapped = _LEGACY_FROM_METHOD.get(str(c).lower())
                    if mapped:
                        caps.add(mapped)

    # Never claim depth from the base reflection path alone.
    # (If an adapter later implements real book methods it should set
    # FORMAL_CAPABILITIES including L2 explicitly after verification.)
    return sorted(c.value for c in caps)


def capability_set(provider) -> set[str]:
    return set(formal_capabilities(provider))


def has_capability(provider, cap: Capability | str) -> bool:
    if isinstance(cap, str):
        try:
            cap = Capability(cap)
        except ValueError:
            return cap in capability_set(provider)
    return cap.value in capability_set(provider)


def capability_matrix(providers: list) -> dict[str, list[str]]:
    """provider name → formal capability list (for /api/market-data/capabilities)."""
    return {getattr(p, "name", str(i)): formal_capabilities(p) for i, p in enumerate(providers)}
