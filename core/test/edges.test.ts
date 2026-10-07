// Edge finding and rise/fall times, with numbers checked by hand.

import { test } from "node:test";
import assert from "node:assert/strict";
import { findEdges, levelsFrom, Summer } from "../src/dsp/edges.ts";

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
});
