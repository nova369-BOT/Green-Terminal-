/**
 * Formatting primitives shared by the whole terminal.
 * Everything a trader reads is a number, so precision rules are product decisions,
 * not afterthoughts.
 */

export const pad2 = (n) => (n < 10 ? `0${n}` : String(n));

export function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Price ticks follow the instrument's own tick size, not a fixed 2dp. */
export function fmtPrice(value, tick = 0.01) {
  if (!Number.isFinite(value)) return '—';
  const digits = clamp(Math.ceil(-Math.log10(tick)), 0, 8);
  return value.toLocaleString('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

export function fmtQty(value, digits = 4) {
  if (!Number.isFinite(value)) return '—';
  return value.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: digits });
}

export function fmtMoney(value, opts = {}) {
  if (!Number.isFinite(value)) return '—';
  const { symbol = '$', digits = 2, compact = false } = opts;
  const sign = value < 0 ? '-' : '';
  const abs = Math.abs(value);
  if (compact && abs >= 1000) {
    const units = [
      [1e12, 'T'],
      [1e9, 'B'],
      [1e6, 'M'],
      [1e3, 'K'],
    ];
    for (const [div, suffix] of units) {
      if (abs >= div) return `${sign}${symbol}${(abs / div).toFixed(2)}${suffix}`;
    }
  }
  return `${sign}${symbol}${abs.toLocaleString('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })}`;
}

export function fmtPct(value, digits = 2, signed = true) {
  if (!Number.isFinite(value)) return '—';
  const sign = value > 0 && signed ? '+' : value < 0 ? '-' : '';
  return `${sign}${Math.abs(value * 100).toFixed(digits)}%`;
}

/** Fixed-width for console alignment. */
export function pad(text, width, align = 'right') {
  const s = String(text);
  if (s.length >= width) return s;
  const gap = ' '.repeat(width - s.length);
  return align === 'left' ? s + gap : gap + s;
}

export function truncate(text, max) {
  const s = String(text);
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function fmtTime(ts, withSeconds = true) {
  const d = new Date(ts);
  return withSeconds
    ? `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}`
    : `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
}

/** Chart axis + crosshair label. UTC everywhere: a terminal that mixes zones is a terminal with bugs. */
export function fmtStamp(ts, tfMinutes) {
  const d = new Date(ts);
  const hm = `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
  const day = `${WEEKDAYS[d.getUTCDay()]} ${pad2(d.getUTCDate())} ${MONTHS[d.getUTCMonth()]}`;
  if (tfMinutes >= 1440) return `${pad2(d.getUTCDate())} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
  if (tfMinutes >= 240) return `${day} ${hm}`;
  return `${pad2(d.getUTCDate())} ${MONTHS[d.getUTCMonth()]} ${hm}`;
}

export function fmtDuration(seconds) {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 24) return `${Math.floor(h / 24)}d ${h % 24}h`;
  return h > 0 ? `${h}h ${pad2(m)}m` : `${m}m ${pad2(s % 60)}s`;
}

export const signClass = (v) => (v > 0 ? 'up' : v < 0 ? 'down' : 'flat');
export const signArrow = (v) => (v > 0 ? '▲' : v < 0 ? '▼' : '▬');
