/**
 * Session volume profile from verified trade prints.
 *
 * Rows are quantized price buckets across the session range; each row keeps
 * an honest buy/sell split (provider aggressor side only). POC is the
 * highest-volume row; the value area expands from the POC outward by the
 * larger neighbor until it covers 70% of session volume (classic VP rule).
 * HVN/LVN are marked against the row average.
 */

export interface ProfilePrint { price: number; size: number; side: 'buy' | 'sell' | null; }

export interface ProfileRow { price: number; buy: number; sell: number; total: number; hvn: boolean; lvn: boolean; }

export interface VolumeProfileResult {
  rows: ProfileRow[];            // price descending
  poc: number | null;
  vah: number | null;
  val: number | null;
  totalVolume: number;
  maxRowVolume: number;
}

export function buildVolumeProfile(prints: readonly ProfilePrint[], rowCount = 24): VolumeProfileResult | null {
  let pMin = Infinity;
  let pMax = -Infinity;
  for (const print of prints) {
    if (!Number.isFinite(print.price)) continue;
    if (print.price < pMin) pMin = print.price;
    if (print.price > pMax) pMax = print.price;
  }
  if (!Number.isFinite(pMin) || !Number.isFinite(pMax)) return null;
  const span = Math.max(pMax - pMin, 1e-9);
  const bucket = span / Math.max(1, rowCount);

  const rows: ProfileRow[] = Array.from({ length: rowCount }, (_, i) => ({ price: pMin + (i + 0.5) * bucket, buy: 0, sell: 0, total: 0, hvn: false, lvn: false }));
  for (const print of prints) {
    if (!Number.isFinite(print.price)) continue;
    const size = Number.isFinite(print.size) ? print.size : 0;
    const index = Math.max(0, Math.min(rowCount - 1, Math.floor((print.price - pMin) / bucket)));
    const row = rows[index];
    if (print.side === 'buy') row.buy += size;
    else if (print.side === 'sell') row.sell += size;
    row.total += size;
  }

  const totalVolume = rows.reduce((sum, row) => sum + row.total, 0);
  const maxRowVolume = rows.reduce((max, row) => Math.max(max, row.total), 0);
  if (totalVolume <= 0 || maxRowVolume <= 0) return null;

  // POC + value area (70%).
  let pocIndex = 0;
  rows.forEach((row, index) => { if (row.total > rows[pocIndex].total) pocIndex = index; });
  const poc = rows[pocIndex].price;
  let covered = rows[pocIndex].total;
  let up = pocIndex + 1;
  let down = pocIndex - 1;
  let vahIndex = pocIndex;
  let valIndex = pocIndex;
  const target = totalVolume * 0.7;
  while (covered < target && (up < rows.length || down >= 0)) {
    const upVol = up < rows.length ? rows[up].total : -1;
    const downVol = down >= 0 ? rows[down].total : -1;
    if (upVol >= downVol && up < rows.length) { covered += rows[up].total; vahIndex = up; up += 1; }
    else if (down >= 0) { covered += rows[down].total; valIndex = down; down -= 1; }
    else break;
  }
  const vah = rows[vahIndex].price;
  const val = rows[valIndex].price;

  // HVN/LVN vs the average of NONEMPTY context (rows with volume).
  const average = totalVolume / rowCount;
  rows.forEach(row => {
    row.hvn = row.total >= average * 1.6;
    row.lvn = row.total > 0 && row.total <= average * 0.4;
  });

  return { rows: rows.slice().sort((a, b) => b.price - a.price), poc, vah, val, totalVolume, maxRowVolume };
}
