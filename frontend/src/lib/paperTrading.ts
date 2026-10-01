/**
 * Paper trading engine — LOCAL SIMULATION ONLY.
 *
 * Nothing here ever touches a broker, the Brue Connect execution stack, or a
 * real order route. Fills happen at the live best bid/ask of the venue data
 * the chart already receives, and all state lives per widget in localStorage.
 */

export interface PaperPosition { symbol: string; side: 'long' | 'short'; qty: number; entry: number; }
export interface PaperAccount { position: PaperPosition | null; realized: number; trades: number; }

const KEY_PREFIX = 'green-terminal.paper.';

export function emptyPaperAccount(): PaperAccount { return { position: null, realized: 0, trades: 0 }; }

export function loadPaperAccount(widgetId: string): PaperAccount {
  try {
    const raw = localStorage.getItem(KEY_PREFIX + widgetId);
    if (!raw) return emptyPaperAccount();
    const value = JSON.parse(raw) as PaperAccount;
    const position: PaperPosition | null = value?.position && Number.isFinite(value.position.qty) && Number.isFinite(value.position.entry)
      ? { symbol: String(value.position.symbol || ''), side: value.position.side === 'short' ? 'short' : 'long', qty: Math.abs(value.position.qty), entry: value.position.entry }
      : null;
    return { position, realized: Number.isFinite(value?.realized) ? value.realized : 0, trades: Number.isFinite(value?.trades) ? value.trades : 0 };
  } catch { return emptyPaperAccount(); }
}

export function savePaperAccount(widgetId: string, account: PaperAccount): void {
  try { localStorage.setItem(KEY_PREFIX + widgetId, JSON.stringify(account)); } catch { /* memory state persists */ }
}

export interface PaperFill { pnl: number | null; message: string; }

/** Apply a market order at a live price. Same-side adds (averaged entry);
 * opposite-side reduces, closes, and flips with any remainder. */
export function applyPaperOrder(account: PaperAccount, symbol: string, side: 'buy' | 'sell', qty: number, price: number): { account: PaperAccount; fill: PaperFill } {
  const accountCopy: PaperAccount = { position: account.position ? { ...account.position } : null, realized: account.realized, trades: account.trades };
  if (!Number.isFinite(qty) || qty <= 0) return { account: accountCopy, fill: { pnl: null, message: 'Quantity must be greater than zero.' } };
  if (!Number.isFinite(price) || price <= 0) return { account: accountCopy, fill: { pnl: null, message: 'No live price yet — nothing filled.' } };
  const position = accountCopy.position && accountCopy.position.symbol === symbol ? accountCopy.position : null;
  if (accountCopy.position && !position) return { account: accountCopy, fill: { pnl: null, message: `Flat the ${accountCopy.position!.symbol} position first — one symbol per paper account.` } };

  const orderSign = side === 'buy' ? 1 : -1;
  let pnl: number | null = null;
  let remaining = qty;

  if (position) {
    const posSign = position.side === 'long' ? 1 : -1;
    if (posSign === orderSign) {
      position.entry = (position.qty * position.entry + qty * price) / (position.qty + qty);
      position.qty += qty;
      remaining = 0;
    } else {
      const closing = Math.min(position.qty, qty);
      pnl = (price - position.entry) * posSign * closing;
      accountCopy.realized += pnl;
      position.qty -= closing;
      remaining -= closing;
      if (position.qty <= 1e-12) accountCopy.position = null;
    }
  }
  if (remaining > 1e-12) {
    accountCopy.position = { symbol, side: side === 'buy' ? 'long' : 'short', qty: remaining, entry: price };
  }
  accountCopy.trades += 1;
  const direction = side === 'buy' ? 'BUY' : 'SELL';
  return { account: accountCopy, fill: { pnl, message: `${direction} ${qty} ${symbol} @ ${price}` } };
}

export function closePaperPosition(account: PaperAccount, price: number): { account: PaperAccount; fill: PaperFill } {
  if (!account.position) return { account: { ...account }, fill: { pnl: null, message: 'No open position.' } };
  if (!Number.isFinite(price) || price <= 0) return { account: { ...account }, fill: { pnl: null, message: 'No live price yet — nothing filled.' } };
  const posSign = account.position.side === 'long' ? 1 : -1;
  const pnl = (price - account.position.entry) * posSign * account.position.qty;
  const next: PaperAccount = { position: null, realized: account.realized + pnl, trades: account.trades + 1 };
  return { account: next, fill: { pnl, message: `CLOSED ${account.position.qty} ${account.position.symbol} @ ${price}` } };
}

export function paperUnrealized(position: PaperPosition, price: number): number {
  const sign = position.side === 'long' ? 1 : -1;
  return (price - position.entry) * sign * position.qty;
}
