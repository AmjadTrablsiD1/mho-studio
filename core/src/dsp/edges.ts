// Every edge in one record: when it happened and how fast it was. For a burst
// that comes once (an SPI transfer, a reset pulse train), captured by a single
// trigger and read in full from deep memory.
//
// Method, stated so it can be checked:
//  • Reference levels from the record's base and top (histogram modes, as in
//    measure.ts), or given by the user: 10 %, 50 % and 90 % between them.
//  • A rising edge is a passage from at or below the 10 % level to at or above
//    the 90 % level (hysteresis: noise and ringing that stay between the two
//    levels make no edge). Falling: the other way.
//  • Its rise time is the time from the last 10 % crossing to the first 90 %
//    crossing of that passage, each interpolated linearly between the two
//    samples around it; its time is the first 50 % crossing in between.
//  • An edge whose passage takes fewer than `minSamples` intervals is marked
//    under-sampled: its duration is then mostly the sample spacing, not the
//    signal. For a trustworthy 10–90 % time, sample at least ~5× faster than
//    the edge.
//  • A pulse is the time between the 50 % crossings of two successive edges
//    (rise → fall: high pulse; fall → rise: low pulse). With `glitchS` set, a
//    pulse narrower than it is a glitch.
//  • A runt is a swing that crosses the 50 % level and turns back to where it
//    came from without reaching the far reference level (low → above 50 % →
//    low again without reaching 90 %). Noise and ringing near a rail stay on
//    their side of 50 % and make no runt.
//  • Setup and hold (setupHold): for each sampling clock edge, setup is the
//    time from the last data transition at or before it, hold the time to the
//    next data transition after it, both between 50 % crossings.

import { extrema, levels as autoLevels, type Levels } from "./measure.ts";

export type EdgeKind = "rise" | "fall";
export type Edge = {
  /** Sample index of the 50 % crossing (rounded down). */
  i: number;
  /** Time of the 50 % crossing, seconds (relative to the trigger when t0 is the record's first-point time). */
  t: number;
  kind: EdgeKind;
  /** 10–90 % (rise) or 90–10 % (fall) time, seconds. */
  dur: number;
  /** Fewer than `minSamples` sample intervals across the edge. */
  under: boolean;
};

export type Summary = { n: number; min: number | null; mean: number | null; max: number | null; std: number | null };

/**
 * Something that is not a clean edge. Polarity "high": a pulse above the
 * middle (a positive glitch, or a runt that rose from low); "low": the other
 * way. `t`: its first 50 % crossing; `width`: between its 50 % crossings;
 * `peak`: how far a runt got, volts.
 */
export type Anomaly = { kind: "glitch" | "runt"; polarity: "high" | "low"; t: number; width: number | null; peak: number | null };

export type EdgeReport = {
  levels: Levels;
  /** At most `maxEdges` edges, in time order. */
  edges: Edge[];
  rises: Summary;
  falls: Summary;
  /** Rising-edge to rising-edge spacing. */
  periods: Summary;
  /** Widths of high pulses (rise → fall) and low pulses (fall → rise), 50 % to 50 %. */
  pulses: { high: Summary; low: Summary };
  /** At most `maxEdges` glitches and runts, in time order. */
  anomalies: Anomaly[];
  counts: { rise: number; fall: number; under: number; glitch: number; runt: number };
  truncated: boolean;
  dt: number;
  /** Amplitude below this fraction of the record's span → no edges (a flat or noise-only record). */
  flat: boolean;
};

/**
 * Running min / mean / max / standard deviation without keeping the values.
 * Welford's update: exact enough when the spread is a millionth of the mean
 * (picoseconds of jitter on a millisecond period), where a sum of squares
 * would lose every digit.
 */
export class Summer {
  n = 0;
  private mean = 0;
  private m2 = 0;
  min = Infinity;
  max = -Infinity;
  add(x: number): void {
    this.n++;
    const d = x - this.mean;
    this.mean += d / this.n;
    this.m2 += d * (x - this.mean);
    if (x < this.min) this.min = x;
    if (x > this.max) this.max = x;
  }
  get summary(): Summary {
    if (!this.n) return { n: 0, min: null, mean: null, max: null, std: null };
    return { n: this.n, min: this.min, mean: this.mean, max: this.max, std: this.n > 1 ? Math.sqrt(Math.max(0, this.m2 / (this.n - 1))) : 0 };
  }
}

/**
 * The summary of several sets of values taken together (n, min, mean, max and
 * sample σ, as if one Summer had seen them all): the pairwise update of Chan
 * et al., M2 = M2a + M2b + δ²·na·nb / n.
 */
export function mergeSummaries(parts: Summary[]): Summary {
  let n = 0;
  let mean = 0;
  let m2 = 0;
  let min = Infinity;
  let max = -Infinity;
  for (const p of parts) {
    if (!p.n) continue;
    const pm2 = p.std! ** 2 * (p.n - 1);
    const d = p.mean! - mean;
    const total = n + p.n;
    m2 += pm2 + (d * d * n * p.n) / total;
    mean += (d * p.n) / total;
    n = total;
    min = Math.min(min, p.min!);
    max = Math.max(max, p.max!);
  }
  if (!n) return { n: 0, min: null, mean: null, max: null, std: null };
  return { n, min, mean, max, std: n > 1 ? Math.sqrt(Math.max(0, m2 / (n - 1))) : 0 };
}

/** Levels from a given base and top (volts). */
export function levelsFrom(base: number, top: number): Levels {
  const a = top - base;
  return { base, top, lo: base + 0.1 * a, mid: base + 0.5 * a, hi: base + 0.9 * a };
}

/** Time at which v crosses `level` between samples i and i+1 (linear), in sample units. */
function cross(v: ArrayLike<number>, i: number, level: number): number {
  const a = v[i];
  const b = v[i + 1];
  return b === a ? i : i + (level - a) / (b - a);
}

export function findEdges(
  v: ArrayLike<number>,
  dt: number,
  t0 = 0,
  opts: { levels?: Levels; maxEdges?: number; minSamples?: number; glitchS?: number | null } = {},
): EdgeReport {
  const L = opts.levels ?? autoLevels(v);
  const maxEdges = opts.maxEdges ?? 100000;
  const minSamples = opts.minSamples ?? 3;
  const glitchS = opts.glitchS ?? null;
  const { min, max } = extrema(v);
  const flat = !(L.top - L.base > 0) || !(max - min > 0);
  const edges: Edge[] = [];
  const rises = new Summer();
  const falls = new Summer();
  const periods = new Summer();
  const high = new Summer();
  const low = new Summer();
  const anomalies: Anomaly[] = [];
  const counts = { rise: 0, fall: 0, under: 0, glitch: 0, runt: 0 };
  let lastRise: number | null = null;
  let last: Edge | null = null;
  const note = (a: Anomaly) => {
    counts[a.kind]++;
    if (anomalies.length < maxEdges) anomalies.push(a);
  };
  /** A finished edge: the pulse it closes, and whether that pulse is a glitch. */
  const pulse = (e: Edge) => {
    if (last && last.kind !== e.kind) {
      const w = e.t - last.t;
      const pol = last.kind === "rise" ? "high" : "low";
      (pol === "high" ? high : low).add(w);
      if (glitchS !== null && w < glitchS) note({ kind: "glitch", polarity: pol, t: last.t, width: w, peak: null });
    }
    last = e;
  };
  if (!flat) {
    // state: where the signal last was beyond a reference level; lastLo/lastHi: the last sample at/below 10 % / at/above 90 %.
    let state: "low" | "high" | null = null;
    let lastLo = -1;
    let lastHi = -1;
    // A possible runt since the signal was last at a rail: its first 50 % crossing away from it, the last one back, and its extreme.
    let away = -1;
    let back = -1;
    let peak = 0;
    const clear = (x: number) => {
      away = -1;
      back = -1;
      peak = x;
    };
    for (let i = 0; i < v.length; i++) {
      const x = v[i];
      if (i > 0 && state !== null) {
        const p = v[i - 1];
        const up = p < L.mid && x >= L.mid;
        const down = p >= L.mid && x < L.mid;
        if (state === "low") {
          if (up && away < 0) away = cross(v, i - 1, L.mid);
          if (down) back = cross(v, i - 1, L.mid);
          if (x > peak) peak = x;
        } else {
          if (down && away < 0) away = cross(v, i - 1, L.mid);
          if (up) back = cross(v, i - 1, L.mid);
          if (x < peak) peak = x;
        }
      }
      if (x <= L.lo) {
        if (state === "low" && away >= 0) note({ kind: "runt", polarity: "high", t: t0 + away * dt, width: back > away ? (back - away) * dt : null, peak });
        if (state === "high" && lastHi >= 0) {
          // Falling passage: from the last sample at/above 90 % to this one.
          const a = lastHi;
          const s90 = cross(v, a, L.hi);
          const s10 = cross(v, i - 1, L.lo);
          let m = a;
          while (m < i - 1 && v[m + 1] > L.mid) m++;
          const s50 = cross(v, m, L.mid);
          const e: Edge = { i: Math.floor(s50), t: t0 + s50 * dt, kind: "fall", dur: (s10 - s90) * dt, under: i - a < minSamples };
          falls.add(e.dur);
          counts.fall++;
          if (e.under) counts.under++;
          if (edges.length < maxEdges) edges.push(e);
          pulse(e);
        }
        state = "low";
        lastLo = i;
        clear(x);
      } else if (x >= L.hi) {
        if (state === "high" && away >= 0) note({ kind: "runt", polarity: "low", t: t0 + away * dt, width: back > away ? (back - away) * dt : null, peak });
        if (state === "low" && lastLo >= 0) {
          const a = lastLo;
          const s10 = cross(v, a, L.lo);
          const s90 = cross(v, i - 1, L.hi);
          let m = a;
          while (m < i - 1 && v[m + 1] < L.mid) m++;
          const s50 = cross(v, m, L.mid);
          const e: Edge = { i: Math.floor(s50), t: t0 + s50 * dt, kind: "rise", dur: (s90 - s10) * dt, under: i - a < minSamples };
          rises.add(e.dur);
          counts.rise++;
          if (e.under) counts.under++;
          if (lastRise !== null) periods.add(e.t - lastRise);
          lastRise = e.t;
          if (edges.length < maxEdges) edges.push(e);
          pulse(e);
        }
        state = "high";
        lastHi = i;
        clear(x);
      }
    }
  }
  anomalies.sort((a, b) => a.t - b.t);
  return {
    levels: L, edges, rises: rises.summary, falls: falls.summary, periods: periods.summary, pulses: { high: high.summary, low: low.summary },
    anomalies, counts, truncated: counts.rise + counts.fall > edges.length, dt, flat,
  };
}

export type Histogram = { lo: number; hi: number; counts: number[] };

/** `bins` equal bins from the smallest to the largest value (one bin when they are all equal). */
export function histogram(xs: ArrayLike<number>, bins = 40): Histogram {
  if (!xs.length) return { lo: 0, hi: 0, counts: [] };
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < xs.length; i++) {
    if (xs[i] < lo) lo = xs[i];
    if (xs[i] > hi) hi = xs[i];
  }
  const n = hi > lo ? bins : 1;
  const counts = new Array<number>(n).fill(0);
  for (let i = 0; i < xs.length; i++) counts[n === 1 ? 0 : Math.min(n - 1, Math.floor(((xs[i] - lo) / (hi - lo)) * n))]++;
  return { lo, hi, counts };
}

/** One sampling clock edge: setup from the last data transition before it, hold to the next one after it (null where the record has none). */
export type TimingRow = { t: number; setup: number | null; hold: number | null };

export type SetupHold = { rows: TimingRow[]; setup: Summary; hold: Summary; worstSetup: TimingRow | null; worstHold: TimingRow | null };

/**
 * Setup and hold of a data line against the `edge` edges of a clock, both edge
 * lists in time order and on the same time axis. Every clock edge of that
 * kind gives a row; the summaries and the worst (smallest) values are taken
 * over the rows that have the value.
 */
export function setupHold(clock: Edge[], data: Edge[], edge: EdgeKind): SetupHold {
  const rows: TimingRow[] = [];
  const su = new Summer();
  const ho = new Summer();
  let worstSetup: TimingRow | null = null;
  let worstHold: TimingRow | null = null;
  let j = -1; // the last data edge at or before the clock edge
  for (const c of clock) {
    if (c.kind !== edge) continue;
    while (j + 1 < data.length && data[j + 1].t <= c.t) j++;
    const row: TimingRow = { t: c.t, setup: j >= 0 ? c.t - data[j].t : null, hold: j + 1 < data.length ? data[j + 1].t - c.t : null };
    rows.push(row);
    if (row.setup !== null) {
      su.add(row.setup);
      if (!worstSetup || row.setup < worstSetup.setup!) worstSetup = row;
    }
    if (row.hold !== null) {
      ho.add(row.hold);
      if (!worstHold || row.hold < worstHold.hold!) worstHold = row;
    }
  }
  return { rows, setup: su.summary, hold: ho.summary, worstSetup, worstHold };
}
