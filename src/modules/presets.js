/**
 * Strategy library — the DSL made concrete.
 *
 * Each preset ships with the failure mode written next to it. A strategy catalog that
 * only advertises its edge is a marketing sheet; the note field is what turns the same
 * catalog into an honest one, and it is surfaced in the UI before you deploy.
 */
const IND = (name, ...args) => ({ kind: 'ind', name, args: args.filter((a) => a != null) });
const PART = (name, part, ...args) => ({ kind: 'ind', name, args: args, part });
const NUM = (value) => ({ kind: 'num', value });
const PRICE = (field) => ({ kind: 'price', field });
const VAR = (name) => ({ kind: 'var', name });
const LAG = (operand, n) => ({ kind: 'lag', operand, n });
const and = (...args) => ({ op: 'and', args });
const or = (...args) => ({ op: 'or', args });
const gt = (left, right) => ({ op: '>', left, right });
const gte = (left, right) => ({ op: '>=', left, right });
const lt = (left, right) => ({ op: '<', left, right });
const lte = (left, right) => ({ op: '<=', left, right });
const up = (left, right) => ({ op: 'cross_above', left, right });
const down = (left, right) => ({ op: 'cross_below', left, right });

export const PRESETS = [
  {
    key: 'trend-rider',
    name: 'Trend Rider',
    tags: ['trend', 'crypto', 'mid-timeframe'],
    blurb: 'Ride an established trend, entered on a momentum pulse, trailed by volatility.',
    honestNote:
      'Loses in chop — most of the time. The ATR trail is what pays for itself: a modest hit rate turned positive by letting winners run while the stop ratchets. If the trend filters are flat, stand aside.',
    symbol: 'BTC/USD',
    tf: '1h',
    direction: 'long',
    entry: and(
      gt(IND('ema', 20), IND('ema', 50)),
      gt(PRICE('close'), IND('vwap')),
      gt(IND('rsi', 14), NUM(54)),
      lt(IND('rsi', 14), NUM(74)),
      gt(VAR('volumeRatio'), NUM(0.9))
    ),
    exit: or(gt(IND('rsi', 14), NUM(79)), down(IND('ema', 20), IND('ema', 50))),
    exits: { stopPct: 0.04, takePct: null, trail: { type: 'atr', period: 14, mult: 3.2 } },
    sizing: { mode: 'riskBudget', value: 0.0075 },
    cooldownBars: 8,
  },
  {
    key: 'fade-stretch',
    name: 'Fade the Stretch',
    tags: ['mean-reversion', 'equities', 'counter-trend'],
    blurb: 'Buy oversold washouts at the lower band while volume confirms capitulation.',
    honestNote:
      'Counter-trend by construction, so it prints small steady wins and an occasional large loss. The hard stop is not optional — do not widen it after a bad week.',
    symbol: 'TSLA',
    tf: '15m',
    direction: 'long',
    entry: and(
      lt(IND('rsi', 14), NUM(30)),
      lt(PRICE('close'), PART('bb', 'lo', 20, 2)),
      gt(VAR('volumeRatio'), NUM(1.0)),
      gt(VAR('ema200Slope'), NUM(-20))
    ),
    exit: or(gt(IND('rsi', 14), NUM(56)), gte(PRICE('close'), PART('bb', 'mid', 20, 2))),
    exits: { stopPct: 0.018, takePct: 0.07, timeStopBars: 26 },
    sizing: { mode: 'riskBudget', value: 0.006 },
    cooldownBars: 6,
  },
  {
    key: 'box-breakout',
    name: 'Donchian Breakout',
    tags: ['breakout', 'crypto', 'high-vol'],
    blurb: 'Enter a fresh N-bar range break, only when participation confirms it.',
    honestNote:
      'Most breakouts fail — the edge lives in the channel definition and in getting out fast when the range reclaims the close. Expect many small losses carried by a handful of outsized winners.',
    symbol: 'SOL/USD',
    tf: '15m',
    direction: 'both',
    entry: and(up(PRICE('close'), PART('donchian', 'hi', 20)), gt(VAR('volumeRatio'), NUM(1.0))),
    entryShort: and(down(PRICE('close'), PART('donchian', 'lo', 20)), gt(VAR('volumeRatio'), NUM(1.0))),
    exit: lt(PRICE('close'), PART('donchian', 'lo', 20)),
    exits: { stopPct: 0.02, takePct: null, trail: { type: 'atr', period: 14, mult: 4 } },
    sizing: { mode: 'equityPct', value: 0.12 },
    cooldownBars: 2,
  },
  {
    key: 'macd-pulse',
    name: 'MACD Pulse',
    tags: ['momentum', 'scalp', 'all-venues'],
    blurb: 'Signal-line cross with no bias gate — pure momentum, ridden by an ATR trail. Frequent and fee-hungry.',
    honestNote:
      'Fees decide this one. Hundreds of round trips a quarter at 6.5bp of slippage+fee means the fee tier is part of the strategy — re-run the research tab at your real costs before arming.',
    symbol: 'ETH/USD',
    tf: '15m',
    direction: 'long',
    entry: up(PART('macd', 'line', 12, 26, 9), PART('macd', 'sig', 12, 26, 9)),
    exit: null,
    exits: { stopPct: 0.03, takePct: null, trail: { type: 'atr', period: 14, mult: 3 }, timeStopBars: 30 },
    sizing: { mode: 'riskBudget', value: 0.004 },
    cooldownBars: 2,
  },
  {
    key: 'dip-accum',
    name: 'Dip Accumulator',
    tags: ['dca', 'spot', 'long-horizon'],
    blurb: 'Add only into genuine weakness, trim once mean reversion pays. Spot only.',
    honestNote:
      'This is inventory management, not alpha. It lowers average cost and raises drawdown in a bear regime — the profit target is what keeps it honest.',
    symbol: 'ETH/USD',
    tf: '1h',
    direction: 'long',
    entry: and(lt(IND('rsi', 14), NUM(32)), lt(PRICE('close'), PART('bb', 'lo', 20, 1.8)), gt(LAG(IND('rsi', 14), 1), IND('rsi', 14))),
    exit: gte(PRICE('close'), IND('vwap')),
    exits: { stopPct: 0.1, takePct: 0.14 },
    sizing: { mode: 'equityPct', value: 0.18 },
    cooldownBars: 6,
  },
  {
    key: 'opening-range',
    name: 'Opening Range Trend',
    tags: ['equities', 'session', 'trend'],
    blurb: 'Equity intraday trend: only long when structure and the 200-EMA both agree.',
    honestNote:
      'Session-dependent, so it will look broken on half the calendar (holidays, thin days). Judge it per-session, not per-month.',
    symbol: 'AAPL',
    tf: '5m',
    direction: 'long',
    entry: and(gt(IND('ema', 20), IND('ema', 200)), gt(VAR('ema200Slope'), NUM(1.5)), gte(IND('roc', 24), NUM(1.0)), gt(PRICE('close'), IND('vwap'))),
    exit: or(lt(PRICE('close'), IND('vwap')), lt(IND('rsi', 14), NUM(44))),
    exits: { stopPct: 0.03, takePct: 0.05, timeStopBars: 40 },
    sizing: { mode: 'riskBudget', value: 0.006 },
    cooldownBars: 6,
  },
];

/** Instantiate a preset against a symbol/timeframe, ready for validation + deploy. */
export function fromPreset(preset, overrides = {}) {
  const clone = structuredClone(preset);
  const { key, blurb, honestNote, tags, ...rest } = clone;
  return {
    ...rest,
    ...overrides,
    presetKey: key,
    note: honestNote,
    tags,
  };
}

export function blank(symbol = 'BTC/USD', tf = '1h') {
  return {
    name: 'Untitled Strategy',
    symbol,
    tf,
    direction: 'long',
    mode: 'shadow',
    entry: and(gt(IND('ema', 20), IND('ema', 50))),
    exit: null,
    exits: { stopPct: 0.02, takePct: 0.04 },
    sizing: { mode: 'riskBudget', value: 0.005 },
    cooldownBars: 3,
  };
}

export const OPERAND_BUILDERS = { IND, NUM, PRICE, VAR, LAG, PART, and, or, gt, gte, lt, lte, up, down };
