// Waveform measurements computed from a record, independently of the
// instrument. The app shows them beside the MHO984's own numbers as a
// cross-check, and the simulator answers :MEASure:ITEM? with them.
//
// Method (IEEE 181-style, simplified and stated here so a reader can check it):
//  • top / base: the two modes of a 256-bin histogram, one in each half of the
//    range; fall back to max / min when a half is empty (e.g. a sine).
//  • reference levels: 10 / 50 / 90 % between base and top.
//  • crossings of the 50 % level with 10 %/90 % hysteresis, interpolated
//    linearly between samples; period = mean spacing of like crossings.

export type Levels = { top: number; base: number; lo: number; mid: number; hi: number };

export function extrema(v: ArrayLike<number>): { min: number; max: number; mean: number; rms: number } {
  let min = Infinity;
  let max = -Infinity;
  let s = 0;
  let s2 = 0;
  for (let i = 0; i < v.length; i++) {
    const x = v[i];
    if (x < min) min = x;
    if (x > max) max = x;
    s += x;
    s2 += x * x;
  }
  const n = v.length || 1;
  return { min, max, mean: s / n, rms: Math.sqrt(s2 / n) };
}

export function levels(v: ArrayLike<number>, bins = 256): Levels {
  const { min, max } = extrema(v);
  const span = max - min || 1;
  const h = new Uint32Array(bins);
  for (let i = 0; i < v.length; i++) h[Math.min(bins - 1, Math.floor(((v[i] - min) / span) * bins))]++;
  const half = bins >> 1;
  let lo = 0;
  let hi = half;
  for (let i = 1; i < half; i++) if (h[i] > h[lo]) lo = i;
  for (let i = half + 1; i < bins; i++) if (h[i] > h[hi]) hi = i;
  // A mode only counts if it holds a real share of the record (flat tops); else use the extreme.
  const need = v.length * 0.05;
  const base = h[lo] >= need ? min + ((lo + 0.5) / bins) * span : min;
  const top = h[hi] >= need ? min + ((hi + 0.5) / bins) * span : max;
  const amp = top - base;
  return { top, base, lo: base + 0.1 * amp, mid: base + 0.5 * amp, hi: base + 0.9 * amp };
}

export type Crossing = { t: number; rising: boolean };

/** Mid-level crossings with hysteresis, in seconds from the first sample. */
export function crossings(v: ArrayLike<number>, dt: number, L: Levels): Crossing[] {
  const out: Crossing[] = [];
  let state: "low" | "high" | null = null;
  for (let i = 0; i < v.length; i++) {
    const x = v[i];
    if (state === null) {
      if (x <= L.lo) state = "low";
      else if (x >= L.hi) state = "high";
      continue;
    }
    if (state === "low" && x >= L.hi) {
      out.push({ t: interp(v, dt, i, L.mid, true), rising: true });
      state = "high";
    } else if (state === "high" && x <= L.lo) {
      out.push({ t: interp(v, dt, i, L.mid, false), rising: false });
      state = "low";
    }
  }
  return out;
}

/** Walk back from sample i to where the record crossed `level`, and interpolate. */
function interp(v: ArrayLike<number>, dt: number, i: number, level: number, rising: boolean): number {
  let j = i;
  while (j > 0 && (rising ? v[j - 1] >= level : v[j - 1] <= level)) j--;
  if (j === 0) return 0;
  const a = v[j - 1];
  const b = v[j];
  const f = b === a ? 0 : (level - a) / (b - a);
  return (j - 1 + f) * dt;
}

/** Time for the record to go from `from` to `to` around the crossing at t (rise or fall). */
function edgeTime(v: ArrayLike<number>, dt: number, c: Crossing, L: Levels): number | null {
  const i0 = Math.round(c.t / dt);
  const find = (level: number, dir: -1 | 1): number | null => {
    for (let j = i0; j > 0 && j < v.length; j += dir) {
      const a = v[j - 1];
      const b = v[j];
      if ((a - level) * (b - level) <= 0 && a !== b) return (j - 1 + (level - a) / (b - a)) * dt;
      if (Math.abs(j - i0) > v.length / 2) break;
    }
    return null;
  };
  const tLo = c.rising ? find(L.lo, -1) : find(L.lo, 1);
  const tHi = c.rising ? find(L.hi, 1) : find(L.hi, -1);
  if (tLo === null || tHi === null) return null;
  return Math.abs(tHi - tLo);
}

export type Measured = Record<string, number | null>;

/** Every single-source quantity the cross-check shows, keyed by the SCPI item name. */
export function measureAll(v: ArrayLike<number>, dt: number): Measured {
  const n = v.length;
  if (n < 4) return {};
  const e = extrema(v);
  const L = levels(v);
  const cx = crossings(v, dt, L);
  const rises = cx.filter((c) => c.rising);
  const falls = cx.filter((c) => !c.rising);
  const periodOf = (list: Crossing[]) => (list.length >= 2 ? (list[list.length - 1].t - list[0].t) / (list.length - 1) : null);
  const pr = periodOf(rises);
  const pf = periodOf(falls);
  const period = pr !== null && pf !== null ? (pr + pf) / 2 : (pr ?? pf);
  // Widths from each rise to the next fall (positive) and fall to next rise (negative).
  const widths = (a: Crossing[], b: Crossing[]) => {
    const w: number[] = [];
    for (const x of a) {
      const y = b.find((c) => c.t > x.t);
      if (y) w.push(y.t - x.t);
    }
    return w.length ? w.reduce((s, q) => s + q, 0) / w.length : null;
  };
  const pw = widths(rises, falls);
  const nw = widths(falls, rises);
  const rt = rises.map((c) => edgeTime(v, dt, c, L)).filter((x): x is number => x !== null);
  const ft = falls.map((c) => edgeTime(v, dt, c, L)).filter((x): x is number => x !== null);
  const avg = (a: number[]) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
  // RMS over whole periods only, like the instrument's "period RMS"
  let pvrms: number | null = null;
  if (period && rises.length >= 2) {
    const i0 = Math.round(rises[0].t / dt);
    const i1 = Math.round(rises[rises.length - 1].t / dt);
    let s2 = 0;
    for (let i = i0; i < i1; i++) s2 += v[i] * v[i];
    pvrms = i1 > i0 ? Math.sqrt(s2 / (i1 - i0)) : null;
  }
  const amp = L.top - L.base;
  let ac2 = 0;
  for (let i = 0; i < n; i++) ac2 += (v[i] - e.mean) ** 2;
  let area = 0;
  for (let i = 0; i < n; i++) area += v[i] * dt;
  let imax = 0;
  let imin = 0;
  for (let i = 1; i < n; i++) {
    if (v[i] > v[imax]) imax = i;
    if (v[i] < v[imin]) imin = i;
  }
  return {
    VMAX: e.max,
    VMIN: e.min,
    VPP: e.max - e.min,
    VTOP: L.top,
    VBASe: L.base,
    VAMP: amp,
    VAVG: e.mean,
    VRMS: e.rms,
    ACRMs: Math.sqrt(ac2 / n),
    PVRMs: pvrms,
    VUPPer: L.hi,
    VMID: L.mid,
    VLOWer: L.lo,
    OVERshoot: amp > 0 ? ((e.max - L.top) / amp) * 100 : null,
    PREShoot: amp > 0 ? ((L.base - e.min) / amp) * 100 : null,
    MARea: area,
    PERiod: period,
    FREQuency: period ? 1 / period : null,
    RTIMe: avg(rt),
    FTIMe: avg(ft),
    PWIDth: pw,
    NWIDth: nw,
    PDUTy: pw !== null && period ? (pw / period) * 100 : null,
    NDUTy: nw !== null && period ? (nw / period) * 100 : null,
    PSLewrate: avg(rt) ? (0.8 * amp) / avg(rt)! : null,
    NSLewrate: avg(ft) ? (-0.8 * amp) / avg(ft)! : null,
    TVMAX: imax * dt,
    TVMIN: imin * dt,
    PPULses: rises.length && falls.length ? Math.min(rises.length, falls.length) : 0,
    NPULses: rises.length && falls.length ? Math.min(rises.length, falls.length) : 0,
    PEDGes: rises.length,
    NEDGes: falls.length,
  };
}

/** Delay between the first rising (or falling) mid-level crossings of two records. */
export function delay(a: ArrayLike<number>, b: ArrayLike<number>, dt: number, edgeA: "R" | "F", edgeB: "R" | "F"): number | null {
  const ca = crossings(a, dt, levels(a)).find((c) => c.rising === (edgeA === "R"));
  if (!ca) return null;
  const cb = crossings(b, dt, levels(b)).find((c) => c.rising === (edgeB === "R") && c.t >= ca.t - 1e-15);
  return cb ? cb.t - ca.t : null;
}

/** Running statistics over a stream of readings (what the measurement table shows). */
export class Stats {
  n = 0;
  mean = 0;
  m2 = 0;
  min = Infinity;
  max = -Infinity;
  last: number | null = null;
  add(x: number | null): void {
    this.last = x;
    if (x === null || !Number.isFinite(x)) return;
    this.n++;
    const d = x - this.mean;
    this.mean += d / this.n;
    this.m2 += d * (x - this.mean);
    if (x < this.min) this.min = x;
    if (x > this.max) this.max = x;
  }
  get std(): number | null {
    return this.n > 1 ? Math.sqrt(this.m2 / (this.n - 1)) : null;
  }
  snapshot() {
    return { last: this.last, n: this.n, mean: this.n ? this.mean : null, min: this.n ? this.min : null, max: this.n ? this.max : null, std: this.std };
  }
}
