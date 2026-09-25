// Analysis desk math. Counts only. No simulated path, no filled-in price,
// no demo series. Every rate below is a count over the bars it was given.
// The shell draws the figures; this file never touches the DOM.
(function () {
  function median(xs) {
    if (!xs || !xs.length) return null;
    const s = xs.slice().sort((a, b) => a - b);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }

  function num(v) {
    const n = +v;
    return isFinite(n) ? n : null;
  }

  function msOf(t) {
    if (t == null || t === "") return null;
    if (typeof t === "number" && isFinite(t)) return t > 1e12 ? t : t * 1000;
    const s = String(t).trim();
    let iso = s;
    if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(s) && !/[zZ]|[+-]\d{2}:?\d{2}$/.test(s)) {
      iso = s.replace(" ", "T") + "Z";
    }
    const n = Date.parse(iso);
    return isFinite(n) ? n : null;
  }

  function whenOf(ms) {
    if (ms == null) return "—";
    const d = new Date(ms);
    if (isNaN(d.getTime())) return "—";
    const p = (n) => String(n).padStart(2, "0");
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate())
      + " " + p(d.getHours()) + ":" + p(d.getMinutes());
  }

  function pct1(part, whole) {
    if (!whole) return null;
    return Math.round(1000 * part / whole) / 10;
  }

  function pctText(v) {
    if (v == null || !isFinite(v)) return "—";
    return v.toFixed(1) + "%";
  }

  function pts(n, ref) {
    if (n == null || !isFinite(n)) return "—";
    const a = Math.abs(ref || n || 1);
    const d = a >= 100 ? 2 : a >= 1 ? 4 : 6;
    return (n > 0 ? "+" : "") + n.toFixed(d);
  }

  function thin(read, method) {
    return { read: read, method: method, figure: { kind: "none" } };
  }

  function normalize(rows) {
    const out = [];
    for (const b of rows || []) {
      if (!b) continue;
      const open = num(b.open), high = num(b.high), low = num(b.low), close = num(b.close);
      if (open == null || high == null || low == null || close == null) continue;
      if (high < low) continue;
      const vol = num(b.volume);
      out.push({
        time: b.time,
        open: open, high: high, low: low, close: close,
        volume: vol == null ? 0 : vol,
      });
    }
    return out;
  }

  const SHORT = "Only the loaded bars are counted. A short sample moves around; read it as a count, not a law.";

  function breath(bars) {
    if (bars.length < 8) {
      return thin("Not enough closes to read a run.", "A run is consecutive closes in one direction. A flat close ends it.");
    }
    const stats = [];
    for (let k = 0; k <= 8; k++) stats.push({ cont: 0, rev: 0, flat: 0 });
    let sign = 0, len = 0;
    function closeRun(next) {
      if (!sign || len < 1) return;
      const cap = Math.min(8, len);
      for (let k = 1; k < cap; k++) stats[k].cont++;
      if (len > 8) stats[8].cont++;
      else if (next === 0) stats[len].flat++;
      else stats[len].rev++;
    }
    for (let i = 1; i < bars.length; i++) {
      const s = bars[i].close > bars[i - 1].close ? 1
        : bars[i].close < bars[i - 1].close ? -1 : 0;
      if (!s) { closeRun(0); sign = 0; len = 0; continue; }
      if (s === sign) len++;
      else { closeRun(s); sign = s; len = 1; }
    }
    const open = sign ? { sign: sign, len: len } : null;
    if (open) {
      const cap = Math.min(8, open.len);
      for (let k = 1; k < cap; k++) stats[k].cont++;
      if (open.len > 8) stats[8].cont++;
    }
    const rows = [];
    let lead = null;
    for (let k = 1; k <= 6; k++) {
      const st = stats[k];
      const n = st.cont + st.rev + st.flat;
      const rate = n >= 8 ? pct1(st.cont, n) : null;
      if (rate != null && (lead == null || n > lead.n)) lead = { k: k, rate: rate, n: n };
      rows.push({
        label: String(k),
        value: rate,
        n: n,
        thin: n < 8,
        mark: !!(open && open.len === k),
        caption: n < 8 ? (n ? n + " cases" : "—") : (rate.toFixed(1) + "% · " + n),
      });
    }
    let read;
    if (!lead) {
      read = "No run length has 8 cases yet. The counts are on the figure; a rate would overclaim.";
    } else {
      read = "A run of " + lead.k + " continued on the next bar " + lead.rate.toFixed(1)
        + "% of the time (" + lead.n + " cases).";
    }
    if (open) {
      read += " The open run is " + open.len + (open.sign > 0 ? " rising" : " falling") + ".";
    } else {
      read += " The last close did not extend a run.";
    }
    if (bars.length < 80) read += " " + SHORT;
    return {
      read: read,
      method: "A run is consecutive higher or lower closes. A flat close ends it and is not a continuation. The rate is, given the run had reached that length, how often the next close kept the direction. Lengths with fewer than 8 cases are shown as counts only.",
      figure: { kind: "hbar", max: 100, guides: [50], unit: "%", rows: rows },
    };
  }

  function wound(bars) {
    const CAP = 40;
    if (bars.length < 12) {
      return thin("Not enough bars to time a reclaim.", "A wound is a close in the outer quarter of its own range. Reclaim means a later bar trades back through that bar's open.");
    }
    const down = [], up = [];
    for (let i = 0; i < bars.length - 1; i++) {
      const b = bars[i];
      const range = b.high - b.low;
      if (!(range > 0)) continue;
      const loc = (b.close - b.low) / range;
      const side = loc <= 0.25 ? -1 : loc >= 0.75 ? 1 : 0;
      if (!side) continue;
      const level = b.open;
      let hit = null;
      const last = Math.min(bars.length - 1, i + CAP);
      for (let j = i + 1; j <= last; j++) {
        const t = bars[j];
        if (side < 0 ? t.high >= level : t.low <= level) { hit = j - i; break; }
      }
      const bucket = side < 0 ? down : up;
      if (hit != null) bucket.push(hit);
      else if (i + CAP < bars.length) bucket.push(null);
    }
    function pack(arr) {
      const done = arr.filter((x) => x != null);
      const bins = [];
      for (let i = 0; i < CAP; i++) bins.push(0);
      done.forEach((x) => { if (x >= 1 && x <= CAP) bins[x - 1]++; });
      return {
        n: arr.length,
        done: done.length,
        open: arr.length - done.length,
        med: median(done),
        bins: bins,
      };
    }
    const d = pack(down), u = pack(up);
    const lead = d.n >= u.n ? d : u;
    const leadName = d.n >= u.n ? "bottom" : "top";
    let read;
    if (lead.n < 8) {
      read = "Only " + d.n + " bottom-quarter and " + u.n + " top-quarter closes in this sample. Not enough to time a reclaim.";
    } else if (lead.done < 8) {
      read = "A close in the " + leadName + " quarter of its bar was still unreclaimed after "
        + CAP + " bars in " + lead.open + " of " + lead.n + " cases. Too few finished reclaims to quote a median.";
    } else {
      read = "A close in the " + leadName + " quarter of its bar was traded back through its open in a median of "
        + lead.med + " bars (" + lead.done + " of " + lead.n + " finished; "
        + lead.open + " still open after " + CAP + ").";
      const other = lead === d ? u : d;
      const otherName = lead === d ? "top" : "bottom";
      if (other.done >= 8) {
        read += " The " + otherName + " quarter took a median of " + other.med + " (" + other.n + " cases).";
      }
    }
    if (bars.length < 80) read += " " + SHORT;
    return {
      read: read,
      method: "A wound is a close in the top or bottom quarter of that bar's high-low range. Reclaim is the first later bar that trades through the wounded bar's open. Paths that never do so inside 40 bars, and had a full 40 bars to try, are counted as still open. A series that ends sooner is left out, so the open count is not inflated by the edge.",
      figure: lead.done ? { kind: "hist", bins: lead.bins, median: lead.med, cap: CAP, label: "bars to reclaim" } : { kind: "none" },
    };
  }

  function quiet(bars) {
    const hours = [];
    for (let h = 0; h < 24; h++) hours.push({ hour: h, n: 0, range: 0, vol: 0 });
    let timed = 0, volSum = 0;
    bars.forEach((b) => {
      const ms = msOf(b.time);
      if (ms == null) return;
      timed++;
      const h = new Date(ms).getUTCHours();
      const range = Math.max(0, b.high - b.low);
      hours[h].n++;
      hours[h].range += range;
      if (b.volume > 0) { hours[h].vol += b.volume; volSum += b.volume; }
    });
    if (timed < Math.max(8, bars.length * 0.8)) {
      return thin("These bars have no usable timestamps, so an hour map cannot be counted.", "Quiet hours buckets each bar by the UTC hour of its timestamp and sums high-low range.");
    }
    const present = hours.filter((h) => h.n > 0);
    if (present.length < 2) {
      return thin("These bars sit in one hour, so an hour map would only repeat one bucket.", "Quiet hours needs timestamps that spread across the day. A daily series will not.");
    }
    const totalR = hours.reduce((s, h) => s + h.range, 0);
    if (!(totalR > 0)) {
      return thin("The loaded bars have no range, so there is nothing to place by hour.", "Range is high minus low. A flat series has no hour to call loud.");
    }
    const even = Math.round(1000 / present.length) / 10;
    let loud = null, quietH = null;
    hours.forEach((h) => {
      h.share = Math.round(1000 * h.range / totalR) / 10;
      if (h.n >= 8 && (loud == null || h.share > loud.share)) loud = h;
      if (h.n >= 8 && (quietH == null || h.share < quietH.share)) quietH = h;
    });
    let read;
    if (!loud) {
      read = "No hour has 8 bars, so a loud hour would be a thin bucket. The figure still shows where the range sat.";
    } else {
      read = loud.hour + ":00 UTC held " + loud.share.toFixed(1) + "% of the range. An even split of the "
        + present.length + " hours that appear would be " + even.toFixed(1) + "%.";
      if (quietH && quietH.hour !== loud.hour) {
        read += " " + quietH.hour + ":00 UTC was the quietest hour with at least 8 bars ("
          + quietH.share.toFixed(1) + "%).";
      }
      if (volSum > 0 && loud.vol > 0) {
        const vs = pct1(loud.vol, volSum);
        read += " That hour also held " + vs.toFixed(1) + "% of the volume.";
      }
    }
    if (bars.length < 80) read += " " + SHORT;
    return {
      read: read,
      method: "Each bar is bucketed by the UTC hour of its timestamp. Bar height is that hour's share of the sum of high-low ranges, not of the bar count. Hours with fewer than 8 bars are drawn pale and are not called loud or quiet. The even line is 100% divided by the number of hours that appear at least once.",
      figure: {
        kind: "hours",
        even: even,
        rows: hours.map((h) => ({
          hour: h.hour, n: h.n, share: h.share, thin: h.n < 8,
          loud: !!(loud && h.hour === loud.hour),
        })),
      },
    };
  }

  function breaks(bars) {
    const N = 20, HOLD = 3;
    if (bars.length < N + HOLD + 1) {
      return thin("Not enough bars for a 20-bar break.", "A break is a close beyond the prior 20-bar high or low. It fails if any of the next 3 closes is no longer beyond that level.");
    }
    const events = [];
    for (let i = N; i < bars.length; i++) {
      let ph = -Infinity, pl = Infinity;
      for (let j = i - N; j < i; j++) {
        if (bars[j].high > ph) ph = bars[j].high;
        if (bars[j].low < pl) pl = bars[j].low;
      }
      const b = bars[i];
      let side = 0, level = 0;
      if (b.close > ph) { side = 1; level = ph; }
      else if (b.close < pl) { side = -1; level = pl; }
      else continue;
      let result = "open";
      if (i + HOLD < bars.length) {
        result = "hold";
        for (let k = 1; k <= HOLD; k++) {
          const c = bars[i + k].close;
          if (side > 0 ? c <= level : c >= level) { result = "fail"; break; }
        }
      }
      const follow = i + HOLD < bars.length
        ? (side > 0 ? bars[i + HOLD].close - b.close : b.close - bars[i + HOLD].close)
        : null;
      events.push({
        ms: msOf(b.time), side: side, result: result, follow: follow, ref: b.close,
      });
    }
    const done = events.filter((e) => e.result !== "open");
    const fails = done.filter((e) => e.result === "fail").length;
    const holds = done.length - fails;
    let read;
    if (done.length < 8) {
      read = done.length
        ? "Only " + done.length + " completed breaks of the prior 20-bar range. Not enough to quote a fail rate."
        : "No close broke the prior 20-bar range in this sample.";
    } else {
      const rate = pct1(fails, done.length);
      read = "Of " + done.length + " closes beyond the prior 20-bar range, " + fails
        + " were back inside within 3 bars (" + rate.toFixed(1) + "%). " + holds + " held.";
    }
    if (bars.length < 80) read += " " + SHORT;
    const ledger = events.slice(-10).reverse().map((e) => ({
      cells: [
        { text: whenOf(e.ms) },
        { text: e.side > 0 ? "Up" : "Down", cls: e.side > 0 ? "up" : "down" },
        { text: e.result === "hold" ? "Held" : e.result === "fail" ? "Failed" : "Open",
          cls: e.result === "hold" ? "up" : e.result === "fail" ? "down" : "" },
        { text: pts(e.follow, e.ref), cls: "num" },
      ],
    }));
    return {
      read: read,
      method: "Lookback is 20 bars. A break is a close beyond that window's high or low, not a wick. It fails if any of the next 3 closes is no longer beyond the broken level. The follow column is the close 3 bars later minus the break close, signed in the direction of the break. Breaks still inside those 3 bars are Open and are left out of the rate.",
      figure: {
        kind: "table",
        columns: ["When", "Side", "Result", "Follow"],
        rows: ledger,
      },
    };
  }

  function late(bars) {
    const WIN = 8;
    if (bars.length < WIN + 4) {
      return thin("Not enough bars to price a wait.", "An impulse is a close through the prior bar's high or low. The cost of waiting is how much of the next 8-bar extreme is already printed.");
    }
    const waits = [1, 2, 3];
    const up = waits.map(() => []);
    const down = waits.map(() => []);
    let upSkip = 0, downSkip = 0;
    for (let i = 1; i < bars.length - WIN; i++) {
      const prev = bars[i - 1], b = bars[i];
      const side = b.close > prev.high ? 1 : b.close < prev.low ? -1 : 0;
      if (!side) continue;
      const highs = [], lows = [];
      for (let k = 1; k <= WIN; k++) {
        highs.push(bars[i + k].high);
        lows.push(bars[i + k].low);
      }
      if (side > 0) {
        const eventual = Math.max.apply(null, highs) - b.close;
        if (!(eventual > 0)) { upSkip++; continue; }
        waits.forEach((w, idx) => {
          const reached = Math.max.apply(null, highs.slice(0, w)) - b.close;
          up[idx].push(Math.max(0, reached) / eventual * 100);
        });
      } else {
        const eventual = b.close - Math.min.apply(null, lows);
        if (!(eventual > 0)) { downSkip++; continue; }
        waits.forEach((w, idx) => {
          const reached = b.close - Math.min.apply(null, lows.slice(0, w));
          down[idx].push(Math.max(0, reached) / eventual * 100);
        });
      }
    }
    const upN = up[0].length, downN = down[0].length;
    function cell(arr) {
      return arr.length >= 8 ? Math.round(median(arr) * 10) / 10 : null;
    }
    const groups = waits.map((w, i) => ({
      label: w + (w === 1 ? " bar" : " bars"),
      values: [cell(up[i]), cell(down[i])],
    }));
    let read;
    if (upN < 8 && downN < 8) {
      read = "Only " + upN + " up and " + downN + " down impulses extended in the next 8 bars. Not enough to price a wait.";
    } else {
      const bits = [];
      if (upN >= 8) {
        bits.push("After an up close through the prior high, waiting one bar had already printed a median "
          + groups[0].values[0].toFixed(1) + "% of the next 8-bar extreme (" + upN + " cases). Waiting three left "
          + groups[2].values[0].toFixed(1) + "%.");
      }
      if (downN >= 8) {
        bits.push("After a down close through the prior low, one bar of waiting had printed "
          + groups[0].values[1].toFixed(1) + "% (" + downN + " cases).");
      }
      read = bits.join(" ");
      const skipped = upSkip + downSkip;
      if (skipped) read += " " + skipped + " impulses never extended, and are not in the median.";
    }
    if (bars.length < 80) read += " " + SHORT;
    return {
      read: read,
      method: "An impulse is a close above the prior bar's high, or below its low. The extreme is the best price in the next 8 bars, measured from the signal close. The figure is the median share of that extreme already printed after 1, 2 and 3 bars, and only for impulses that did extend. A side with fewer than 8 extensions is left blank.",
      figure: { kind: "grouped", max: 100, unit: "%", series: ["Up", "Down"], colors: ["up", "down"], guides: [50], groups: groups },
    };
  }

  function stepFor(price) {
    const a = Math.abs(price);
    if (a >= 1000) return 100;
    if (a >= 100) return 10;
    if (a >= 10) return 1;
    if (a >= 1) return 0.1;
    return 0.01;
  }

  function rounds(bars) {
    if (bars.length < 12) {
      return thin("Not enough bars to test a round.", "A test is a bar whose range contains the nearest round. Through means the close finished on the far side of the approach.");
    }
    const mid = median(bars.map((b) => b.close));
    const step = stepFor(mid == null ? bars[bars.length - 1].close : mid);
    const below = { through: 0, reject: 0, touch: 0 };
    const above = { through: 0, reject: 0, touch: 0 };
    function near(a, b) { return Math.abs(a - b) <= step * 1e-4 + 1e-9; }
    for (let i = 1; i < bars.length; i++) {
      const b = bars[i];
      const pivot = (b.high + b.low) / 2;
      const round = Math.round(pivot / step) * step;
      if (!(b.low <= round && b.high >= round)) continue;
      const prev = bars[i - 1].close;
      if (near(prev, round)) continue;
      const box = prev < round ? below : above;
      if (near(b.close, round)) box.touch++;
      else if (prev < round) box[b.close > round ? "through" : "reject"]++;
      else box[b.close < round ? "through" : "reject"]++;
    }
    function rate(box) {
      const n = box.through + box.reject;
      return { n: n, through: n >= 8 ? pct1(box.through, n) : null, reject: n >= 8 ? pct1(box.reject, n) : null, touch: box.touch };
    }
    const bel = rate(below), abv = rate(above);
    let read;
    if (bel.n < 8 && abv.n < 8) {
      read = "The step on this series is " + step + ". Only " + bel.n + " tests from below and "
        + abv.n + " from above. Not enough to call accept or reject.";
    } else {
      const bits = ["The step on this series is " + step + "."];
      if (bel.n >= 8) {
        bits.push("Coming from below, price closed through the round " + bel.through.toFixed(1)
          + "% of the time and rejected " + bel.reject.toFixed(1) + "% (" + bel.n + " tests).");
      }
      if (abv.n >= 8) {
        bits.push("Coming from above, it closed through " + abv.through.toFixed(1)
          + "% of the time (" + abv.n + " tests).");
      }
      read = bits.join(" ");
    }
    if (bars.length < 80) read += " " + SHORT;
    return {
      read: read,
      method: "The step is taken from the median close: 100 at 1,000 and above, 10 at 100, 1 at 10, 0.1 at 1, otherwise 0.01. A test is a bar whose high-low range contains the round nearest its midpoint, approached from a prior close on one side. Through means the close finished on the far side. A close on the round is a touch and is left out of the rate. Same-bar approach is not inferred beyond the prior close.",
      figure: {
        kind: "grouped",
        max: 100,
        unit: "%",
        series: ["Through", "Rejected"],
        colors: ["up", "down"],
        guides: [50],
        groups: [
          { label: "From below", values: [bel.through, bel.reject] },
          { label: "From above", values: [abv.through, abv.reject] },
        ],
      },
    };
  }

  function weather(bars) {
    if (bars.length < 12) {
      return thin("Not enough bars to name the weather.", "Shock is a range at least twice the median. Push is a median-or-larger range that closes in its outer quarter. Everything else is calm.");
    }
    const ranges = bars.map((b) => Math.max(0, b.high - b.low));
    const med = median(ranges.filter((r) => r > 0));
    if (!(med > 0)) {
      return thin("The loaded bars have no range, so calm, push and shock would be the same thing.", "Weather is classified from each bar's range against the median range.");
    }
    const tags = bars.map((b) => {
      const range = b.high - b.low;
      if (range >= 2 * med) return "shock";
      const loc = range > 0 ? (b.close - b.low) / range : 0.5;
      if (range >= med && (loc <= 0.25 || loc >= 0.75)) return "push";
      return "calm";
    });
    const follow = {
      calm: { n: 0, cont: 0 }, push: { n: 0, cont: 0 }, shock: { n: 0, cont: 0 },
    };
    for (let i = 0; i < bars.length - 1; i++) {
      const b = bars[i];
      const dir = b.close > b.open ? 1 : b.close < b.open ? -1 : 0;
      if (!dir) continue;
      const next = bars[i + 1].close - b.close;
      const box = follow[tags[i]];
      box.n++;
      if ((dir > 0 && next > 0) || (dir < 0 && next < 0)) box.cont++;
    }
    const cur = tags[tags.length - 1];
    let run = 1;
    for (let i = tags.length - 2; i >= 0; i--) {
      if (tags[i] !== cur) break;
      run++;
    }
    const word = cur === "calm" ? "calm" : cur === "push" ? "push" : "shock";
    let read = "The open weather is " + word + ", " + run + " bar" + (run === 1 ? "" : "s") + " so far.";
    ["push", "shock", "calm"].forEach((k) => {
      const box = follow[k];
      if (box.n >= 8) {
        read += " After a " + k + " bar, the next close continued that bar's direction "
          + pct1(box.cont, box.n).toFixed(1) + "% of the time (" + box.n + " cases).";
      }
    });
    if (bars.length < 80) read += " " + SHORT;
    const tail = Math.min(120, bars.length);
    return {
      read: read,
      method: "Median range is the median of high minus low, ignoring flat bars. Shock is a range of at least twice that. Push is a range at least the median that closes in its top or bottom quarter. Everything else is calm. Continuation is the next close moving the same way as this bar's close versus its open. A doji has no direction and is left out of that rate. The strip is the last " + tail + " bars.",
      figure: {
        kind: "strip",
        closes: bars.slice(-tail).map((b) => b.close),
        tags: tags.slice(-tail),
        dirs: bars.slice(-tail).map((b) => (b.close >= b.open ? 1 : -1)),
      },
    };
  }

  function room(bars) {
    const HORIZON = 20;
    if (bars.length < 16) {
      return thin("Not enough bars to see if a stop survives.", "Stop distance is one median bar range. A target is reached only if price trades there before the stop, inside 20 bars.");
    }
    const scale = median(bars.map((b) => Math.max(0, b.high - b.low)).filter((r) => r > 0));
    if (!(scale > 0)) {
      return thin("The loaded bars have no range, so a one-range stop is not a distance.", "Room uses the median high-low range as both the stop and the unit of the target.");
    }
    const targets = [1, 2];
    function run(side) {
      const out = targets.map(() => ({ hit: 0, stop: 0, open: 0 }));
      for (let i = 0; i < bars.length - 1; i++) {
        const entry = bars[i].close;
        const stop = side > 0 ? entry - scale : entry + scale;
        const last = Math.min(bars.length - 1, i + HORIZON);
        const full = i + HORIZON < bars.length;
        const done = targets.map(() => null);
        for (let j = i + 1; j <= last; j++) {
          if (done.every((d) => d)) break;
          const t = bars[j];
          const stopHit = side > 0 ? t.low <= stop : t.high >= stop;
          targets.forEach((k, idx) => {
            if (done[idx]) return;
            const tgt = side > 0 ? entry + k * scale : entry - k * scale;
            const tgtHit = side > 0 ? t.high >= tgt : t.low <= tgt;
            if (stopHit) done[idx] = "stop";
            else if (tgtHit) done[idx] = "hit";
          });
        }
        targets.forEach((k, idx) => {
          if (done[idx] === "hit") out[idx].hit++;
          else if (done[idx] === "stop") out[idx].stop++;
          else if (full) out[idx].open++;
        });
      }
      return out;
    }
    const long = run(1), short = run(-1);
    function rate(box) {
      const n = box.hit + box.stop;
      return n >= 8 ? pct1(box.hit, n) : null;
    }
    const rows = [
      { label: "Long 1×", box: long[0] },
      { label: "Long 2×", box: long[1] },
      { label: "Short 1×", box: short[0] },
      { label: "Short 2×", box: short[1] },
    ].map((r) => {
      const n = r.box.hit + r.box.stop;
      const value = rate(r.box);
      return {
        label: r.label,
        value: value,
        n: n,
        thin: n < 8,
        caption: n < 8 ? (n ? n + " paths" : "—") : (value.toFixed(1) + "% · " + n),
      };
    });
    let read;
    if (rows.every((r) => r.value == null)) {
      read = "Not enough finished paths to say whether a one-range stop survives. The stop distance on this series is " + scale + ".";
    } else {
      read = "Stop distance is one median range (" + (scale >= 100 ? scale.toFixed(2) : scale >= 1 ? scale.toFixed(4) : scale.toFixed(6)) + ").";
      rows.forEach((r) => {
        if (r.value == null) return;
        read += " " + r.label + " reached the target before the stop " + r.value.toFixed(1) + "% of the time (" + r.n + " paths).";
      });
    }
    if (bars.length < 80) read += " " + SHORT;
    return {
      read: read,
      method: "Entry is the bar's close. The stop is one median high-low range against the trade. Targets are one and two ranges in favor. A path ends when the stop or the target is traded, inside 20 bars. If one bar trades both, it is counted as the stop. Paths that do neither, and had the full 20 bars, are left out of the rate. The figure is the share that reached the target first.",
      figure: { kind: "hbar", max: 100, guides: [50], unit: "%", rows: rows },
    };
  }

  const TOOLS = [
    { id: "room", name: "Room", line: "Whether a one-range stop survives to the target." },
    { id: "late", name: "Late entry", line: "What waiting costs after an impulse bar." },
    { id: "breaks", name: "Break ledger", line: "Breaks of the prior range that held, and those that failed." },
    { id: "breath", name: "Breath", line: "How often a run of closes keeps going." },
    { id: "wound", name: "Wound", line: "How long a wounded bar stays unreclaimed." },
    { id: "quiet", name: "Quiet hours", line: "When this series actually spends its range." },
    { id: "weather", name: "Weather", line: "Calm, push and shock, and what followed each." },
    { id: "rounds", name: "Round test", line: "Whether price accepts or rejects a round number." },
  ];

  const COMPUTE = {
    room: room, late: late, breaks: breaks, breath: breath,
    wound: wound, quiet: quiet, weather: weather, rounds: rounds,
  };

  function compute(id, rows) {
    const bars = normalize(rows);
    const fn = COMPUTE[id] || breath;
    if (!bars.length) {
      return thin("No bars are loaded. This desk does not invent a series.", "Open a chart, or read a library set that has open, high, low and close.");
    }
    return fn(bars);
  }

  const api = { TOOLS: TOOLS, compute: compute, normalize: normalize, median: median };
  if (typeof window !== "undefined") window.GTAnalysis = api;
  if (typeof globalThis !== "undefined") globalThis.GTAnalysis = api;
})();
