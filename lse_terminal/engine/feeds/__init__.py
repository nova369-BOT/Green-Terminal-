"""Pluggable market-data feeds that can drive the footprint engine.

Every feed emits ``footprint.FootprintTick``, so the engine and the chart do
not care where the data came from:

    binance  — public crypto trades, no credentials, REAL aggressor side
    ctrader  — FX/indices/metals via a user's broker, side inferred (tick rule)

Adding a venue means writing one adapter, not touching the engine.
"""
