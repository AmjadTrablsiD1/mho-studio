// Edge finding and rise/fall times, with numbers checked by hand.

import { test } from "node:test";
import assert from "node:assert/strict";
import { findEdges, histogram, levelsFrom, mergeSummaries, setupHold, Summer, type Edge } from "../src/dsp/edges.ts";

const close = (a: number, b: number, tol: number, what = "") => assert.ok(Math.abs(a - b) <= tol, `${what} ${a} ≠ ${b} (±${tol})`);

/** Piecewise-linear signal from (time, volts) corners, sampled every dt from 0 to tEnd. */
function pwl(points: [number, number][], dt: number, tEnd: number): Float32Array {
  const n = Math.round(tEnd / dt) + 1;
  const out = new Float32Array(n);
  let k = 0;
  for (let i = 0; i < n; i++) {
    const t = i * dt;
    while (k < points.length - 2 && t > points[k + 1][0]) k++;
    const [ta, va] = points[k];
    const [tb, vb] = points[k + 1];
    out[i] = t <= ta ? va : t >= tb ? vb : va + ((vb - va) * (t - ta)) / (tb - ta);
  }
  return out;
}

/**
 * Linear edges: a ramp of length T from 0 to 1 V crosses 10 % at 0.1·T and 90 %
 * at 0.9·T, so its 10–90 % time is 0.8·T; linear interpolation is exact on a ramp.
 *  Example 1: T = 10 ns rising, sampled every 1 ns   → 8 ns, 50 % at start + 5 ns.
 *  Example 2: T = 20 ns falling, sampled every 0.5 ns → 16 ns, 50 % at start + 10 ns.
 */
test("linear edges: 10–90 % is 0.8 × the ramp (two worked examples)", () => {
  const v = pwl([[0, 0], [100e-9, 0], [110e-9, 1], [300e-9, 1], [320e-9, 0], [500e-9, 0]], 0.5e-9, 500e-9);
  const r = findEdges(v, 0.5e-9, 0, { levels: levelsFrom(0, 1) });
  assert.equal(r.counts.rise, 1);
  assert.equal(r.counts.fall, 1);
  const [up, down] = r.edges;
  close(up.dur, 8e-9, 1e-12, "rise");
  close(up.t, 105e-9, 1e-12, "rise 50 %");
  close(down.dur, 16e-9, 1e-12, "fall");
  close(down.t, 310e-9, 1e-12, "fall 50 %");
  // Sampled at 1 ns the 10 ns ramp still gives exactly 8 ns.
  const coarse = findEdges(pwl([[0, 0], [100e-9, 0], [110e-9, 1], [200e-9, 1]], 1e-9, 200e-9), 1e-9, 0, { levels: levelsFrom(0, 1) });
  close(coarse.edges[0].dur, 8e-9, 1e-12, "rise at 1 ns");
});

/**
 * RC edges: v = 1 − e^(−t/τ) reaches 10 % at τ·ln(10/9) and 90 % at τ·ln 10, so
 * 10–90 % = τ·ln 9 ≈ 2.197·τ.
 *  Example 1: τ = 10 ns, dt = 0.1 ns → 21.97 ns.
 *  Example 2: τ = 1 µs,  dt = 10 ns  → 2.197 µs.
 */
test("RC edges: 10–90 % = τ·ln 9 (two worked examples)", () => {
  for (const [tau, dt] of [[10e-9, 0.1e-9], [1e-6, 10e-9]]) {
    const n = Math.round((20 * tau) / dt);
    const v = new Float32Array(n);
    for (let i = 0; i < n; i++) v[i] = i < n / 4 ? 0 : 1 - Math.exp(-((i - n / 4) * dt) / tau);
    const r = findEdges(v, dt, 0, { levels: levelsFrom(0, 1) });
    assert.equal(r.counts.rise, 1);
    close(r.edges[0].dur, tau * Math.log(9), tau * 0.002, `τ = ${tau}`);
  }
});

test("a burst that comes once: every edge, its time from the trigger, no false edges from noise or ringing", () => {
  // Idle low, then three 3.3 V pulses of 1 µs with 5 ns linear edges every 2 µs, then idle; ±3 % noise and a ringing overshoot.
  const dt = 0.5e-9;
  const t0 = -1e-6; // the record starts 1 µs before the trigger
  const corners: [number, number][] = [[0, 0]];
  for (let k = 0; k < 3; k++) {
    const s = 2e-6 + k * 2e-6;
    corners.push([s, 0], [s + 5e-9, 3.3], [s + 1e-6, 3.3], [s + 1e-6 + 5e-9, 0]);
  }
  corners.push([12e-6, 0]);
  const v = pwl(corners, dt, 12e-6);
  let seed = 7;
  for (let i = 0; i < v.length; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    v[i] += ((seed / 0x7fffffff) * 2 - 1) * 0.1;
  }
  // Ringing after the first rise: up to +30 % and back, without dropping below 90 %.
  for (let i = 0; i < 100; i++) v[Math.round((2e-6 + 5e-9) / dt) + i] += 1 * Math.exp(-i / 20) * Math.sin(i / 3);
  const r = findEdges(v, dt, t0, { levels: levelsFrom(0, 3.3) });
  assert.equal(r.counts.rise, 3, "three rising edges");
  assert.equal(r.counts.fall, 3, "three falling edges");
  // 50 % times relative to the trigger: 2 µs + 2.5 ns − 1 µs = 1.0025 µs, then every 2 µs.
  for (let k = 0; k < 3; k++) close(r.edges[2 * k].t, 1.0025e-6 + k * 2e-6, 1e-9, `rise ${k}`);
  close(r.rises.mean!, 4e-9, 0.6e-9, "mean rise (5 ns ramp, ±0.1 V noise)");
  close(r.periods.mean!, 2e-6, 1e-9, "period");
  assert.equal(r.counts.under, 0);
});

test("under-sampled edges are flagged; a flat record has no edges", () => {
  // A step sampled every 10 ns: the edge falls between two samples.
  const v = Float32Array.from({ length: 100 }, (_, i) => (i < 50 ? 0 : 1));
  const r = findEdges(v, 10e-9, 0, { levels: levelsFrom(0, 1) });
  assert.equal(r.counts.rise, 1);
  assert.equal(r.edges[0].under, true);
  const flat = findEdges(new Float32Array(1000).fill(0.2), 1e-9);
  assert.equal(flat.flat, true);
  assert.equal(flat.edges.length, 0);
});

test("summaries: n, min, mean, max and sample standard deviation", () => {
  const s = new Summer();
  for (const x of [2, 4, 4, 4, 5, 5, 7, 9]) s.add(x);
  const r = s.summary;
  assert.equal(r.n, 8);
  assert.equal(r.min, 2);
  assert.equal(r.max, 9);
  assert.equal(r.mean, 5);
  close(r.std!, Math.sqrt(32 / 7), 1e-12, "sample σ");
  assert.deepEqual(new Summer().summary, { n: 0, min: null, mean: null, max: null, std: null });
  // Two halves merged give the summary of the whole set (segments are analysed one by one, then merged).
  const a = new Summer();
  const b = new Summer();
  for (const x of [2, 4, 4, 4]) a.add(x);
  for (const x of [5, 5, 7, 9]) b.add(x);
  const m = mergeSummaries([a.summary, b.summary, new Summer().summary]);
  assert.equal(m.n, 8);
  assert.equal(m.min, 2);
  assert.equal(m.max, 9);
  close(m.mean!, 5, 1e-12, "merged mean");
  close(m.std!, Math.sqrt(32 / 7), 1e-12, "merged σ");
  // A spread of a millionth of the mean: 1 ms periods with ±1 ps on them. σ of (−1, +1, −1, +1) ps is 1.1547 ps.
  const j = new Summer();
  for (const x of [-1, 1, -1, 1]) j.add(1e-3 + x * 1e-12);
  close(j.summary.std!, 1.1547e-12, 1e-16, "σ of picoseconds on milliseconds");
  const j2 = new Summer();
  for (const x of [-1, 1, -1, 1]) j2.add(1e-3 + x * 1e-12);
  close(mergeSummaries([j.summary, j2.summary]).std!, Math.sqrt(8 / 7) * 1e-12, 1e-16, "merged");
});

/**
 * Runts: linear 10 ns ramps between 0 and 3.3 V, sampled every 1 ns (50 % = 1.65 V).
 *  High runt: 0 → 2.0 V (400–410 ns), held, → 0 (430–440 ns). It crosses 1.65 V going up at
 *    400 + 10·1.65/2.0 = 408.25 ns and going down at 430 + 10·0.35/2.0 = 431.75 ns: width 23.5 ns, peak 2.0 V.
 *  Low runt: 3.3 → 1.2 V (700–710 ns), held, → 3.3 V (730–740 ns). Down through 1.65 V at
 *    700 + 10·1.65/2.1 = 707.857 ns, back up at 730 + 10·0.45/2.1 = 732.143 ns: width 24.286 ns, trough 1.2 V.
 * Neither is an edge: the edges are the full swings at 100 (rise), 300 (fall) and 600 ns (rise).
 */
test("runts: a swing past 50 % that turns back before 90 % (two worked examples)", () => {
  const v = pwl([[0, 0], [100e-9, 0], [110e-9, 3.3], [300e-9, 3.3], [310e-9, 0], [400e-9, 0], [410e-9, 2.0], [430e-9, 2.0], [440e-9, 0], [600e-9, 0], [610e-9, 3.3], [700e-9, 3.3], [710e-9, 1.2], [730e-9, 1.2], [740e-9, 3.3], [900e-9, 3.3]], 1e-9, 900e-9);
  const r = findEdges(v, 1e-9, 0, { levels: levelsFrom(0, 3.3) });
  assert.deepEqual([r.counts.rise, r.counts.fall, r.counts.runt], [2, 1, 2]);
  const [hi, lo] = r.anomalies;
  assert.equal(hi.kind, "runt");
  assert.equal(hi.polarity, "high");
  close(hi.t, 408.25e-9, 1e-12, "high runt start");
  close(hi.width!, 23.5e-9, 1e-12, "high runt width");
  close(hi.peak!, 2.0, 1e-6, "high runt peak");
  assert.equal(lo.polarity, "low");
  close(lo.t, 707.857e-9, 1e-12, "low runt start");
  close(lo.width!, 24.286e-9, 1e-12, "low runt width");
  close(lo.peak!, 1.2, 1e-6, "low runt trough");
});

/**
 * Pulses and glitches: 5 ns ramps, 50 % crossings 2.5 ns into each ramp.
 *  High pulses: 100→300 ns (200 ns) and 500→520 ns (20 ns, the glitch); low pulse 300→500 ns (200 ns).
 *  With glitchS = 50 ns only the 20 ns pulse is a glitch; without it, none is flagged.
 */
test("pulse widths and glitches narrower than a given width", () => {
  const v = pwl([[0, 0], [100e-9, 0], [105e-9, 3.3], [300e-9, 3.3], [305e-9, 0], [500e-9, 0], [505e-9, 3.3], [520e-9, 3.3], [525e-9, 0], [700e-9, 0]], 0.5e-9, 700e-9);
  const r = findEdges(v, 0.5e-9, 0, { levels: levelsFrom(0, 3.3), glitchS: 50e-9 });
  assert.equal(r.pulses.high.n, 2);
  close(r.pulses.high.min!, 20e-9, 1e-12, "narrowest high pulse");
  close(r.pulses.high.max!, 200e-9, 1e-12, "widest high pulse");
  close(r.pulses.low.mean!, 200e-9, 1e-12, "low pulse");
  assert.equal(r.counts.glitch, 1);
  assert.equal(r.anomalies[0].polarity, "high");
  close(r.anomalies[0].t, 502.5e-9, 1e-12, "glitch start");
  close(r.anomalies[0].width!, 20e-9, 1e-12, "glitch width");
  assert.equal(findEdges(v, 0.5e-9, 0, { levels: levelsFrom(0, 3.3) }).counts.glitch, 0);
});

test("histogram: equal bins from the smallest to the largest value", () => {
  const h = histogram([1, 2, 2, 3, 4, 4, 4, 5], 4);
  assert.equal(h.lo, 1);
  assert.equal(h.hi, 5);
  // Bins of width 1: [1,2) [2,3) [3,4) [4,5] → 1, 2, 1, 4.
  assert.deepEqual(h.counts, [1, 2, 1, 4]);
  assert.deepEqual(histogram([7, 7, 7]).counts, [3]);
  assert.deepEqual(histogram([]).counts, []);
});

/**
 * Setup and hold, SPI mode 0 worked by hand: the clock rises at 50 + 100·k ns (k = 0…7) and falls
 * half-way; the data line changes 3 ns after the falling edges at 100, 300, 400 and 700 ns, i.e. at
 * 103, 303, 403 and 703 ns. Sampling on the rising edges:
 *   clock   50: no data edge before → setup —;  hold 103 −  50 =  53
 *   clock  150: setup 150 − 103 =  47;  hold 303 − 150 = 153
 *   clock  250: setup 147;  hold  53      clock 350: setup  47;  hold  53
 *   clock  450: setup  47;  hold 253      clock 550: setup 147;  hold 153
 *   clock  650: setup 247;  hold  53      clock 750: setup  47;  hold —
 * Worst setup 47 ns (at 150, 350, 450 and 750 ns), worst hold 53 ns (at 50, 250, 350 and 650 ns).
 */
test("setup and hold of a data line against a clock (worked example)", () => {
  const e = (t: number, kind: "rise" | "fall"): Edge => ({ i: 0, t: t * 1e-9, kind, dur: 1e-9, under: false });
  const clock: Edge[] = [];
  for (let k = 0; k < 8; k++) clock.push(e(50 + 100 * k, "rise"), e(100 + 100 * k, "fall"));
  const data = [e(103, "rise"), e(303, "fall"), e(403, "rise"), e(703, "fall")];
  const r = setupHold(clock, data, "rise");
  assert.equal(r.rows.length, 8);
  const ns = (x: number | null) => (x === null ? null : Math.round(x * 1e9 * 1000) / 1000);
  assert.deepEqual(r.rows.map((x) => [ns(x.setup), ns(x.hold)]), [[null, 53], [47, 153], [147, 53], [47, 53], [47, 253], [147, 153], [247, 53], [47, null]]);
  assert.equal(r.setup.n, 7);
  assert.equal(r.hold.n, 7);
  close(r.worstSetup!.setup!, 47e-9, 1e-15, "worst setup");
  assert.ok([150, 350, 450, 750].includes(ns(r.worstSetup!.t)!), "where the setup is smallest");
  close(r.worstHold!.hold!, 53e-9, 1e-15, "worst hold");
  assert.ok([50, 250, 350, 650].includes(ns(r.worstHold!.t)!), "where the hold is smallest");
  // On the falling edges instead: a data change 3 ns after each one leaves 3 ns of hold.
  close(setupHold(clock, data, "fall").worstHold!.hold!, 3e-9, 1e-15, "hold after a falling edge");
});
