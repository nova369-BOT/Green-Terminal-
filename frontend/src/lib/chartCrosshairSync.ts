/**
 * Crosshair time-sync between chart tiles (plan item 14).
 *
 * Every chart tile publishes the WINDOW-START time of the bar under its
 * crosshair; every other tile draws a ghost vertical cursor at that bar if
 * its own loaded range contains it. This is a cursor mirror — no market
 * data crosses the bus, so there is nothing to fabricate. The primary
 * chart pane's crosshair lives inside the ported engine and is not
 * bridged (honest note in the workspace menu); tile-to-tile sync is the
 * shipped surface.
 */

type CrosshairListener = (timeMs: number | null) => void;

const listeners = new Set<{ sourceId: string; fn: CrosshairListener }>();
let lastSource = '';
let lastTime: number | null = null;
let throttleAt = 0;

/** ~30Hz max, deduped; null (pointer left) always passes so ghosts clear. */
export function publishCrosshair(sourceId: string, timeMs: number | null): void {
  const now = Date.now();
  if (timeMs !== null && now - throttleAt < 33) return;
  throttleAt = now;
  if (lastSource === sourceId && lastTime === timeMs) return;
  lastSource = sourceId;
  lastTime = timeMs;
  for (const entry of listeners) {
    if (entry.sourceId !== sourceId) entry.fn(timeMs);
  }
}

export function subscribeCrosshair(sourceId: string, fn: CrosshairListener): () => void {
  const entry = { sourceId, fn };
  listeners.add(entry);
  return () => { listeners.delete(entry); };
}
