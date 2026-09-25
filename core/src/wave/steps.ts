// Knob arithmetic: the 1-2-5 sequence every scope uses for V/div and s/div,
// fine steps, and the offset range the MHO984 allows at a given scale.

import { C } from "../constants.ts";

const MANTISSAS = [1, 2, 5];

/** The 1-2-5 value one click away from `x` in direction `dir`. Off-sequence values snap to the neighbour. */
export function step125(x: number, dir: 1 | -1): number {
  if (!(x > 0)) return dir > 0 ? 1e-9 : 1e-9;
  const e = Math.floor(Math.log10(x) + 1e-9);
  const seq: number[] = [];
  for (let k = e - 1; k <= e + 1; k++) for (const m of MANTISSAS) seq.push(m * 10 ** k);
  const eps = x * 1e-6;
  if (dir > 0) return seq.find((v) => v > x + eps) ?? x * 2;
  for (let i = seq.length - 1; i >= 0; i--) if (seq[i] < x - eps) return seq[i];
  return x / 2;
}

/** The nearest 1-2-5 value. */
export function snap125(x: number): number {
  if (!(x > 0)) return x;
  const e = Math.floor(Math.log10(x));
  let best = x;
  let err = Infinity;
  for (let k = e - 1; k <= e + 1; k++)
    for (const m of MANTISSAS) {
      const v = m * 10 ** k;
      const d = Math.abs(Math.log(v / x));
      if (d < err) {
        err = d;
        best = v;
      }
    }
  return Number(best.toPrecision(3));
}

/** Fine adjustment (vernier): about 1 % of the value, rounded to 3 significant digits. */
export function stepFine(x: number, dir: 1 | -1): number {
  const next = x * (1 + dir * 0.01);
  return Number(next.toPrecision(3)) === Number(x.toPrecision(3)) ? x + dir * 10 ** (Math.floor(Math.log10(Math.abs(x) || 1)) - 2) : Number(next.toPrecision(3));
}

export const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

/** Guide §3.6.5: the offset range depends on V/div and input impedance. */
export function offsetLimit(scaleVdiv: number, impedance: "OMEG" | "FIFTy" | string, probe = 1): number {
  const table = impedance.toUpperCase().startsWith("FIF") ? C.instrument.offset_limits_50 : C.instrument.offset_limits_1m;
  const s = scaleVdiv / (probe || 1);
  for (const [upTo, lim] of table) if (s <= upTo * 1.0001) return lim * (probe || 1);
  return table[table.length - 1][1] * (probe || 1);
}

/** Guide §3.6.8: V/div range at the probe tip. */
export function scaleLimits(impedance: string, probe = 1): [number, number] {
  const fifty = impedance.toUpperCase().startsWith("FIF");
  const lo = fifty ? C.instrument.vscale_min_50 : C.instrument.vscale_min_1m;
  const hi = fifty ? C.instrument.vscale_max_50 : C.instrument.vscale_max_1m;
  return [lo * probe, hi * probe];
}

/** Channels on → per-channel sample-rate / memory mode index (single, half, full). Datasheet p. 11. */
export function channelMode(enabled: number): 0 | 1 | 2 {
  return enabled <= 1 ? 0 : enabled === 2 ? 1 : 2;
}
