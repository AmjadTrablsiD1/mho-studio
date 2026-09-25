// Amplitude spectrum of a time record, peaks, and harmonic distortion.
// Amplitudes are RMS volts (dBV = 20·log10(Vrms / 1 V)), so a 1 V-peak sine
// reads −3.01 dBV whatever window was used.

import { fft, nextPow2 } from "./fft.ts";
import { makeWindow, type WindowName } from "./window.ts";

export type Spectrum = {
  /** Bin spacing, Hz. */
  df: number;
  /** RMS volts per bin (one-sided). */
  vrms: Float64Array;
  window: WindowName;
  enbwHz: number;
  n: number;
};

/**
 * One-sided spectrum. The record is mean-removed only if `removeDc`, windowed,
 * zero-padded to a power of two, and scaled so a sine centred in a bin reads
 * its RMS value.
 */
export function spectrum(v: ArrayLike<number>, dt: number, window: WindowName = "hann", removeDc = false): Spectrum {
  const n0 = v.length;
  const n = nextPow2(n0);
  const win = makeWindow(window, n0);
  let mean = 0;
  if (removeDc) {
    for (let i = 0; i < n0; i++) mean += v[i];
    mean /= n0;
  }
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  for (let i = 0; i < n0; i++) re[i] = (v[i] - mean) * win.w[i];
  fft(re, im);
  const half = n / 2 + 1;
  const out = new Float64Array(half);
  // Peak amplitude of a bin-centred sine = 2|X|/(N0·CG); RMS = peak/√2. DC has no factor 2 and no √2.
  const k = 2 / (n0 * win.coherentGain);
  for (let i = 0; i < half; i++) {
    const mag = Math.hypot(re[i], im[i]);
    out[i] = i === 0 ? mag / (n0 * win.coherentGain) : (mag * k) / Math.SQRT2;
  }
  const df = 1 / (n * dt);
  return { df, vrms: out, window, enbwHz: win.enbwBins * (1 / (n0 * dt)), n };
}

export const dbv = (vrms: number) => 20 * Math.log10(Math.max(vrms, 1e-15));

export type Peak = { hz: number; vrms: number; dbv: number; bin: number };

/**
 * The strongest local maxima, largest first. Frequency is refined by a
 * parabola through the log magnitudes of the peak bin and its neighbours.
 */
export function peaks(s: Spectrum, count: number, minBin = 2, floorDbv = -140): Peak[] {
  const m = s.vrms;
  const found: Peak[] = [];
  for (let i = Math.max(1, minBin); i < m.length - 1; i++) {
    if (m[i] > m[i - 1] && m[i] >= m[i + 1] && dbv(m[i]) > floorDbv) {
      const a = dbv(m[i - 1]);
      const b = dbv(m[i]);
      const c = dbv(m[i + 1]);
      const den = a - 2 * b + c;
      const d = den !== 0 ? (0.5 * (a - c)) / den : 0;
      found.push({ hz: (i + d) * s.df, vrms: m[i], dbv: b, bin: i });
    }
  }
  found.sort((x, y) => y.vrms - x.vrms);
  // Keep one peak per lobe: drop maxima within 3 bins of a stronger one.
  const kept: Peak[] = [];
  for (const p of found) {
    if (kept.every((k) => Math.abs(k.bin - p.bin) > 3)) kept.push(p);
    if (kept.length >= count) break;
  }
  return kept;
}

/** Power in a few bins around `bin` (the window spreads a tone over its main lobe). */
function tonePower(s: Spectrum, bin: number, halfWidth: number): number {
  let p = 0;
  for (let i = Math.max(1, bin - halfWidth); i <= Math.min(s.vrms.length - 1, bin + halfWidth); i++) p += s.vrms[i] ** 2;
  // Summing bins over-counts by the window's noise bandwidth; divide it back out.
  const enbwBins = s.enbwHz / s.df;
  return p / enbwBins;
}

export type Harmonics = {
  fundamentalHz: number;
  thdPct: number | null;
  thdDb: number | null;
  list: { order: number; hz: number; dbv: number; dbc: number }[];
  /** Why THD is null when it is: the fundamental sits too few bins above DC to separate its harmonics. */
  note: string | null;
};

/** The window's main-lobe half-width in bins: power within it belongs to one tone. */
export function lobeBins(w: WindowName): number {
  return w === "rect" ? 1 : w === "hann" ? 2 : 4;
}

/**
 * THD from the strongest non-DC peak and its harmonics below Nyquist.
 * Each harmonic is searched within ±1 bin of k·f0, and only when it lies at
 * least two main lobes away from the fundamental — otherwise the fundamental's
 * own skirt would be counted as distortion. Too coarse a spectrum gives
 * thdPct = null and says why.
 */
export function harmonics(s: Spectrum, count: number): Harmonics | null {
  const lobe = lobeBins(s.window);
  const minBin = 2 * lobe + 2;
  // The strongest bin above DC, wherever it is: if it is too close to DC to be
  // separated, refuse rather than take the next peak up for the fundamental.
  let top = 1;
  for (let i = 2; i < s.vrms.length; i++) if (s.vrms[i] > s.vrms[top]) top = i;
  if (top < minBin) {
    return { fundamentalHz: top * s.df, thdPct: null, thdDb: null, list: [], note: `the fundamental is only ${top} bin${top === 1 ? "" : "s"} above DC; THD needs at least ${minBin} (read more points: deep memory, or a slower timebase)` };
  }
  const [f] = peaks(s, 1, minBin);
  if (!f) return null;
  const p1 = tonePower(s, f.bin, lobe);
  const list: Harmonics["list"] = [];
  let ph = 0;
  for (let h = 2; h <= count; h++) {
    const target = f.hz * h;
    const bin = Math.round(target / s.df);
    if (bin >= s.vrms.length - lobe) break;
    let best = bin;
    for (let i = bin - 1; i <= bin + 1; i++) if (i > 0 && i < s.vrms.length && s.vrms[i] > s.vrms[best]) best = i;
    const p = tonePower(s, best, lobe);
    ph += p;
    list.push({ order: h, hz: best * s.df, dbv: dbv(Math.sqrt(p)), dbc: 10 * Math.log10(p / p1) });
  }
  const thd = list.length ? Math.sqrt(ph / p1) : null;
  return { fundamentalHz: f.hz, thdPct: thd === null ? null : thd * 100, thdDb: thd === null ? null : 20 * Math.log10(thd), list, note: list.length ? null : "no harmonic below Nyquist" };
}
