// The simulated bench wired to the simulated MHO984:
//
//   GEN OUT 1 ──┬──────────────────────── CH1   (a BNC tee: the generator itself)
//               └── 2nd-order low-pass ── CH2   (the "device under test")
//   1 MHz 3.3 V clock with ringing ────── CH3
//   UART TX 115200 8N1 "MHO984\r\n" ───── CH4
//
// Every source is one period in a table, synthesised once when its settings
// change, then read with linear interpolation, so a 25 Mpt deep read costs no
// more per point than a screen read. Noise is a hash of (seed, channel,
// index), so a deep memory read in chunks sees the same record every time.

import { C } from "../core/src/constants.ts";
import { fft } from "../core/src/dsp/fft.ts";

export type Source = { period: number; table: Float32Array; mean: number };

const N = C.sim.table_points;

function tableOf(fn: (phase: number) => number): Source {
  const table = new Float32Array(N);
  let s = 0;
  for (let i = 0; i < N; i++) {
    table[i] = fn(i / N);
    s += table[i];
  }
  return { period: 1, table, mean: s / N };
}

export function sampleSource(src: Source, t: number): number {
  const x = t / src.period;
  const f = (x - Math.floor(x)) * N;
  const i = Math.floor(f);
  const a = src.table[i];
  const b = src.table[(i + 1) % N];
  return a + (b - a) * (f - i);
}

export type Awg = { on: boolean; fn: string; freq: number; amp: number; offset: number; duty: number; symmetry: number };

/** One period of the generator's waveform, amplitude in volts peak-to-peak about the offset. */
export function awgSource(g: Awg): Source {
  const A = g.amp / 2;
  const up = g.fn.toUpperCase();
  const shape = (p: number): number => {
    if (up.startsWith("SQU")) return p < g.duty / 100 ? 1 : -1;
    if (up.startsWith("RAMP")) {
      const s = Math.min(0.999, Math.max(0.001, g.symmetry / 100));
      return p < s ? -1 + (2 * p) / s : 1 - (2 * (p - s)) / (1 - s);
    }
    if (up.startsWith("DC")) return 0;
    if (up.startsWith("EXPR")) return 2 * (1 - Math.exp(-5 * p)) / (1 - Math.exp(-5)) - 1;
    if (up.startsWith("EXPF")) return 2 * Math.exp(-5 * p) - 1;
    if (up.startsWith("GAUS")) return 2 * Math.exp(-((p - 0.5) ** 2) / 0.005) - 1;
    if (up.startsWith("LOR")) return 2 / (1 + ((p - 0.5) / 0.03) ** 2) - 1;
    if (up.startsWith("HAV")) return -Math.cos(2 * Math.PI * p);
    if (up.startsWith("SINC")) {
      const x = (p - 0.5) * 20;
      return x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
    }
    if (up.startsWith("ECG")) return ecg(p);
    return Math.sin(2 * Math.PI * p); // SINusoid, NOISe base (noise added separately), ARB
  };
  const src = tableOf((p) => (g.on ? g.offset + A * shape(p) : 0));
  src.period = 1 / Math.max(g.freq, 1e-3);
  return src;
}

function ecg(p: number): number {
  const g = (c: number, w: number, a: number) => a * Math.exp(-(((p - c) / w) ** 2));
  return g(0.2, 0.025, 0.15) - g(0.37, 0.01, 0.1) + g(0.4, 0.012, 1) - g(0.43, 0.01, 0.25) + g(0.7, 0.05, 0.3) - 0.2;
}

/** H(f) of the DUT: second-order low-pass, corner fc, quality Q. */
export function dut(hz: number): { re: number; im: number } {
  const x = hz / C.sim.filter_fc_hz;
  const re = 1 - x * x;
  const im = x / C.sim.filter_q;
  const d = re * re + im * im;
  return { re: re / d, im: -im / d };
}

/** The DUT's output table for a periodic input: FFT, multiply by H(k·f0), inverse FFT. */
export function throughDut(input: Source): Source {
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  for (let i = 0; i < N; i++) re[i] = input.table[i];
  fft(re, im);
  const f0 = 1 / input.period;
  for (let k = 0; k < N; k++) {
    const kk = k <= N / 2 ? k : k - N; // negative frequencies take the conjugate response
    const h = dut(Math.abs(kk) * f0);
    const hi = kk < 0 ? -h.im : h.im;
    const r = re[k] * h.re - im[k] * hi;
    const m = re[k] * hi + im[k] * h.re;
    re[k] = r;
    im[k] = m;
  }
  // inverse via conjugation
  for (let k = 0; k < N; k++) im[k] = -im[k];
  fft(re, im);
  const table = new Float32Array(N);
  let s = 0;
  for (let i = 0; i < N; i++) {
    table[i] = re[i] / N;
    s += table[i];
  }
  return { period: input.period, table, mean: s / N };
}

export function clockSource(): Source {
  const { clock_hz, clock_v, clock_rise_s, clock_ring_hz, clock_ring_decay_s, clock_ring_fraction } = C.sim;
  const T = 1 / clock_hz;
  const src = tableOf((p) => {
    const t = p * T;
    const half = T / 2;
    const since = t < half ? t : t - half;
    const high = t < half;
    // exponential edge from the previous level, plus a damped ring
    const edge = 1 - Math.exp(-since / (clock_rise_s / Math.log(9)));
    const ring = clock_ring_fraction * Math.exp(-since / clock_ring_decay_s) * Math.sin(2 * Math.PI * clock_ring_hz * since);
    const level = high ? edge + ring : 1 - edge - ring;
    return clock_v * level;
  });
  src.period = T;
  return src;
}

export function uartSource(): Source {
  const { uart_baud, uart_text, uart_period_s, uart_v } = C.sim;
  const bits: number[] = [];
  for (const ch of uart_text) {
    const b = ch.charCodeAt(0);
    bits.push(0);
    for (let i = 0; i < 8; i++) bits.push((b >> i) & 1);
    bits.push(1);
  }
  const tb = 1 / uart_baud;
  const src = tableOf((p) => {
    const t = p * uart_period_s;
    const i = Math.floor(t / tb);
    return i < bits.length ? bits[i] * uart_v : uart_v;
  });
  src.period = uart_period_s;
  return src;
}

/** Characters of the UART burst whose start bit lies in [t0, t1) (for the bus-decode table). */
export function uartFrames(t0: number, t1: number): { t: number; byte: number }[] {
  const { uart_baud, uart_text, uart_period_s } = C.sim;
  const out: { t: number; byte: number }[] = [];
  const k0 = Math.floor(t0 / uart_period_s) - 1;
  for (let k = k0; k * uart_period_s < t1; k++) {
    for (let c = 0; c < uart_text.length; c++) {
      const t = k * uart_period_s + (c * 10) / uart_baud;
      if (t >= t0 && t < t1) out.push({ t, byte: uart_text.charCodeAt(c) });
    }
  }
  return out;
}

// ------------------------------------------------------------------ noise

/** A standard normal deviate from (seed, stream, index): stateless, so chunked reads agree. */
export function gauss(seed: number, stream: number, i: number): number {
  const u1 = (hash(seed, stream, 2 * i) + 1) / 4294967297;
  const u2 = hash(seed, stream, 2 * i + 1) / 4294967296;
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

function hash(a: number, b: number, c: number): number {
  let h = Math.imul(a | 0, 0x9e3779b1) ^ Math.imul(b | 0, 0x85ebca77) ^ Math.imul(c | 0, 0xc2b2ae3d);
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}
