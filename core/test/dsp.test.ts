// Every formula gets two independent worked examples (rule 15): one closed
// form, and a second case with different numbers or a different method.

import { test } from "node:test";
import assert from "node:assert/strict";
import { fft } from "../src/dsp/fft.ts";
import { dbv, harmonics, peaks, spectrum } from "../src/dsp/spectrum.ts";
import { makeWindow } from "../src/dsp/window.ts";
import { crossings, levels, measureAll, delay, Stats } from "../src/dsp/measure.ts";
import { phasor, wrapDeg } from "../src/dsp/lockin.ts";
import { corner, plan, point, timebaseFor, unwrap } from "../src/dsp/bode.ts";
import { minmax } from "../src/dsp/decimate.ts";

const near = (a: number, b: number, tol: number, msg = "") => assert.ok(Math.abs(a - b) <= tol, `${msg} ${a} vs ${b} (±${tol})`);

test("fft: a unit impulse is flat; a bin-centred cosine is two lines of N/2", () => {
  const n = 64;
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  re[0] = 1;
  fft(re, im);
  for (let i = 0; i < n; i++) near(Math.hypot(re[i], im[i]), 1, 1e-12);
  const re2 = new Float64Array(n).map((_, i) => Math.cos((2 * Math.PI * 5 * i) / n));
  const im2 = new Float64Array(n);
  fft(re2, im2);
  near(re2[5], n / 2, 1e-9);
  near(re2[n - 5], n / 2, 1e-9);
  near(Math.hypot(re2[6], im2[6]), 0, 1e-9);
});

test("window constants match the published values", () => {
  near(makeWindow("hann", 4096).coherentGain, 0.5, 1e-3);
  near(makeWindow("hann", 4096).enbwBins, 1.5, 1e-3);
  near(makeWindow("blackman-harris", 4096).enbwBins, 2.0044, 2e-3);
  near(makeWindow("flattop", 4096).enbwBins, 3.77, 0.01);
});

test("spectrum reads a sine's RMS: 1 V peak → −3.01 dBV (bin-centred, hann)", () => {
  const n = 1024;
  const dt = 1e-6;
  const f = (64 / n) / dt;
  const v = Float64Array.from({ length: n }, (_, i) => Math.sin(2 * Math.PI * f * i * dt));
  const s = spectrum(v, dt, "hann");
  const [p] = peaks(s, 1);
  near(p.hz, f, s.df * 0.01);
  near(p.dbv, -3.0103, 0.01);
});

test("spectrum, second example: 0.2 V peak off-bin with flat top reads −16.99 dBV within 0.02 dB", () => {
  const n = 1000; // not a power of two: zero-padded to 1024
  const dt = 2e-9;
  const f = 37.3e6;
  const v = Float64Array.from({ length: n }, (_, i) => 0.2 * Math.cos(2 * Math.PI * f * i * dt + 0.4));
  const s = spectrum(v, dt, "flattop");
  const [p] = peaks(s, 1);
  near(p.dbv, 20 * Math.log10(0.2 / Math.SQRT2), 0.02);
  near(p.hz, f, 2 * s.df);
});

test("THD of a sine plus a known 3rd harmonic", () => {
  const n = 4096;
  const dt = 1e-5;
  const f = (100 / n) / dt;
  // 1 V fundamental, 0.05 V 3rd, 0.02 V 5th → THD = √(0.05²+0.02²) = 5.385 %
  const v = Float64Array.from({ length: n }, (_, i) => {
    const t = i * dt;
    return Math.sin(2 * Math.PI * f * t) + 0.05 * Math.sin(2 * Math.PI * 3 * f * t) + 0.02 * Math.sin(2 * Math.PI * 5 * f * t);
  });
  const h = harmonics(spectrum(v, dt, "blackman-harris"), 7)!;
  near(h.fundamentalHz, f, 1);
  near(h.thdPct!, Math.hypot(0.05, 0.02) * 100, 0.02);
  const h3 = h.list.find((x) => x.order === 3)!;
  near(h3.dbc, 20 * Math.log10(0.05), 0.05);
  near(dbv(1), 0, 1e-12);
});

test("THD refuses a spectrum too coarse to separate the harmonics, instead of reporting the skirt", () => {
  // The case seen in the app: a 5 kHz tone, 1000 points at 1 µs → the tone is 5 bins above DC.
  for (const dt of [1e-6, 2e-7]) {
    const v = Float64Array.from({ length: 1000 }, (_, i) => Math.sin(2 * Math.PI * 5000 * i * dt));
    const h = harmonics(spectrum(v, dt, "hann"), 10)!;
    assert.equal(h.thdPct, null, `dt ${dt}`);
    assert.match(h.note!, /above DC/);
  }
  // …while the same tone with ten times the record is measured, and clean.
  const dt = 1e-6;
  const v = Float64Array.from({ length: 10000 }, (_, i) => Math.sin(2 * Math.PI * 5000 * i * dt));
  const h = harmonics(spectrum(v, dt, "hann"), 10)!;
  assert.ok(h.thdPct !== null && h.thdPct < 0.1, `thd ${h.thdPct}`);
});

// A square wave with exponential (RC) edges: every quantity has a closed form.
function rcSquare(n: number, dt: number, period: number, duty: number, tau: number, lo: number, hi: number): Float64Array {
  const v = new Float64Array(n);
  let x = lo;
  for (let i = 0; i < n; i++) {
    const phase = ((i * dt) % period) / period;
    const target = phase < duty ? hi : lo;
    x += (target - x) * (1 - Math.exp(-dt / tau));
    v[i] = x;
  }
  return v;
}

test("measure: RC square — frequency, duty, 10–90 % rise = τ·ln 9", () => {
  const dt = 1e-9;
  const period = 1e-6; // 1 MHz
  const tau = 10e-9;
  const v = rcSquare(20000, dt, period, 0.3, tau, 0, 3.3);
  const m = measureAll(v, dt);
  near(m.FREQuency!, 1e6, 1e6 * 1e-3, "freq");
  near(m.PDUTy!, 30, 0.3, "duty");
  near(m.RTIMe!, tau * Math.log(9), 1e-9, "rise");
  near(m.FTIMe!, tau * Math.log(9), 1e-9, "fall");
  near(m.VTOP!, 3.3, 0.05, "top");
  near(m.VBASe!, 0, 0.05, "base");
});

test("measure, second example: a sine — Vpp = 2A, Vrms = A/√2, period from crossings", () => {
  const dt = 1e-7;
  const A = 0.7;
  const f = 12.5e3;
  const v = Float64Array.from({ length: 8000 }, (_, i) => 0.1 + A * Math.sin(2 * Math.PI * f * i * dt));
  const m = measureAll(v, dt);
  near(m.VPP!, 2 * A, 1e-3);
  near(m.ACRMs!, A / Math.SQRT2, 2e-3);
  near(m.VAVG!, 0.1, 2e-3);
  near(m.PERiod!, 1 / f, 1e-9);
  const L = levels(v);
  assert.ok(crossings(v, dt, L).length >= 18);
});

test("delay between two edges", () => {
  const dt = 1e-9;
  const a = rcSquare(5000, dt, 1e-6, 0.5, 2e-9, 0, 1);
  const shift = 137;
  const b = new Float64Array(5000);
  for (let i = 0; i < 5000; i++) b[i] = a[Math.max(0, i - shift)];
  near(delay(a, b, dt, "R", "R")!, shift * dt, 1e-9);
});

test("lock-in: amplitude and phase of a known component, with DC and a second tone present", () => {
  const dt = 1e-6;
  const f = 1234;
  const n = 4000; // ≈ 4.9 periods, not an integer number
  const v = Float64Array.from({ length: n }, (_, i) => 0.3 + 0.8 * Math.cos(2 * Math.PI * f * i * dt - 0.7) + 0.2 * Math.cos(2 * Math.PI * 5 * f * i * dt));
  const p = phasor(v, dt, f);
  near(p.amp, 0.8, 0.8 * 0.005);
  near(p.phaseRad, -0.7, 0.01);
  near(wrapDeg(190), -170, 1e-9);
  near(wrapDeg(-540), 180, 1e-9);
});

test("bode: first-order RC analysed from its own phasors — −3 dB and −45° at fc", () => {
  const fc = 20e3;
  const freqs = plan(100, 1e6, 41, "log");
  near(freqs[0], 100, 1e-9);
  near(freqs[40], 1e6, 1e-6);
  const pts = freqs.map((hz) => {
    const x = hz / fc;
    const mag = 1 / Math.sqrt(1 + x * x);
    return point(hz, { amp: 1, phaseRad: 0 }, { amp: mag, phaseRad: -Math.atan(x) });
  });
  const c = corner(pts)!;
  near(c.hz, fc, fc * 0.02);
  near(c.phaseDeg, -45, 1);
  near(timebaseFor(1000, 4, 10), 4e-4, 1e-12);
});

test("bode, second example: second-order low-pass phase unwraps past −180°", () => {
  const raw = [-10, -90, -170, 170, 100];
  assert.deepEqual(unwrap(raw), [-10, -90, -170, -190, -260]);
  // gain that never drops 3 dB has no corner
  assert.equal(corner([point(1, { amp: 1, phaseRad: 0 }, { amp: 1, phaseRad: 0 }), point(10, { amp: 1, phaseRad: 0 }, { amp: 0.9, phaseRad: 0 })]), null);
});

test("min/max decimation keeps a one-sample glitch", () => {
  const v = new Float32Array(100000);
  v[54321] = 5;
  const d = minmax(v, 0, v.length, 1000);
  assert.equal(Math.max(...d.max), 5);
  const small = minmax(new Float32Array([1, 2, 3]), 0, 3, 1000);
  assert.equal(small.min.length, 3);
});

test("running statistics agree with the textbook sample std", () => {
  const s = new Stats();
  for (const x of [2, 4, 4, 4, 5, 5, 7, 9]) s.add(x);
  near(s.mean, 5, 1e-12);
  near(s.std!, Math.sqrt(32 / 7), 1e-12);
  s.add(null);
  assert.equal(s.n, 8);
});
