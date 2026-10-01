# Green Terminal — Native Order-Flow Workspace Specification

Status: authoritative implementation direction, captured from the supplied XFlow/G-Flow references.

## Product rule

Green Terminal is one product. There is no standalone G-Flow page, header, iframe, or second tool rail in the finished experience. Order flow is a native chart/workspace capability that uses the existing chart canvas, chart tools, theme, symbol bus, and workspace widgets.

## Existing chart capabilities to preserve

These are already native Chart features and must not be replaced or duplicated:

- Candles
- Heikin Ashi
- Line
- Renko
- OHLC/bars and other existing chart styles
- Existing timeframe selector
- Existing drawing toolbar and drawing edit tools
- Indicators browser and native indicator panes
- Chart settings, templates, layouts, navigation, crosshair, and zoom

The order-flow work must extend these systems. It must not create a second copy of them.

## Upper chart toolbar

The upper toolbar remains the main control surface:

```text
Timeframe | Real-time | Chart View | Layers | + Widget | Draw | Indicators | Settings
```

### Chart View menu

Keep the existing PRICE group:

```text
PRICE
  Candles
  Heikin Ashi
  Line
  Renko
  Settings
```

Add the ORDER FLOW group:

```text
ORDER FLOW
  Footprint cluster       Settings
  Footprint profile       Settings
  Flow & Positioning
  TPO market profile      Settings
```

An order-flow view is not a fake replacement for the price chart. It is a chart presentation/layer that can retain the price candles when appropriate, as demonstrated by the supplied reference.

## Layers menu

The Layers menu is a first-class native chart menu with live enabled counts.

```text
LAYERS · N ON

PRICE
  Price levels

LIQUIDATIONS
  Liquidation heatmap
  Heatmap source
  Hyperliquid liquidation levels
  Liquidation profile
  Hyperliquid history
  Observed liquidations

MARKET STRUCTURE
  Order book depth
  Depth settings...
  Trade bubbles (large prints)
  Bubble settings
  Volume profile (VPVR)

LIQUIDATION LEVERAGE
  25×   50×   75×   100×
```

Every checkbox represents a real layer. Unsupported data must render a clear unavailable state, not an empty fake layer.

## Real-time menu

The Real-time control is a settings popover for the live chart layer:

```text
REAL-TIME SETTINGS
  Pause display
  1s observed candles
  Trade-price line
  Auto-fit visible history
  Follow price
  Recent 30 seconds
  Trade bubbles
  Observed liquidation diamonds
  Liquidation activity strip
  Liquidation focus
    Minimum liquidation notional
  Depth brightness
  Wider rows keep their totals on the DOM
  Extend current depth
  Auto market size
  Recalibrate bubble sizes
  Session history
```

The menu must expose data quality and retention information, including:

- Live/paused state
- Whether observed history exists
- Recording start time
- Retained duration/size
- Whether recent history is unavailable
- Whether liquidation reports are waiting

## Native widgets

The `+ Widget` menu creates workspace widgets. Widgets are independent but can be linked to the chart symbol/timeframe.

```text
ADD WIDGET
  Chart
  Orderbook
  Depth of market (DOM)
  Trades
  Market statistics
  Footprint
  Heatmap
  Volume profile
  CVD / Delta
  Paper trading
  Watchlist
  Replay library
```

Widget behavior:

- Add/remove
- Drag/reorder
- Resize
- Collapse/maximize
- Persist in workspace
- Link/unlink symbol
- Link/unlink timeframe
- Show provider/source and feed status
- Respect capability/availability state

Default BTC workspace target:

```text
+-------------------------------+------------------+
| Chart / Footprint / Heatmap   | DOM · BTC         |
| BTC/USD                       | bids/price/asks  |
+-------------------------------+------------------+
| Volume + CVD                  | Trades · BTC     |
|                               | price/qty/time   |
+-------------------------------+------------------+
```

## Main chart visual behavior

The supplied reference shows the following visual layers working together:

- Price candles
- Footprint cells at traded prices
- Bid/ask or buy/sell values in each cell
- Delta values
- Large trade bubbles
- Depth/liquidity bands
- Volume pane
- CVD pane
- POC/value-area/profile information
- DOM and Trades widgets beside the chart
- Existing left-side drawing tools

Labels such as `Live observed (partial)`, `reconciled after minute close`, `HL: no recorded snapshots`, and `reported liquidations: waiting for reports` are important. They explain exactly what the feed can and cannot prove.

## Instrument and source resolution

The chart instrument and order-flow source are independent, but the underlying must match.

```text
BTC/USD chart from LSE/MT5
  -> Binance BTCUSDT or Hyperliquid BTC order-flow, if catalog confirms it

EUR/USD chart from LSE/MT5
  -> Binance/Hyperliquid EUR contract, if the live catalog confirms it
  -> otherwise no order-flow data

XAU/USD chart
  -> Binance XAUUSDT or Hyperliquid HIP-3 gold contract, if confirmed
  -> otherwise no order-flow data
```

The UI must display the actual source contract, for example:

```text
ORDER FLOW SOURCE · BINANCE BTCUSDT
ORDER FLOW SOURCE · HYPERLIQUID xyz:EUR
```

Never attach unrelated ETH, BTC, or crypto data to an unsupported instrument.

## Capability truth

Different providers expose different levels of data:

- Trades: only when the provider emits real trades
- L2/depth: only when the provider emits real order-book data
- Historical heatmap: only when depth history was recorded or supplied
- MBO/L3/icebergs: only with a verified MBO/L3-capable source
- Liquidations: only with a verified liquidation feed

For Hyperliquid, HIP-3 symbols are DEX-prefixed in API contexts, e.g. `xyz:ASSET`. The resolver must discover the live catalog rather than hard-code unsupported products.

## Data states

Every data widget must distinguish:

```text
LIVE
CONNECTING
RECONNECTING
PAUSED
HISTORICAL
PARTIAL
UNAVAILABLE
ERROR
```

Examples:

```text
No order-flow data for this pair
Live observed (partial)
Historical depth unavailable on this feed
Reported liquidations: waiting for reports
```

## Execution boundary

Analysis and execution are related but distinct:

- Footprint and heatmap are analysis layers
- DOM/orderbook is the precise ladder for order entry
- Chart trading can use a dedicated price-side trading area
- Orders, positions, stop loss, take profit, and OCO must show real broker/exchange state
- Clicking an analysis cell must not accidentally submit an order

## Implementation order

1. Preserve existing chart/tools and widget foundations.
2. Build the widget registry and workspace persistence.
3. Implement Chart + DOM + Trades widgets for BTC with real status/data.
4. Implement source catalog resolution for Binance, Hyperliquid core, and HIP-3.
5. Implement normalized trades/depth streams and historical capability states.
6. Implement footprint cells and the Footprint cluster view.
7. Implement heatmap/depth history and layers menu.
8. Implement volume profile, CVD, delta, bubbles, and Flow & Positioning.
9. Implement TPO and replay where data retention supports it.
10. Implement execution controls only after analysis data and provider capabilities are verified.

## Definition of done

A phase is not complete until:

- The widget is visible in the running terminal
- The selected symbol drives it
- The provider/source is shown
- Unsupported symbols show an honest state
- The data is real and traceable to a provider
- Reconnect/pause/error states work
- Existing chart tools still work
- Build and typecheck pass
- The Docker preview has been inspected
