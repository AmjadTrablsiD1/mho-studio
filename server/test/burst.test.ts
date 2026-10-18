// Edge capture on both families: one trigger, one record, every edge measured.
// The simulated clock (RIGOL CH3, LeCroy CH2) is 1 MHz, 3.3 V, with exponential
// edges (4 ns without ringing) plus ringing; the reference rise time is that of
// the same signal evaluated every 5 ps, so the test checks the capture, not a
// guess about the waveform.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.MHO_STUDIO_HOME = mkdtempSync(join(tmpdir(), "mho-studio-burst-"));
process.env.MHO_STUDIO_NO_USB = "1"; // never touch a real instrument on this computer's USB

const { ScopeService } = await import("../scope.ts");
const { DeepStore } = await import("../deep.ts");
const { BurstRunner, checkBurst, up125 } = await import("../burst.ts");
const { C } = await import("../../core/src/constants.ts");
const { clockSource, sampleSource } = await import("../../sim/bench.ts");
const { findEdges } = await import("../../core/src/dsp/edges.ts");

/** The clock's true 10–90 % times: 3 periods evaluated every 5 ps. */
const truth = (() => {
  const src = clockSource();
  const dt = 5e-12;
  const v = Float32Array.from({ length: Math.round(3e-6 / dt) }, (_, i) => sampleSource(src, i * dt));
  const r = findEdges(v, dt, 0);
  return { rise: r.rises.mean!, fall: r.falls.mean! };
})();

const scope = new ScopeService(() => {});
const deep = new DeepStore();
const runner = new BurstRunner(deep);
after(async () => {
  await scope.disconnect();
});

const close = (a: number, b: number, tol: number, what = "") => assert.ok(Math.abs(a - b) <= tol, `${what} ${a} ≠ ${b} (±${tol})`);

test("the window is rounded up to a 1-2-5 timebase", () => {
  assert.equal(up125(1.1e-6), 2e-6);
  assert.equal(up125(2e-6), 2e-6);
  assert.equal(up125(5.01e-3), 1e-2);
});

test("configuration is checked before anything is sent", () => {
  assert.throws(() => checkBurst({ trigger: 7 }), /trigger channel/);
  assert.throws(() => checkBurst({ segments: 0 }), /segments/);
  assert.throws(() => checkBurst({ glitchS: -1 }), /glitch/);
  assert.throws(() => checkBurst({ trigger: 2, channels: [2], timing: { clock: 2, edge: "rise", setupMin: null, holdMin: null } }), /data channel/);
  assert.throws(() => checkBurst({ windowS: 0 }), /window/);
  assert.throws(() => checkBurst({ base: 0 }), /both base and top/);
  const c = checkBurst({ trigger: 3, channels: [3, 1, 3] });
  assert.deepEqual(c.channels, [1, 3]);
  assert.equal(c.slope, "rise");
});

for (const family of ["rigol", "lecroy"] as const) {
  const clock = family === "rigol" ? 3 : 2;
  test(`${family}: one trigger on the clock, 10 µs after it, every rising edge's 10–90 % time`, async () => {
    await scope.connect({ sim: true, simModel: family });
    // Only the clock on: the most sample rate per channel.
    for (const ch of [1, 2, 3, 4]) if (ch !== clock) await scope.write(`channel.display@${ch}`, false);
    const s = await runner.run(scope, checkBurst({ trigger: clock, level: C.sim.clock_v / 2, windowS: 10e-6, waitS: 5, channels: [clock], maxPoints: 1_000_000 }), () => {});
    assert.equal(s.phase, "done", s.error ?? "");
    // CH3 is off at the simulated MHO984's power-on: switched on for the capture, and the result says so.
    if (family === "rigol") assert.ok(s.notes.some((n) => /^CH3 was off and switched on for the capture.*it stays on/.test(n)), s.notes.join(" | "));
    const r = s.results[0];
    assert.equal(r.ch, clock);
    // 10 µs asked → 2 µs/div, 18 µs after the trigger and 2 µs before it: 1 MHz gives about 20 rising edges.
    assert.equal(s.setup!.timeDiv, 2e-6);
    assert.ok(r.counts.rise >= 19 && r.counts.rise <= 21, `rises ${r.counts.rise}`);
    assert.ok(Math.abs(r.counts.fall - r.counts.rise) <= 1);
    // RIGOL samples every 0.5 ns here, LeCroy every 25 ps: both well inside the edge.
    close(r.rises.mean!, truth.rise, 0.3e-9, "mean rise");
    close(r.falls.mean!, truth.fall, 0.3e-9, "mean fall");
    close(r.periods.mean!, 1 / C.sim.clock_hz, 2e-9, "period");
    assert.equal(r.counts.under, 0, "4 ns edges are well sampled");
    assert.equal(r.offScreen, false, "the clock fits its screen");
    // The triggering edge is at t = 0: the first rising edge at or after the trigger is there.
    const first = r.edges.find((e) => e.kind === "rise" && e.t > -50e-9)!;
    close(first.t, 0, 2e-9, "trigger edge time");
    // The instrument is left stopped on the event, and the record is in deep memory.
    assert.equal(await scope.drv.status(), "STOP");
    // Every point of the record, no more: rate × span (40 k at 2 GS/s on the RIGOL, 800 k at 40 GS/s on the LeCroy).
    assert.ok(deep.meta && Math.abs(deep.meta.points - s.setup!.points!) <= s.setup!.points! * 0.01, `read ${deep.meta?.points} of ${s.setup!.points}`);
    const csv = [...runner.csv()].join("");
    assert.match(csv, /^channel,segment,edge,kind,time_s,duration_s,under_sampled$/m);
    assert.equal(csv.trim().split("\n").length - 2, r.counts.rise + r.counts.fall);
    // The histograms hold every edge; the slowest edge is the largest rise time; a clean clock has no runts.
    assert.equal(r.hist.rise.counts.reduce((a, b) => a + b, 0), r.counts.rise);
    assert.equal(r.slowest.rise[0].dur, r.rises.max);
    assert.ok(r.slowest.rise.every((e, i, a) => i === 0 || a[i - 1].dur >= e.dur), "slowest first");
    assert.equal(r.counts.runt, 0, "ringing is not a runt");
    // 1 MHz with 50 % duty: high and low pulses of 500 ns.
    close(r.pulses.high.mean!, 0.5 / C.sim.clock_hz, 3e-9, "high pulse");
    close(r.pulses.low.mean!, 0.5 / C.sim.clock_hz, 3e-9, "low pulse");
    assert.equal(s.segments, null);
  });

  test(`${family}: a level the signal never reaches → no trigger within the wait, instrument stopped`, async () => {
    const s = await runner.run(scope, checkBurst({ trigger: clock, level: 20, windowS: 10e-6, waitS: 0.6, channels: [clock], maxPoints: 100_000 }), () => {});
    assert.equal(s.phase, "error");
    assert.match(s.error!, /No trigger within 0.6 s/);
    assert.equal(await scope.drv.status(), "STOP");
  });
}

test("a measured channel that leaves the screen is flagged: its clipped edges would look too fast", async () => {
  // LeCroy sim: CH3 is a 1 Vpp square at 100 mV/div — ±0.5 V on a ±0.4 V screen, clipped by the 8-bit range.
  // (Not the CH4 UART: a 20 µs window can fall inside a long low stretch of it, and then it does fit.)
  await scope.connect({ sim: true, simModel: "lecroy" });
  await scope.write("channel.display@3", true);
  const s = await runner.run(scope, checkBurst({ trigger: 2, level: C.sim.clock_v / 2, windowS: 10e-6, waitS: 5, channels: [2, 3], maxPoints: 1_000_000 }), () => {});
  assert.equal(s.phase, "done");
  assert.equal(s.results.find((r) => r.ch === 2)!.offScreen, false);
  assert.equal(s.results.find((r) => r.ch === 3)!.offScreen, true);
  assert.ok(s.notes.some((n) => /CH3 goes off the screen/.test(n)));
});

test("stop while waiting for the trigger ends the capture cleanly", async () => {
  const p = runner.run(scope, checkBurst({ trigger: 2, level: 20, windowS: 10e-6, waitS: 30, channels: [2], maxPoints: 100_000 }), () => {});
  await new Promise((r) => setTimeout(r, 400));
  runner.stop();
  const s = await p;
  assert.equal(s.phase, "stopped");
  assert.equal(scope.busy, null);
});

test("glitches: pulses narrower than the set width are flagged, wider ones not", async () => {
  await scope.connect({ sim: true, simModel: "lecroy" });
  const run = (glitchS: number) => runner.run(scope, checkBurst({ trigger: 2, level: C.sim.clock_v / 2, windowS: 10e-6, waitS: 5, channels: [2], maxPoints: 1_000_000, glitchS }), () => {});
  // Every 500 ns pulse of the clock is narrower than 600 ns …
  let r = (await run(600e-9)).results[0];
  assert.equal(r.counts.glitch, r.pulses.high.n + r.pulses.low.n);
  assert.ok(r.anomalies.every((a) => a.kind === "glitch" && Math.abs(a.width! - 500e-9) < 5e-9));
  const csv = [...runner.anomaliesCsv()].join("");
  assert.match(csv, /^channel,segment,kind,polarity,time_s,width_s,peak_V$/m);
  assert.equal(csv.trim().split("\n").length - 2, r.counts.glitch);
  // … and none narrower than 100 ns.
  r = (await run(100e-9)).results[0];
  assert.equal(r.counts.glitch, 0);
});

test("setup and hold of a data line against the clock's rising edges", async () => {
  // LeCroy sim: CH3 is a 100 kHz square (a data line changing every 5 µs), CH2 the 1 MHz clock.
  await scope.connect({ sim: true, simModel: "lecroy" });
  const s = await runner.run(scope, checkBurst({
    trigger: 2, level: C.sim.clock_v / 2, windowS: 20e-6, waitS: 5, channels: [3], maxPoints: 1_000_000,
    timing: { clock: 2, edge: "rise", setupMin: 1e-6, holdMin: null },
  }), () => {});
  assert.equal(s.phase, "done", s.error ?? "");
  assert.deepEqual(s.config!.channels, [2, 3], "the clock is measured too");
  const t = s.timing[0];
  assert.equal(t.data, 3);
  assert.equal(t.clock, 2);
  const clock = s.results.find((r) => r.ch === 2)!;
  assert.equal(t.total, clock.counts.rise, "one row per rising clock edge");
  // Between two data edges 5 µs apart, setup + hold of every clock edge is that spacing.
  for (const x of t.rows) if (x.setup !== null && x.hold !== null) close(x.setup + x.hold, 5e-6, 20e-9, "setup + hold");
  const setups = t.rows.map((x) => x.setup).filter((x): x is number => x !== null);
  assert.equal(t.worstSetup!.setup, Math.min(...setups));
  assert.equal(t.violations.setup, setups.filter((x) => x < 1e-6).length);
  assert.equal(t.violations.hold, 0, "no hold requirement given");
  const csv = [...runner.timingCsv()].join("");
  assert.match(csv, /^data_channel,segment,clock_edge_time_s,setup_s,hold_s$/m);
  assert.equal(csv.trim().split("\n").length - 2, t.total);
});

test("lecroy: several segments (sequence mode) — one Single, every trigger in its own segment, each with its time", async () => {
  await scope.connect({ sim: true, simModel: "lecroy" });
  for (const ch of [1, 3, 4]) await scope.write(`channel.display@${ch}`, false);
  const s = await runner.run(scope, checkBurst({ trigger: 2, level: C.sim.clock_v / 2, windowS: 10e-6, waitS: 5, channels: [2], maxPoints: 1_000_000, segments: 5 }), () => {});
  assert.equal(s.phase, "done", s.error ?? "");
  assert.equal(scope.values.get("acquire.mode"), "Sequence");
  assert.equal(scope.values.get("acquire.segments"), 5);
  assert.deepEqual([s.segments!.count, s.segments!.recorded], [5, 5]);
  // Each trigger comes after the previous segment's record (18 µs after its trigger) and the 1 µs re-arm.
  const times = s.segments!.times!;
  assert.equal(times[0], 0);
  for (let k = 1; k < 5; k++) assert.ok(times[k] - times[k - 1] >= 19e-6 && times[k] - times[k - 1] < 21e-6, `segment ${k} at ${times[k]}`);
  const r = s.results[0];
  assert.equal(r.perSegment.length, 5);
  for (const g of r.perSegment) assert.ok(g.rise >= 19 && g.rise <= 21, `segment ${g.seg}: ${g.rise} rises`);
  assert.equal(r.counts.rise, r.perSegment.reduce((a, g) => a + g.rise, 0));
  // Edge times are from each segment's own trigger: every segment has its triggering edge at t = 0.
  for (let g = 0; g < 5; g++) {
    const first = r.edges.find((e) => e.seg === g && e.kind === "rise" && e.t > -50e-9)!;
    close(first.t, 0, 2e-9, `segment ${g} trigger edge`);
  }
  close(r.rises.mean!, truth.rise, 0.3e-9, "mean rise over all segments");
  assert.ok(s.notes.some((n) => /left in sequence mode/.test(n)));
  // Back to one record: real-time sampling again.
  const one = await runner.run(scope, checkBurst({ trigger: 2, level: C.sim.clock_v / 2, windowS: 10e-6, waitS: 5, channels: [2], maxPoints: 1_000_000 }), () => {});
  assert.equal(one.phase, "done");
  assert.equal(scope.values.get("acquire.mode"), "RealTime");
  assert.equal(one.segments, null);
});

test("rigol: several segments are refused with a reason", async () => {
  await scope.connect({ sim: true, simModel: "rigol" });
  const s = await runner.run(scope, checkBurst({ trigger: 3, windowS: 10e-6, waitS: 1, channels: [3], maxPoints: 100_000, segments: 4 }), () => {});
  assert.equal(s.phase, "error");
  assert.match(s.error!, /segmented memory/);
});
