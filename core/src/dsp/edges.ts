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

export type EdgeReport = {
  levels: Levels;
  /** At most `maxEdges` edges, in time order. */
  edges: Edge[];
  rises: Summary;
  falls: Summary;
  /** Rising-edge to rising-edge spacing. */
  periods: Summary;
  counts: { rise: number; fall: number; under: number };
  truncated: boolean;
  dt: number;
  /** Amplitude below this fraction of the record's span → no edges (a flat or noise-only record). */
  flat: boolean;
};

/** Running min / mean / max / standard deviation without keeping the values. */
export class Summer {
  n = 0;
  private s = 0;
  private s2 = 0;
  min = Infinity;
  max = -Infinity;
  add(x: number): void {
    this.n++;
    this.s += x;
    this.s2 += x * x;
    if (x < this.min) this.min = x;
    if (x > this.max) this.max = x;
  }
  get summary(): Summary {
    if (!this.n) return { n: 0, min: null, mean: null, max: null, std: null };
    const mean = this.s / this.n;
    const v = this.n > 1 ? Math.max(0, (this.s2 - this.n * mean * mean) / (this.n - 1)) : 0;
    return { n: this.n, min: this.min, mean, max: this.max, std: Math.sqrt(v) };
  }
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
  opts: { levels?: Levels; maxEdges?: number; minSamples?: number } = {},
): EdgeReport {
  const L = opts.levels ?? autoLevels(v);
  const maxEdges = opts.maxEdges ?? 100000;
  const minSamples = opts.minSamples ?? 3;
  const { min, max } = extrema(v);
  const flat = !(L.top - L.base > 0) || !(max - min > 0);
  const edges: Edge[] = [];
  const rises = new Summer();
  const falls = new Summer();
  const periods = new Summer();
  const counts = { rise: 0, fall: 0, under: 0 };
  let lastRise: number | null = null;
  if (!flat) {
    // state: where the signal last was beyond a reference level; lastLo/lastHi: the last sample at/below 10 % / at/above 90 %.
    let state: "low" | "high" | null = null;
    let lastLo = -1;
    let lastHi = -1;
    for (let i = 0; i < v.length; i++) {
      const x = v[i];
      if (x <= L.lo) {
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
        }
        state = "low";
        lastLo = i;
      } else if (x >= L.hi) {
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
        }
        state = "high";
        lastHi = i;
      }
    }
  }
  return { levels: L, edges, rises: rises.summary, falls: falls.summary, periods: periods.summary, counts, truncated: counts.rise + counts.fall > edges.length, dt, flat };
}
