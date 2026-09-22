/**
 * Chart renderer — hand-rolled canvas, no charting library.
 *
 * Reason: in a terminal the chart is the product. Crosshair latency, the price scale,
 * indicator z-order, automation overlays drawn on the *same* axis as the fills — all of
 * that is differentiating, and every one of those is a fight with a general-purpose
 * library. ~600 lines of canvas buys total control and a 0-byte dependency tree.
 *
 * Rendering contract: `update()` only marks the frame dirty; drawing happens in one rAF,
 * so a 6-symbol tick storm costs exactly one paint per frame.
 */
import { fmtPrice, fmtStamp, fmtTime, fmtQty, pad2 } from '../modules/fmt.js';

const MONO = '11px "JetBrains Mono", "SF Mono", ui-monospace, Menlo, Consolas, monospace';
const MONO_SM = '10px "JetBrains Mono", ui-monospace, Menlo, Consolas, monospace';
const MONO_BOLD = '600 11px "JetBrains Mono", ui-monospace, Menlo, Consolas, monospace';

const COLORS = {
  bg: '#050a07',
  panel: '#070f0b',
  grid: 'rgba(96, 214, 148, 0.07)',
  gridStrong: 'rgba(96, 214, 148, 0.13)',
  axis: 'rgba(140, 222, 176, 0.42)',
  up: '#2ee08a',
  down: '#ff5470',
  upFill: 'rgba(46, 224, 138, 0.85)',
  downFill: 'rgba(255, 84, 112, 0.82)',
  vol: 'rgba(46, 224, 138, 0.28)',
  volDown: 'rgba(255, 84, 112, 0.26)',
  cross: 'rgba(122, 255, 178, 0.5)',
  ema20: '#7ef0ff',
  ema50: '#ffd166',
  ema200: '#c58cff',
  vwap: '#9be15d',
  bb: 'rgba(155, 225, 93, 0.5)',
  donchian: '#ff9f6e',
  line: '#3ee08f',
  stop: '#ff5470',
  take: '#2ee08a',
  entry: '#ffd166',
};

export function createChart(host) {
  host.innerHTML = `
    <div class="chart__toolbar" data-chartbar></div>
    <div class="chart__canvas-wrap">
      <canvas data-canvas></canvas>
      <div class="chart__legend" data-legend></div>
      <div class="chart__hint" data-hint></div>
    </div>`;
  const canvas = host.querySelector('[data-canvas]');
  const legendEl = host.querySelector('[data-legend]');
  const hintEl = host.querySelector('[data-hint]');
  const ctx2d = canvas.getContext('2d', { alpha: false });

  let payload = { dataset: null, indicators: {}, view: {}, positions: [], fills: [], strategies: [], quote: null, meta: null };
  let dirty = true;
  let raf = null;
  let dpr = Math.max(1, Math.min(2.5, window.devicePixelRatio || 1));
  let geo = { w: 0, h: 0 };
  const view = { barsBack: 170, offset: 0 };
  const pointer = { x: -1, y: -1, inside: false, dragging: null, dragStartY: 0, dragStartX: 0, startIndex: 0, newLine: null };

  const ro = new ResizeObserver(() => {
    resize();
  });
  ro.observe(host);

  function resize() {
    const rect = host.getBoundingClientRect();
    const wrap = canvas.parentElement.getBoundingClientRect();
    dpr = Math.max(1, Math.min(2.5, window.devicePixelRatio || 1));
    geo = { w: Math.max(240, Math.floor(wrap.width)), h: Math.max(160, Math.floor(wrap.height)) };
    canvas.width = Math.floor(geo.w * dpr);
    canvas.height = Math.floor(geo.h * dpr);
    canvas.style.width = `${geo.w}px`;
    canvas.style.height = `${geo.h}px`;
    ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
    dirty = true;
    void rect;
  }

  function update(next) {
    payload = { ...payload, ...next };
    if (next.view) Object.assign(view, next.view);
    dirty = true;
    schedule();
  }

  function schedule() {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = null;
      if (dirty) {
        dirty = false;
        draw();
      }
    });
  }

  function setVisible(barsBack, offset) {
    view.barsBack = Math.max(24, Math.min(900, Math.round(barsBack)));
    view.offset = Math.max(0, Math.round(offset));
    dirty = true;
    schedule();
  }

  /* ---------------------------------------------------------------- drawing */

  function layout() {
    const axisW = 66;
    const timeH = 20;
    const gap = 6;
    const panes = [];
    const volOn = payload.view?.panes?.volume !== false;
    const rsiOn = payload.view?.panes?.rsi;
    const macdOn = payload.view?.panes?.macd;
    let h = geo.h - timeH - 4;
    const volH = volOn ? Math.round(Math.min(64, geo.h * 0.13)) : 0;
    const rsiH = rsiOn ? Math.round(Math.min(84, geo.h * 0.17)) : 0;
    const macdH = macdOn ? Math.round(Math.min(84, geo.h * 0.17)) : 0;
    const priceH = Math.max(90, h - volH - rsiH - macdH - gap * (1 + (rsiOn ? 1 : 0) + (macdOn ? 1 : 0)));
    let y = 2;
    panes.push({ id: 'price', x: 0, y, w: geo.w - axisW, h: priceH });
    y += priceH + gap;
    if (volH) {
      panes.push({ id: 'volume', x: 0, y, w: geo.w - axisW, h: volH });
      y += volH + gap;
    }
    if (rsiH) {
      panes.push({ id: 'rsi', x: 0, y, w: geo.w - axisW, h: rsiH });
      y += rsiH + gap;
    }
    if (macdH) {
      panes.push({ id: 'macd', x: 0, y, w: geo.w - axisW, h: macdH });
    }
    return { panes, axisW, timeH, price: panes[0] };
  }

  function draw() {
    const ds = payload.dataset;
    ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx2d.fillStyle = COLORS.bg;
    ctx2d.fillRect(0, 0, geo.w, geo.h);
    if (!ds || ds.len < 5) {
      ctx2d.fillStyle = COLORS.axis;
      ctx2d.font = MONO;
      ctx2d.fillText('loading bars…', 16, 24);
      return;
    }
    const L = layout();
    const n = ds.len;
    const barsBack = Math.min(view.barsBack, n);
    const end = Math.max(barsBack, n - view.offset);
    const start = Math.max(0, end - barsBack);
    const count = end - start;
    if (count < 2) return;
    const plotW = L.price.w;
    const barW = plotW / count;
    const bodyW = Math.max(1, Math.min(13, barW * 0.66));

    // price scale from visible candles (+ overlays + lines we must not clip)
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = start; i < end; i++) {
      if (ds.low[i] < lo) lo = ds.low[i];
      if (ds.high[i] > hi) hi = ds.high[i];
    }
    const overlaySeries = [];
    const o = payload.view?.overlays ?? {};
    if (o.ema20) overlaySeries.push(['ema:20', COLORS.ema20, 1]);
    if (o.ema50) overlaySeries.push(['ema:50', COLORS.ema50, 1]);
    if (o.ema200) overlaySeries.push(['ema:200', COLORS.ema200, 1.4]);
    if (o.vwap) overlaySeries.push(['vwap', COLORS.vwap, 1.1]);
    if (o.bb) {
      overlaySeries.push([payload.bbKey ?? 'bb:20:2:up', COLORS.bb, 1]);
      overlaySeries.push([payload.bbKey ?? 'bb:20:2:lo', COLORS.bb, 1]);
    }
    if (o.donchian) {
      overlaySeries.push(['donchian:20:hi', COLORS.donchian, 1]);
      overlaySeries.push(['donchian:20:lo', COLORS.donchian, 1]);
    }
    for (const [key] of overlaySeries) {
      const s = payload.indicators?.[key];
      if (!s) continue;
      for (let i = start; i < end; i++) {
        const v = s[i];
        if (Number.isNaN(v)) continue;
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
    }
    for (const pl of payload.priceLines ?? []) {
      if (pl.price < lo) lo = pl.price;
      if (pl.price > hi) hi = pl.price;
    }
    for (const p of payload.positions ?? []) {
      for (const v of [p.entry, p.stop, p.take]) {
        if (!Number.isFinite(v)) continue;
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
    }
    const pad = (hi - lo) * 0.08 || hi * 0.001;
    lo -= pad;
    hi += pad;
    const range = hi - lo || 1;
    const x = (i) => (i - start) * barW + barW / 2;
    const y = (p) => L.price.y + ((hi - p) / range) * L.price.h;

    /* grid + price axis */
    ctx2d.font = MONO_SM;
    ctx2d.textBaseline = 'middle';
    const ticks = niceTicks(lo, hi, Math.max(3, Math.floor(L.price.h / 46)));
    ctx2d.lineWidth = 1;
    for (const tk of ticks) {
      const yy = Math.round(y(tk)) + 0.5;
      ctx2d.strokeStyle = COLORS.grid;
      ctx2d.beginPath();
      ctx2d.moveTo(0, yy);
      ctx2d.lineTo(plotW, yy);
      ctx2d.stroke();
      ctx2d.fillStyle = COLORS.axis;
      ctx2d.textAlign = 'left';
      ctx2d.fillText(fmtPrice(tk, payload.meta?.tick ?? 0.01), plotW + 6, yy);
    }

    /* time axis */
    const tStep = Math.max(1, Math.round(count / Math.max(3, Math.floor(plotW / 96))));
    ctx2d.textAlign = 'center';
    for (let i = start + Math.floor(tStep / 2); i < end; i += tStep) {
      const xx = Math.round(x(i)) + 0.5;
      ctx2d.strokeStyle = COLORS.grid;
      ctx2d.beginPath();
      ctx2d.moveTo(xx, L.price.y);
      ctx2d.lineTo(xx, geo.h - L.timeH);
      ctx2d.stroke();
      ctx2d.fillStyle = COLORS.axis;
      ctx2d.fillText(fmtStamp(ds.t[i], payload.view?.minutes ?? 1).replace(/^[A-Z][a-z]{2} /, ''), xx, geo.h - L.timeH / 2);
    }

    /* volume pane */
    const volPane = L.panes.find((p) => p.id === 'volume');
    if (volPane) {
      let maxV = 0;
      for (let i = start; i < end; i++) maxV = Math.max(maxV, ds.volume[i]);
      maxV = maxV || 1;
      for (let i = start; i < end; i++) {
        const up = ds.close[i] >= ds.open[i];
        ctx2d.fillStyle = up ? COLORS.vol : COLORS.volDown;
        const hh = (ds.volume[i] / maxV) * (volPane.h - 2);
        ctx2d.fillRect(x(i) - bodyW / 2, volPane.y + volPane.h - hh, bodyW, hh);
      }
      label(ctx2d, volPane, 'VOL', 0);
    }

    /* candles */
    for (let i = start; i < end; i++) {
      const up = ds.close[i] >= ds.open[i];
      const color = up ? COLORS.up : COLORS.down;
      const cx = Math.round(x(i)) + 0.5;
      ctx2d.strokeStyle = color;
      ctx2d.lineWidth = Math.max(1, Math.min(1.6, barW * 0.14));
      ctx2d.beginPath();
      ctx2d.moveTo(cx, y(ds.high[i]));
      ctx2d.lineTo(cx, y(ds.low[i]));
      ctx2d.stroke();
      const yo = y(ds.open[i]);
      const yc = y(ds.close[i]);
      const top = Math.min(yo, yc);
      const bh = Math.max(1, Math.abs(yc - yo));
      ctx2d.fillStyle = up ? COLORS.upFill : COLORS.downFill;
      ctx2d.fillRect(cx - bodyW / 2, top, bodyW, bh);
      if (i === end - 1 && payload.forming) {
        // pulsing live candle: the terminal must visibly breathe
        ctx2d.globalAlpha = 0.55 + 0.45 * Math.sin(Date.now() / 320);
        ctx2d.fillRect(cx - bodyW / 2, top, bodyW, bh);
        ctx2d.globalAlpha = 1;
      }
    }

    /* overlays */
    ctx2d.save();
    ctx2d.beginPath();
    ctx2d.rect(0, L.price.y, plotW, L.price.h);
    ctx2d.clip();
    if (o.bb && payload.indicators[payload.bbKey + ':mid']) {
      const upS = payload.indicators[payload.bbKey + ':up'];
      const loS = payload.indicators[payload.bbKey + ':lo'];
      if (upS && loS) {
        ctx2d.fillStyle = 'rgba(155,225,93,0.05)';
        ctx2d.beginPath();
        for (let i = start; i < end; i++) {
          if (Number.isNaN(upS[i])) continue;
          const px = x(i);
          ctx2d.lineTo(px, y(upS[i]));
        }
        for (let i = end - 1; i >= start; i--) {
          if (Number.isNaN(loS[i])) continue;
          ctx2d.lineTo(x(i), y(loS[i]));
        }
        ctx2d.closePath();
        ctx2d.fill();
      }
    }
    for (const [key, color, w] of overlaySeries) {
      const s = payload.indicators?.[key];
      if (!s) continue;
      ctx2d.strokeStyle = color;
      ctx2d.lineWidth = w;
      ctx2d.beginPath();
      let started = false;
      for (let i = start; i < end; i++) {
        const v = s[i];
        if (Number.isNaN(v)) {
          started = false;
          continue;
        }
        if (!started) {
          ctx2d.moveTo(x(i), y(v));
          started = true;
        } else ctx2d.lineTo(x(i), y(v));
      }
      ctx2d.stroke();
    }

    /* automation overlay: positions, stops, targets, fills */
    for (const p of payload.positions ?? []) {
      const yE = Math.round(y(p.entry)) + 0.5;
      dashed(ctx2d, 0, yE, plotW, yE, COLORS.entry, [5, 4]);
      tag(ctx2d, plotW, yE, `${p.side.toUpperCase()} ${fmtQty(p.qty, 4)} @ ${fmtPrice(p.entry, payload.meta?.tick)}`, COLORS.entry, L);
      if (Number.isFinite(p.stop)) {
        const yS = Math.round(y(p.stop)) + 0.5;
        dashed(ctx2d, 0, yS, plotW, yS, COLORS.stop, [3, 3]);
        tag(ctx2d, plotW, yS, `SL ${fmtPrice(p.stop, payload.meta?.tick)}`, COLORS.stop, L);
      }
      if (Number.isFinite(p.take)) {
        const yT = Math.round(y(p.take)) + 0.5;
        dashed(ctx2d, 0, yT, plotW, yT, COLORS.take, [3, 3]);
        tag(ctx2d, plotW, yT, `TP ${fmtPrice(p.take, payload.meta?.tick)}`, COLORS.take, L);
      }
    }
    if (payload.showAutomation !== false) {
      for (const f of payload.fills ?? []) {
        if (f.symbol !== payload.view?.symbol) continue;
        const idx = nearestIndex(ds.t, f.barT ?? NaN, start, end);
        if (idx < 0) continue;
        const px = x(idx);
        const isBuy = f.kind === 'entry';
        const py = isBuy ? y(ds.low[idx]) + 13 : y(ds.high[idx]) - 13;
        ctx2d.fillStyle = f.side === 'long' ? COLORS.up : COLORS.down;
        ctx2d.globalAlpha = 0.92;
        tri(ctx2d, px, py, isBuy ? -1 : 1, 4.6);
        ctx2d.globalAlpha = 1;
      }
      // live strategy signal markers (armed + shadow)
      for (const s of payload.strategySignals ?? []) {
        const idx = nearestIndex(ds.t, s.t, start, end);
        if (idx < 0) continue;
        ctx2d.strokeStyle = s.shadow ? '#8ea8ff' : COLORS.line;
        ctx2d.lineWidth = 1;
        const cx = Math.round(x(idx)) + 0.5;
        ctx2d.beginPath();
        ctx2d.arc(cx, y(ds.close[idx]), 5.5, 0, Math.PI * 2);
        ctx2d.stroke();
        if (s.shadow) {
          ctx2d.setLineDash([2, 2]);
          ctx2d.beginPath();
          ctx2d.moveTo(cx, y(ds.close[idx]) - 9);
          ctx2d.lineTo(cx, y(ds.close[idx]) + 9);
          ctx2d.stroke();
          ctx2d.setLineDash([]);
        }
      }
    }
    ctx2d.restore();

    /* user price lines */
    for (const pl of payload.priceLines ?? []) {
      const yy = Math.round(y(pl.price)) + 0.5;
      ctx2d.strokeStyle = pl.color ?? 'rgba(62,224,143,0.75)';
      ctx2d.lineWidth = 1;
      ctx2d.beginPath();
      ctx2d.moveTo(0, yy);
      ctx2d.lineTo(plotW, yy);
      ctx2d.stroke();
      tag(ctx2d, plotW, yy, `${pl.label ?? 'L'} ${fmtPrice(pl.price, payload.meta?.tick)}`, pl.color ?? COLORS.line, L);
    }
    if (pointer.newLine) {
      const yy = Math.round(pointer.newLine.y) + 0.5;
      dashed(ctx2d, 0, yy, plotW, yy, 'rgba(122,255,178,0.8)', [4, 3]);
    }

    /* last price */
    const last = payload.quote?.last ?? ds.close[n - 1];
    if (Number.isFinite(last) && last >= lo && last <= hi) {
      const yy = Math.round(y(last)) + 0.5;
      const up = (payload.quote?.changePct ?? 0) >= 0;
      dashed(ctx2d, 0, yy, plotW, yy, up ? 'rgba(46,224,138,0.55)' : 'rgba(255,84,112,0.55)', [2, 3]);
      ctx2d.fillStyle = up ? COLORS.up : COLORS.down;
      ctx2d.fillRect(plotW + 2, yy - 8, L.axisW - 4, 16);
      ctx2d.fillStyle = '#04120a';
      ctx2d.font = MONO_BOLD;
      ctx2d.textAlign = 'left';
      ctx2d.fillText(fmtPrice(last, payload.meta?.tick), plotW + 6, yy);
      ctx2d.font = MONO_SM;
    }

    /* sub panes */
    const rsiPane = L.panes.find((p) => p.id === 'rsi');
    if (rsiPane) {
      const s = payload.indicators?.['rsi:14'];
      frame(ctx2d, rsiPane);
      label(ctx2d, rsiPane, `RSI(14)${s && !Number.isNaN(s[end - 1]) ? `  ${s[end - 1].toFixed(1)}` : ''}`, 0);
      if (s) {
        for (const lvl of [30, 50, 70]) {
          const ry = rsiPane.y + ((100 - lvl) / 100) * rsiPane.h;
          ctx2d.strokeStyle = lvl === 50 ? COLORS.grid : 'rgba(255,209,102,0.16)';
          ctx2d.beginPath();
          ctx2d.moveTo(0, Math.round(ry) + 0.5);
          ctx2d.lineTo(plotW, Math.round(ry) + 0.5);
          ctx2d.stroke();
          ctx2d.fillStyle = 'rgba(140,222,176,0.5)';
          ctx2d.textAlign = 'left';
          ctx2d.fillText(String(lvl), plotW + 6, ry);
        }
        ctx2d.strokeStyle = '#ffd166';
        ctx2d.lineWidth = 1.1;
        ctx2d.beginPath();
        let go = false;
        for (let i = start; i < end; i++) {
          const v = s[i];
          if (Number.isNaN(v)) {
            go = false;
            continue;
          }
          const px = x(i);
          const py = rsiPane.y + ((100 - v) / 100) * rsiPane.h;
          if (!go) {
            ctx2d.moveTo(px, py);
            go = true;
          } else ctx2d.lineTo(px, py);
        }
        ctx2d.stroke();
      }
    }
    const macdPane = L.panes.find((p) => p.id === 'macd');
    if (macdPane) {
      frame(ctx2d, macdPane);
      const line = payload.indicators?.['macd:line'];
      const sig = payload.indicators?.['macd:sig'];
      const hist = payload.indicators?.['macd:hist'];
      let m = 1e-9;
      if (line && hist) {
        for (let i = start; i < end; i++) {
          m = Math.max(m, Math.abs(line[i] || 0), Math.abs(hist[i] || 0));
        }
      }
      label(ctx2d, macdPane, `MACD(12,26,9)${hist && !Number.isNaN(hist[end - 1]) ? `  ${hist[end - 1].toFixed(4)}` : ''}`, 0);
      if (hist) {
        for (let i = start; i < end; i++) {
          const v = hist[i];
          if (Number.isNaN(v)) continue;
          const cy = macdPane.y + macdPane.h / 2;
          const hh = (v / m) * (macdPane.h / 2 - 2);
          ctx2d.fillStyle = v >= 0 ? 'rgba(46,224,138,0.55)' : 'rgba(255,84,112,0.55)';
          ctx2d.fillRect(x(i) - bodyW / 2, hh >= 0 ? cy - hh : cy, bodyW, Math.abs(hh));
        }
      }
      for (const [s, color] of [[line, '#7ef0ff'], [sig, '#ffd166']]) {
        if (!s) continue;
        ctx2d.strokeStyle = color;
        ctx2d.lineWidth = 1.1;
        ctx2d.beginPath();
        let go = false;
        for (let i = start; i < end; i++) {
          const v = s[i];
          if (Number.isNaN(v)) {
            go = false;
            continue;
          }
          const px = x(i);
          const py = macdPane.y + macdPane.h / 2 - (v / m) * (macdPane.h / 2 - 2);
          if (!go) {
            ctx2d.moveTo(px, py);
            go = true;
          } else ctx2d.lineTo(px, py);
        }
        ctx2d.stroke();
      }
    }

    /* crosshair */
    if (pointer.inside && !pointer.dragging) {
      const idx = clamp(Math.round((pointer.x - barW / 2) / barW) + start, start, end - 1);
      const px = Math.round(x(idx)) + 0.5;
      ctx2d.strokeStyle = COLORS.cross;
      ctx2d.setLineDash([3, 3]);
      ctx2d.lineWidth = 1;
      ctx2d.beginPath();
      ctx2d.moveTo(px, 0);
      ctx2d.lineTo(px, geo.h - L.timeH);
      ctx2d.stroke();
      const cy = Math.round(clamp(pointer.y, L.price.y, geo.h - L.timeH)) + 0.5;
      ctx2d.beginPath();
      ctx2d.moveTo(0, cy);
      ctx2d.lineTo(plotW, cy);
      ctx2d.stroke();
      ctx2d.setLineDash([]);
      // axis chips
      const priceAt = hi - ((cy - L.price.y) / L.price.h) * range;
      chip(ctx2d, plotW + 2, cy - 8, L.axisW - 4, 16, fmtPrice(priceAt, payload.meta?.tick), 'rgba(10,24,16,0.95)');
      const tw = 108;
      chip(ctx2d, clamp(px - tw / 2, 0, plotW - tw), geo.h - L.timeH + 2, tw, 16, fmtStamp(ds.t[idx], payload.view?.minutes ?? 1), 'rgba(10,24,16,0.95)');
      renderLegend(idx);
    } else renderLegend(end - 1);

    /* corner: symbol + timeframe + data provider, so a screenshot always identifies itself */
    ctx2d.font = MONO_BOLD;
    ctx2d.textAlign = 'left';
    ctx2d.fillStyle = 'rgba(140,222,176,0.7)';
    ctx2d.fillText(`${payload.view?.symbol ?? ''}  ·  ${payload.view?.tf ?? ''}  ·  ${payload.provider ?? 'SIM'}`, 8, geo.h - L.timeH / 2);
    if (payload.forming) {
      const mins = Math.floor((Date.now() - payload.forming.t) / 60000);
      ctx2d.font = MONO_SM;
      ctx2d.fillStyle = 'rgba(255,209,102,0.8)';
      ctx2d.textAlign = 'right';
      ctx2d.fillText(`live · ${payload.clockSpeedLabel ?? ''}${mins ? '' : ''}`, plotW - 8, geo.h - L.timeH / 2);
    }

    function renderLegend(i) {
      if (!Number.isFinite(ds.t[i])) return;
      const up = ds.close[i] >= ds.open[i];
      const parts = [
        `O ${fmtPrice(ds.open[i], payload.meta?.tick)}`,
        `H ${fmtPrice(ds.high[i], payload.meta?.tick)}`,
        `L ${fmtPrice(ds.low[i], payload.meta?.tick)}`,
        `C ${fmtPrice(ds.close[i], payload.meta?.tick)}`,
        `VOL ${compact(ds.volume[i])}`,
        `Δ ${((ds.close[i] / ds.open[i] - 1) * 100).toFixed(2)}%`,
      ];
      legendEl.innerHTML = `<span class="legend__t">${fmtStamp(ds.t[i], payload.view?.minutes ?? 1)}</span>` + parts.map((p) => `<span class="${up ? 'up' : 'down'}">${p}</span>`).join('');
    }
  }

  function label(c, pane, text, idx) {
    c.font = MONO_SM;
    c.textAlign = 'left';
    c.textBaseline = 'top';
    c.fillStyle = 'rgba(140,222,176,0.62)';
    c.fillText(text, pane.x + 6, pane.y + 4);
    c.textBaseline = 'middle';
    void idx;
  }

  function frame(c, pane) {
    c.strokeStyle = COLORS.gridStrong;
    c.lineWidth = 1;
    c.strokeRect(pane.x + 0.5, pane.y + 0.5, pane.w - 1, pane.h - 1);
  }

  function dashed(c, x0, y0, x1, y1, color, dash) {
    c.save();
    c.setLineDash(dash);
    c.strokeStyle = color;
    c.lineWidth = 1;
    c.beginPath();
    c.moveTo(x0, y0);
    c.lineTo(x1, y1);
    c.stroke();
    c.restore();
  }

  function tag(c, rightX, y, text, color, L) {
    c.font = MONO_SM;
    const w = c.measureText(text).width + 8;
    const x0 = rightX - w - 4;
    c.fillStyle = 'rgba(5,12,8,0.9)';
    c.fillRect(x0, y - 7, w, 14);
    c.strokeStyle = color;
    c.lineWidth = 1;
    c.strokeRect(x0 + 0.5, y - 6.5, w - 1, 13);
    c.fillStyle = color;
    c.textAlign = 'left';
    c.fillText(text, x0 + 4, y);
    void L;
  }

  function chip(c, x, y, w, h, text, bg) {
    c.fillStyle = bg;
    c.fillRect(x, y, w, h);
    c.fillStyle = '#bff5d4';
    c.font = MONO_SM;
    c.textAlign = 'center';
    c.fillText(text, x + w / 2, y + h / 2 + 0.5);
    c.textAlign = 'left';
  }

  function tri(c, x, y, dir, r) {
    c.beginPath();
    c.moveTo(x, y + dir * r);
    c.lineTo(x - r, y - dir * r);
    c.lineTo(x + r, y - dir * r);
    c.closePath();
    c.fill();
  }

  /* ---------------------------------------------------------------- events */

  canvas.addEventListener('pointermove', (e) => {
    const r = canvas.getBoundingClientRect();
    pointer.x = e.clientX - r.left;
    pointer.y = e.clientY - r.top;
    pointer.inside = true;
    const L = layout();
    if (pointer.dragging === 'pan') {
      const ds = payload.dataset;
      if (ds) {
        const barW = L.price.w / Math.min(view.barsBack, ds.len);
        const dx = Math.round((pointer.dragStartX - pointer.x) / barW);
        const maxOff = Math.max(0, ds.len - view.barsBack);
        view.offset = clamp(pointer.startIndex + dx, 0, maxOff);
      }
    } else if (pointer.dragging === 'line') {
      pointer.newLine = { y: clamp(pointer.y, L.price.y, L.price.y + L.price.h) };
    }
    dirty = true;
    schedule();
  });

  canvas.addEventListener('pointerleave', () => {
    pointer.inside = false;
    dirty = true;
    schedule();
  });

  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId);
    const L = layout();
    const r = canvas.getBoundingClientRect();
    const x = e.clientX - r.left;
    const yv = e.clientY - r.top;
    pointer.dragStartX = x;
    pointer.dragStartY = yv;
    pointer.startIndex = view.offset;
    if (e.altKey && yv < L.price.y + L.price.h) {
      const idx = hitLine(yv);
      if (idx >= 0) {
        payload.priceLines?.splice(idx, 1);
        dirty = true;
        schedule();
        return;
      }
    }
    if (x > L.price.w) {
      // price gutter: press-drag creates or moves a level
      pointer.dragging = 'line';
      return;
    }
    const near = hitLine(yv);
    pointer.dragging = near >= 0 ? 'line' : 'pan';
    pointer.dragLineIndex = near;
  });

  const endDrag = (e) => {
    const L = layout();
    if (pointer.dragging === 'line') {
      const ds = payload.dataset;
      if (ds) {
        const { lo, hi } = currentScale(L);
        const frac = 1 - (clamp(pointer.y, L.price.y, L.price.y + L.price.h) - L.price.y) / L.price.h;
        const price = lo + (hi - lo) * frac;
        payload.priceLines ??= [];
        if (pointer.dragLineIndex >= 0) payload.priceLines[pointer.dragLineIndex] = { ...payload.priceLines[pointer.dragLineIndex], price };
        else payload.priceLines.push({ price, label: 'LVL' });
        onPriceLines?.(payload.priceLines);
      }
    }
    pointer.dragging = null;
    pointer.newLine = null;
    pointer.dragLineIndex = -1;
    dirty = true;
    schedule();
    void e;
  };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);

  function hitLine(yv) {
    const lines = payload.priceLines ?? [];
    const L = layout();
    const { lo, hi } = currentScale(L);
    for (let i = 0; i < lines.length; i++) {
      const yy = L.price.y + ((hi - lines[i].price) / (hi - lo || 1)) * L.price.h;
      if (Math.abs(yy - yv) < 6) return i;
    }
    return -1;
  }

  function currentScale(L) {
    const ds = payload.dataset;
    let lo = Infinity;
    let hi = -Infinity;
    if (!ds) return { lo: 0, hi: 1 };
    const n = ds.len;
    const barsBack = Math.min(view.barsBack, n);
    const end = Math.max(barsBack, n - view.offset);
    const start = Math.max(0, end - barsBack);
    for (let i = start; i < end; i++) {
      if (ds.low[i] < lo) lo = ds.low[i];
      if (ds.high[i] > hi) hi = ds.high[i];
    }
    const pad = (hi - lo) * 0.08 || 1;
    return { lo: lo - pad, hi: hi + pad };
  }

  canvas.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      const ds = payload.dataset;
      if (!ds) return;
      if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        view.offset = clamp(view.offset + Math.sign(e.deltaX || e.deltaY) * 8, 0, Math.max(0, ds.len - view.barsBack));
      } else {
        const zoom = e.deltaY > 0 ? 1.12 : 1 / 1.12;
        const before = view.barsBack;
        setVisible(before * zoom, view.offset);
        // keep the bar under the cursor anchored
        const L = layout();
        const r = canvas.getBoundingClientRect();
        const frac = clamp((e.clientX - r.left) / L.price.w, 0, 1);
        const dBars = Math.round((view.barsBack - before) * (1 - frac));
        view.offset = clamp(view.offset - dBars, 0, Math.max(0, ds.len - view.barsBack));
        dirty = true;
        schedule();
      }
      onZoom?.(view);
    },
    { passive: false }
  );

  canvas.addEventListener('dblclick', () => {
    view.barsBack = 170;
    view.offset = 0;
    dirty = true;
    schedule();
    onZoom?.(view);
  });

  hintEl.addEventListener('click', () => {
    payload.priceLines = [];
    onPriceLines?.([]);
    dirty = true;
    schedule();
  });

  let onPriceLines = null;
  let onZoom = null;
  const api = {
    update,
    resize,
    setVisible,
    view,
    set onPriceLines(fn) {
      onPriceLines = fn;
    },
    set onZoom(fn) {
      onZoom = fn;
    },
    keepAlive() {
      // keeps the forming-bar pulse animating even when the feed is quiet
      dirty = true;
      schedule();
    },
    destroy() {
      ro.disconnect();
      if (raf) cancelAnimationFrame(raf);
    },
  };
  resize();
  return api;
}

/* ---------------------------------------------------------------- helpers */

export function niceTicks(lo, hi, target) {
  const span = hi - lo;
  if (!(span > 0)) return [lo];
  const raw = span / Math.max(2, target);
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const step = (norm > 5 ? 10 : norm > 2 ? 5 : norm > 1 ? 2 : 1) * mag;
  const out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) out.push(Number(v.toFixed(10)));
  return out;
}

function nearestIndex(times, t, start, end) {
  if (!Number.isFinite(t)) return -1;
  let best = -1;
  let bestD = Infinity;
  for (let i = start; i < end; i++) {
    const d = Math.abs(times[i] - t);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return bestD > 86400000 ? -1 : best;
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function compact(v) {
  const a = Math.abs(v);
  if (a >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
  if (a >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
  return v.toFixed(2);
}

/** Tiny generic line/spark renderer reused by the watchlist and the result panels. */
export function drawSpark(canvas, values, { color = COLORS.up, fill = true, baseline = null, height = 34 } = {}) {
  const c = canvas.getContext('2d');
  const d = Math.max(1, Math.min(2.5, window.devicePixelRatio || 1));
  const w = canvas.clientWidth || 60;
  const h = canvas.clientHeight || height;
  canvas.width = Math.floor(w * d);
  canvas.height = Math.floor(h * d);
  c.setTransform(d, 0, 0, d, 0, 0);
  c.clearRect(0, 0, w, h);
  const vals = Array.from(values).filter((v) => Number.isFinite(v));
  if (vals.length < 2) return;
  let lo = Math.min(...vals, baseline ?? Infinity);
  let hi = Math.max(...vals, baseline ?? -Infinity);
  if (hi === lo) hi = lo + 1;
  const pad = (hi - lo) * 0.12;
  lo -= pad;
  hi += pad;
  const step = w / (vals.length - 1);
  const X = (i) => i * step;
  const Y = (v) => h - ((v - lo) / (hi - lo)) * h;
  if (baseline != null) {
    c.strokeStyle = 'rgba(140,222,176,0.22)';
    c.setLineDash([2, 3]);
    c.beginPath();
    c.moveTo(0, Y(baseline));
    c.lineTo(w, Y(baseline));
    c.stroke();
    c.setLineDash([]);
  }
  if (fill) {
    c.beginPath();
    c.moveTo(X(0), Y(vals[0]));
    vals.forEach((v, i) => c.lineTo(X(i), Y(v)));
    c.lineTo(X(vals.length - 1), h);
    c.lineTo(X(0), h);
    c.closePath();
    const grad = c.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, color.replace(')', ', 0.30)').replace('rgb', 'rgba'));
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    c.fillStyle = grad;
    c.fill();
  }
  c.beginPath();
  vals.forEach((v, i) => (i ? c.lineTo(X(i), Y(v)) : c.moveTo(X(i), Y(v))));
  c.strokeStyle = color;
  c.lineWidth = 1.3;
  c.stroke();
}

/** Equity curve with a benchmark overlay — the backtest result's headline visual. */
export function drawEquity(canvas, curve, bench, { start = 0 } = {}) {
  const c = canvas.getContext('2d');
  const d = Math.max(1, Math.min(2.5, window.devicePixelRatio || 1));
  const w = canvas.clientWidth || 300;
  const h = canvas.clientHeight || 120;
  canvas.width = Math.floor(w * d);
  canvas.height = Math.floor(h * d);
  c.setTransform(d, 0, 0, d, 0, 0);
  c.fillStyle = '#04100a';
  c.fillRect(0, 0, w, h);
  const vals = curve.filter((v, i) => i >= start && Number.isFinite(v));
  const bvals = bench ? bench.filter((v, i) => i >= start && Number.isFinite(v)) : null;
  if (vals.length < 2) return;
  const all = bvals ? [...vals, ...bvals] : vals;
  let lo = Math.min(...all);
  let hi = Math.max(...all);
  if (hi === lo) hi = lo + 1;
  const pad = (hi - lo) * 0.08;
  lo -= pad;
  hi += pad;
  const X = (i, n) => (i / (n - 1)) * w;
  const Y = (v) => h - ((v - lo) / (hi - lo)) * (h - 16) - 8;
  for (const grid of [0.25, 0.5, 0.75]) {
    const yy = Math.round(h * grid) + 0.5;
    c.strokeStyle = 'rgba(96,214,148,0.06)';
    c.beginPath();
    c.moveTo(0, yy);
    c.lineTo(w, yy);
    c.stroke();
  }
  if (bvals) {
    c.beginPath();
    bvals.forEach((v, i) => (i ? c.lineTo(X(i, bvals.length), Y(v)) : c.moveTo(X(i, bvals.length), Y(v))));
    c.strokeStyle = 'rgba(197,140,255,0.7)';
    c.lineWidth = 1;
    c.setLineDash([4, 3]);
    c.stroke();
    c.setLineDash([]);
  }
  // drawdown shading under the strategy curve
  c.beginPath();
  vals.forEach((v, i) => (i ? c.lineTo(X(i, vals.length), Y(v)) : c.moveTo(X(i, vals.length), Y(v))));
  const peakLine = Y(hi);
  c.lineTo(w, h);
  c.lineTo(0, h);
  c.closePath();
  const g = c.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, 'rgba(46,224,138,0.22)');
  g.addColorStop(1, 'rgba(46,224,138,0)');
  c.fillStyle = g;
  c.fill();
  c.beginPath();
  vals.forEach((v, i) => (i ? c.lineTo(X(i, vals.length), Y(v)) : c.moveTo(X(i, vals.length), Y(v))));
  c.strokeStyle = COLORS.up;
  c.lineWidth = 1.5;
  c.stroke();
  void peakLine;
  c.font = MONO_SM;
  c.fillStyle = 'rgba(140,222,176,0.6)';
  c.fillText(`peak ${compact(hi)}   trough ${compact(lo)}`, 6, 12);
}

export const CHART_COLORS = COLORS;
export const stamp = fmtTime;
export const hhmm = (ts) => {
  const d = new Date(ts);
  return `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
};
