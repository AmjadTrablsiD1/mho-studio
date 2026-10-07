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
    assert.match(csv, /^channel,edge,kind,time_s,duration_s,under_sampled$/m);
    assert.equal(csv.trim().split("\n").length - 2, r.counts.rise + r.counts.fall);
  });

  test(`${family}: a level the signal never reaches → no trigger within the wait, instrument stopped`, async () => {
    const s = await runner.run(scope, checkBurst({ trigger: clock, level: 20, windowS: 10e-6, waitS: 0.6, channels: [clock], maxPoints: 100_000 }), () => {});
    assert.equal(s.phase, "error");
    assert.match(s.error!, /No trigger within 0.6 s/);
    assert.equal(await scope.drv.status(), "STOP");
  });
}

test("a measured channel that leaves the screen is flagged: its clipped edges would look too fast", async () => {
  // LeCroy sim: CH4 carries a 3.3 V UART at 100 mV/div — far off the screen, clipped by the 8-bit range.
  await scope.connect({ sim: true, simModel: "lecroy" });
  await scope.write("channel.display@4", true);
  const s = await runner.run(scope, checkBurst({ trigger: 2, level: C.sim.clock_v / 2, windowS: 10e-6, waitS: 5, channels: [2, 4], maxPoints: 1_000_000 }), () => {});
  assert.equal(s.phase, "done");
  assert.equal(s.results.find((r) => r.ch === 2)!.offScreen, false);
  assert.equal(s.results.find((r) => r.ch === 4)!.offScreen, true);
  assert.ok(s.notes.some((n) => /CH4 goes off the screen/.test(n)));
});

test("stop while waiting for the trigger ends the capture cleanly", async () => {
  const p = runner.run(scope, checkBurst({ trigger: 2, level: 20, windowS: 10e-6, waitS: 30, channels: [2], maxPoints: 100_000 }), () => {});
  await new Promise((r) => setTimeout(r, 400));
  runner.stop();
  const s = await p;
  assert.equal(s.phase, "stopped");
  assert.equal(scope.busy, null);
});
