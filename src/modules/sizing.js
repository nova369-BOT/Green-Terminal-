/**
 * Position sizing — one pure implementation, imported by BOTH the paper broker and the
 * backtester. This is the module that makes "the backtest matches the live fill" a
 * fact rather than a hope: same fee model, same slippage hair, same tick/lot rounding.
 */

export function roundToStep(value, step, mode = 'nearest') {
  if (!step) return value;
  const raw = value / step;
  const n = mode === 'down' ? Math.floor(raw + 1e-9) : mode === 'up' ? Math.ceil(raw - 1e-9) : Math.round(raw);
  // snap off binary FP dust (0.1*12 = 1.2000000000000002) — a lot price with 16
  // significant digits is not a price a venue would accept anyway
  return Math.round(n * step * 1e12) / 1e12;
}

/**
 * @param {object} p
 * @param {{mode:string,value:number}} p.sizing     equityPct | riskBudget | fixedQty
 * @param {number} p.equity        account equity used as the sizing denominator
 * @param {number} p.entry         intended fill price (pre-slippage)
 * @param {number|null} p.stop      protective stop, required by riskBudget
 * @param {object} p.meta          instrument tick/qtyStep
 * @param {object} p.risk          feeBps, slippageBps, maxGrossPct, maxRiskPct
 * @param {number} p.grossNow      current gross notional already deployed
 * @param {number} p.leverage      buying-power multiple (1 = unlevered)
 */
export function computeSize({ sizing, equity, entry, stop, meta, risk, grossNow = 0, leverage = 1, side = 'long' }) {
  const s = sizing ?? { mode: 'equityPct', value: 0.1 };
  const tick = meta?.tick ?? 0.01;
  const step = meta?.qtyStep ?? 0.0001;
  const feeRate = (risk.feeBps ?? 4) / 1e4;
  const slippage = (risk.slippageBps ?? 2.5) / 1e4;
  const fill = entry * (1 + slippage * (side === 'long' ? 1 : -1));
  let qty = 0;
  let basis = '';
  let capped = false;

  if (s.mode === 'riskBudget') {
    const riskAmt = equity * s.value;
    const perUnit = Math.abs(entry - (stop ?? entry * 0.98));
    if (!(perUnit > 0)) return { ok: false, code: 'no_stop', msg: 'Risk-budget sizing needs a stop distance.' };
    qty = riskAmt / perUnit;
    basis = `risk ${(s.value * 100).toFixed(2)}% of equity to the stop`;
    const notionalCap = equity * leverage * 0.98;
    if (qty * entry > notionalCap) {
      qty = notionalCap / entry;
      capped = true;
    }
  } else if (s.mode === 'equityPct') {
    qty = (equity * s.value * leverage) / fill;
    basis = `${(s.value * 100).toFixed(0)}% of equity`;
  } else if (s.mode === 'fixedQty') {
    qty = s.value;
    basis = `${s.value} units (fixed)`;
  } else {
    return { ok: false, code: 'bad_mode', msg: `Unknown sizing mode "${s.mode}".` };
  }

  qty = roundToStep(qty, step, 'down');
  if (!(qty > 0)) {
    return { ok: false, code: 'zero_size', msg: `Sized to zero at lot step ${step}. Increase size or reduce the stop distance.` };
  }

  const gross = qty * fill;
  const grossCap = risk.maxGrossPct != null ? risk.maxGrossPct * equity * leverage : Infinity;
  if (grossNow + gross > grossCap) {
    return {
      ok: false,
      code: 'gross_cap',
      msg: `Gross cap ${(grossCap / (equity * leverage) * 100).toFixed(0)}% — already ${(grossNow / equity * 100).toFixed(0)}% deployed, order adds ${(gross / equity) * 100}%.`,
    };
  }

  const fees = gross * feeRate * 2; // entry + exit, priced in up front
  if (s.mode === 'riskBudget') {
    const riskNow = Math.abs(fill - (stop ?? entry * 0.98)) * qty;
    const hardCap = equity * (risk.maxRiskPct ?? 0.01) * 4;
    if (riskNow > hardCap) {
      return {
        ok: false,
        code: 'risk_cap',
        msg: `Trade risks ${((riskNow / equity) * 100).toFixed(2)}% of equity — above the ${((hardCap / equity) * 100).toFixed(1)}% hard cap.`,
      };
    }
  }

  return { ok: true, qty, fill, entry, fees, basis: capped ? `${basis} (capped at max notional)` : basis, gross, feeRate, slippage };
}
