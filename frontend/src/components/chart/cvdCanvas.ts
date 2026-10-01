import type { CvdSeries } from '@/lib/cvdSeries';

/** CVD line / per-period delta histogram canvas. Zero line is the anchor:
 * the cumulative path shades above (buy pressure) and below (sell pressure);
 * histogram bars are period net delta. */
export type CvdDrawMode = 'cvd' | 'delta';

const UP = '#42d493';
const DOWN = '#e28b91';
const ZERO = '#3a4b55';
const GRID = '#1e292f';
const LABEL = '#71808a';

export function drawCvd(canvas: HTMLCanvasElement, opts: { width: number; height: number; series: CvdSeries; mode: CvdDrawMode; devicePixelRatio?: number }): void {
  const dpr = opts.devicePixelRatio || 1;
  const width = Math.max(0, Math.floor(opts.width));
  const height = Math.max(0, Math.floor(opts.height));
  if (canvas.width !== width * dpr || canvas.height !== height * dpr) {
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
  }
  const ctx = canvas.getContext('2d');
  if (!ctx || width < 6 || height < 6) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = '#0d141a';
  ctx.fillRect(0, 0, width, height);

  const values = opts.mode === 'cvd' ? opts.series.cumulative : opts.series.periods.map(p => p.delta);
  if (!values.length) return;
  let vMin = Math.min(0, ...values);
  let vMax = Math.max(0, ...values);
  if (vMax - vMin < 1e-9) { vMax += 1; vMin -= 1; }
  const pad = (vMax - vMin) * 0.08;
  vMax += pad;
  vMin -= pad;

  const axisWidth = 56;
  const plotWidth = width - axisWidth;
  if (plotWidth < 8) return;
  const yFor = (value: number) => height - ((value - vMin) / (vMax - vMin)) * height;

  // Grid + axis labels.
  ctx.font = '9px system-ui, sans-serif';
  ctx.textBaseline = 'middle';
  for (let i = 0; i <= 4; i += 1) {
    const value = vMax - ((vMax - vMin) * i) / 4;
    const y = yFor(value);
    ctx.strokeStyle = GRID;
    ctx.beginPath();
    ctx.moveTo(0, y + 0.5);
    ctx.lineTo(plotWidth, y + 0.5);
    ctx.stroke();
    ctx.fillStyle = LABEL;
    ctx.fillText(short(value), plotWidth + 5, y, axisWidth - 8);
  }

  // Zero line.
  const yZero = yFor(0);
  ctx.strokeStyle = ZERO;
  ctx.setLineDash([5, 4]);
  ctx.beginPath();
  ctx.moveTo(0, yZero + 0.5);
  ctx.lineTo(plotWidth, yZero + 0.5);
  ctx.stroke();
  ctx.setLineDash([]);

  const step = plotWidth / values.length;
  if (opts.mode === 'delta') {
    const barWidth = Math.max(1, Math.floor(step * 0.7));
    values.forEach((value, index) => {
      const x = Math.floor(index * step + (step - barWidth) / 2);
      const y = yFor(value);
      ctx.fillStyle = value >= 0 ? UP : DOWN;
      const top = Math.min(y, yZero);
      ctx.fillRect(x, top, barWidth, Math.max(1, Math.abs(yZero - y)));
    });
  } else {
    // Shaded area above/below zero + the cumulative path.
    ctx.beginPath();
    values.forEach((value, index) => {
      const x = index * step + step / 2;
      const y = yFor(value);
      index === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    });
    ctx.strokeStyle = '#d6c08a';
    ctx.lineWidth = 1.4;
    ctx.stroke();
    ctx.lineWidth = 1;
    const lastX = (values.length - 1) * step + step / 2;
    ctx.lineTo(lastX, yZero);
    ctx.lineTo(step / 2, yZero);
    ctx.closePath();
    ctx.fillStyle = 'rgba(225, 182, 92, 0.10)';
    ctx.fill();
    const last = values[values.length - 1];
    ctx.fillStyle = last >= 0 ? UP : DOWN;
    ctx.beginPath();
    ctx.arc(lastX, yFor(last), 2.4, 0, Math.PI * 2);
    ctx.fill();
  }
}

function short(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return value.toFixed(abs >= 100 ? 0 : abs >= 1 ? 1 : 3);
}
