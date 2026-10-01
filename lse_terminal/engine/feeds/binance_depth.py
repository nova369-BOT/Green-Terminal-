"""Binance USD/spot depth primitives.

This module contains the exchange-specific part of the L2 implementation: it
normalizes Binance depth snapshots and diff-book updates and enforces the
sequence contract before a consumer is allowed to paint a DOM. It intentionally
has no fallback to candles or quotes.
"""
from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
from typing import Iterable


class DepthSequenceError(ValueError):
    """The next diff cannot be safely applied to the current book."""


@dataclass(frozen=True)
class DepthLevel:
    price: Decimal
    quantity: Decimal


@dataclass(frozen=True)
class DepthSnapshot:
    symbol: str
    last_update_id: int
    bids: tuple[DepthLevel, ...]
    asks: tuple[DepthLevel, ...]
    event_time_ms: int | None = None


@dataclass(frozen=True)
class DepthUpdate:
    symbol: str
    first_update_id: int
    final_update_id: int
    bids: tuple[DepthLevel, ...]
    asks: tuple[DepthLevel, ...]
    event_time_ms: int | None = None


def _level(row: Iterable[str | float | int]) -> DepthLevel:
    values = list(row)
    if len(values) != 2:
        raise ValueError("depth level must contain price and quantity")
    try:
        price, quantity = Decimal(str(values[0])), Decimal(str(values[1]))
    except (InvalidOperation, ValueError) as exc:
        raise ValueError("depth level contains a non-numeric value") from exc
    if price <= 0 or quantity < 0:
        raise ValueError("depth price must be positive and quantity non-negative")
    return DepthLevel(price, quantity)


def parse_snapshot(payload: dict) -> DepthSnapshot:
    """Parse REST ``/depth`` or websocket snapshot-shaped payload."""
    symbol = str(payload.get("s") or payload.get("symbol") or "").upper()
    update_id = payload.get("lastUpdateId", payload.get("u"))
    if not symbol or not isinstance(update_id, int):
        raise ValueError("depth snapshot requires symbol and integer lastUpdateId")
    return DepthSnapshot(
        symbol=symbol,
        last_update_id=update_id,
        bids=tuple(_level(row) for row in payload.get("bids", [])),
        asks=tuple(_level(row) for row in payload.get("asks", [])),
        event_time_ms=payload.get("E"),
    )


def parse_update(payload: dict) -> DepthUpdate:
    """Parse Binance ``@depth`` diff event."""
    symbol = str(payload.get("s") or "").upper()
    first, final = payload.get("U"), payload.get("u")
    if not symbol or not isinstance(first, int) or not isinstance(final, int) or first > final:
        raise ValueError("depth update requires symbol and ordered U/u ids")
    return DepthUpdate(
        symbol=symbol,
        first_update_id=first,
        final_update_id=final,
        bids=tuple(_level(row) for row in payload.get("b", [])),
        asks=tuple(_level(row) for row in payload.get("a", [])),
        event_time_ms=payload.get("E"),
    )


class LocalOrderBook:
    """Sequence-checked local L2 book.

    The book is not ready for display until a snapshot is loaded and the first
    diff satisfies Binance's documented ``U <= lastUpdateId + 1 <= u`` rule.
    Any gap invalidates the book and requires a fresh snapshot.
    """

    def __init__(self, symbol: str):
        self.symbol = symbol.upper()
        self.last_update_id: int | None = None
        self.bids: dict[Decimal, Decimal] = {}
        self.asks: dict[Decimal, Decimal] = {}
        self.event_time_ms: int | None = None
        self.ready = False

    def apply_snapshot(self, snapshot: DepthSnapshot) -> None:
        self._check_symbol(snapshot.symbol)
        self.bids = {level.price: level.quantity for level in snapshot.bids if level.quantity > 0}
        self.asks = {level.price: level.quantity for level in snapshot.asks if level.quantity > 0}
        self.last_update_id = snapshot.last_update_id
        self.event_time_ms = snapshot.event_time_ms
        self.ready = False

    def apply_update(self, update: DepthUpdate) -> None:
        self._check_symbol(update.symbol)
        if self.last_update_id is None:
            raise DepthSequenceError("cannot apply a diff before a snapshot")
        expected = self.last_update_id + 1
        if not self.ready:
            if not (update.first_update_id <= expected <= update.final_update_id):
                raise DepthSequenceError("first diff does not bridge the snapshot")
        elif update.first_update_id != expected:
            self.ready = False
            raise DepthSequenceError("depth update gap; reload snapshot")
        self._apply_levels(self.bids, update.bids)
        self._apply_levels(self.asks, update.asks)
        self.last_update_id = update.final_update_id
        self.event_time_ms = update.event_time_ms
        self.ready = True

    def top(self, limit: int = 10) -> tuple[tuple[DepthLevel, ...], tuple[DepthLevel, ...]]:
        if not self.ready:
            return (), ()
        return (
            tuple(DepthLevel(p, q) for p, q in sorted(self.bids.items(), reverse=True)[:limit]),
            tuple(DepthLevel(p, q) for p, q in sorted(self.asks.items())[:limit]),
        )

    def _check_symbol(self, symbol: str) -> None:
        if symbol.upper() != self.symbol:
            raise ValueError(f"depth symbol mismatch: expected {self.symbol}, got {symbol}")

    @staticmethod
    def _apply_levels(book: dict[Decimal, Decimal], levels: tuple[DepthLevel, ...]) -> None:
        for level in levels:
            if level.quantity == 0:
                book.pop(level.price, None)
            else:
                book[level.price] = level.quantity
