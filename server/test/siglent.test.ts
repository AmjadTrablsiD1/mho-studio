// The service against the simulated T3DSO1204 over real TCP (raw SCPI, as on
// the real one's port 5025). The simulator answers in the formats the real
// instrument used on 2026-10-14; core/test/siglent.test.ts checks the framing
// against the real bytes themselves.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.MHO_STUDIO_HOME = mkdtempSync(join(tmpdir(), "mho-studio-siglent-"));

const { ScopeService } = await import("../scope.ts");
const { DeepStore } = await import("../deep.ts");
const { BurstRunner, checkBurst } = await import("../burst.ts");
const { C } = await import("../../core/src/constants.ts");
const { clockSource, sampleSource } = await import("../../sim/bench.ts");
const { findEdges } = await import("../../core/src/dsp/edges.ts");
const { extrema } = await import("../../core/src/dsp/measure.ts");

const scope = new ScopeService(() => {});
after(async () => {
  await scope.disconnect();
});
type Sim = { log: string[]; ignoreSparse: boolean; exec: (m: string) => unknown; state: { trmd: string; tdiv: number } };
const sim = () => (scope as unknown as { sim: { scope: Sim } }).sim.scope;
const close = (a: number, b: number, tol: number, what = "") => assert.ok(Math.abs(a - b) <= tol, `${what} ${a} ≠ ${b} (±${tol})`);

test("connects, recognises the T3DSO1204 as a Siglent-made scope, turns headers off and reads the primary settings", async () => {
  const link = await scope.connect({ sim: true, simModel: "siglent" });
  assert.equal(link.state, "connected");
  assert.equal(link.family, "siglent");
  assert.equal(link.protocol, "raw");
  assert.equal(link.idn?.model, "T3DSO1204");
  assert.equal(link.modelWarning, null);
  assert.ok(sim().log.includes("CHDR OFF"));
  assert.ok(!sim().log.some((l) => /^(CFMT|CORD|VBS)/.test(l)), "no X-Stream commands");
  assert.equal(scope.values.get("channel.scale@2"), 1);
  assert.equal(scope.values.get("channel.offset@2"), -1.65);
  assert.equal(scope.values.get("channel.probe@1"), "10");
  assert.equal(scope.values.get("channel.display@3"), false);
  assert.equal(scope.values.get("timebase.scale"), 2e-7);
  assert.equal(scope.values.get("acquire.mdepth"), "7M", "CH1 and CH2 on: the paired memory");
  assert.equal(scope.values.get("acquire.srate"), 5e8);
  assert.equal(scope.values.get("trigger.mode"), "EDGE");
  assert.equal(scope.values.get("trigger.edge.source"), "C1");
  assert.equal(scope.values.get("trigger.edge.slope"), "POS");
  assert.equal(scope.reg.divisionsX, 14);
});

test("writes go out in Siglent syntax and are read back; the trigger source carries its type", async () => {
  const r = await scope.write("channel.scale@1", 0.5);
  assert.equal(r.value, 0.5);
  await scope.write("channel.bwlimit@1", true);
  assert.ok(sim().log.includes("C1:BWL ON"));
  assert.equal(scope.values.get("channel.bwlimit@1"), true);
  await scope.write("trigger.edge.source", "C2");
  assert.ok(sim().log.includes("TRSE EDGE,SR,C2"));
  // The level and slope that come back are the new source's.
  assert.equal(scope.values.get("trigger.edge.level"), 1.65);
  await scope.write("trigger.edge.source", "C1");
  await scope.write("channel.scale@1", 0.2);
  await scope.write("channel.bwlimit@1", false);
  // A value the instrument refuses: *ESR? reports an execution error.
  const bad = await scope.write("acquire.averages", "3").catch((e: Error) => e);
  assert.ok(!(bad instanceof Error) ? bad.errors.some((e: { code: number }) => e.code === -200) : true);
});

test("a live frame: volts from code × V/div / 25 − offset, 14 divisions of time, the trigger at t = 0", async () => {
  await scope.write("channel.display@2", true);
  await scope.frame();
  const a = scope.latest.get("CHANnel1")!;
  const b = scope.latest.get("CHANnel2")!;
  // 200 ns/div × 14 at 500 MSa/s = 1400 points, under the 2000 a screen gets: every point.
  assert.equal(a.volts.length, 1400);
  close(a.pre.xinc, 2e-9, 1e-15, "xinc");
  close(a.pre.xorigin, -7 * 2e-7, 1e-12, "first point 7 divisions before the trigger");
  const lo = Math.min(...a.volts);
  const hi = Math.max(...a.volts);
  close(hi - lo, C.siglent.sim.ch1_vpp, 0.05, "CH1 Vpp");
  close(Math.max(...b.volts), C.sim.clock_v, 0.4, "clock high");
  // CH1 triggers rising through 0 V: the sample at t = 0 is near 0 V and the next ones are above it.
  const i0 = Math.round(-a.pre.xorigin / a.pre.xinc);
  close(a.volts[i0], 0, 0.03, "CH1 at the trigger");
  assert.ok(a.volts[i0 + 20] > a.volts[i0], "rising after the trigger");
  // The screen centre is minus the trigger delay.
  assert.equal(scope.values.get("timebase.offset"), -0);
});

test("a longer record is sent every Nth point; if the instrument ignores that, the driver thins it itself", async () => {
  await scope.write("timebase.scale", 1e-5); // 14 divisions × 10 µs at 500 MSa/s = 70 000 points
  await scope.frame();
  const r = scope.latest.get("CHANnel1")!;
  assert.ok(r.volts.length <= C.siglent.screen_points && r.volts.length > C.siglent.screen_points / 2, `${r.volts.length} points`);
  close(r.volts.length * r.pre.xinc, 14e-5, 2e-7, "the record still spans 14 divisions");
  assert.ok(sim().log.some((l) => /^WFSU SP,35,/.test(l)));
  sim().ignoreSparse = true;
  await scope.frame();
  const t = scope.latest.get("CHANnel1")!;
  assert.ok(t.volts.length <= C.siglent.screen_points, `${t.volts.length} points after thinning`);
  close(t.volts.length * t.pre.xinc, 14e-5, 2e-7, "thinned record spans 14 divisions");
  close(Math.max(...t.volts) - Math.min(...t.volts), C.siglent.sim.ch1_vpp, 0.05, "same signal");
  sim().ignoreSparse = false;
  await scope.write("timebase.scale", 2e-7);
});

test("steady live frames: one WF? DAT2 per channel and nothing else", async () => {
  await scope.frame();
  await scope.scpi.query("*IDN?");
  sim().log.length = 0;
  await scope.frame();
  await scope.scpi.query("*IDN?");
  assert.deepEqual(sim().log.filter((l) => l !== "*IDN?"), ["C1:WF? DAT2", "C2:WF? DAT2"]);
});

test("measurements come from PARAMETER_VALUE? and agree with the app's own cross-check", async () => {
  await scope.addMeasurement("PKPK", "CHANnel1");
  await scope.addMeasurement("FREQ", "CHANnel1");
  await scope.addMeasurement("RISE", "CHANnel2");
  await scope.frame();
  await (scope as unknown as { readMeasurements: () => Promise<void> }).readMeasurements();
  const rows = scope.measureRows();
  const pk = rows.find((r) => r.slot.item === "PKPK")!;
  const f = rows.find((r) => r.slot.item === "FREQ")!;
  close(pk.value!, C.siglent.sim.ch1_vpp, 0.05, "PKPK");
  close(pk.cross!, C.siglent.sim.ch1_vpp, 0.05, "PKPK cross");
  close(f.value!, C.siglent.sim.ch1_sine_hz, 2e4, "FREQ");
  await assert.rejects(scope.addMeasurement("VMAX", "CHANnel1"), /unknown measurement/);
  for (const r of rows) await scope.removeMeasurement(r.slot.id);
});

test("screenshot: the raw BMP is read by its own length and handed out as PNG; the link carries on", async () => {
  const img = await scope.screenshot();
  assert.deepEqual([...img.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
  const w = (img[16] << 24) | (img[17] << 16) | (img[18] << 8) | img[19];
  const h = (img[20] << 24) | (img[21] << 16) | (img[22] << 8) | img[23];
  assert.deepEqual([w, h], [800, 480]);
  assert.equal(await scope.readKey("timebase.scale"), 2e-7, "the next reply is the next answer");
  // From the console too (SCDP has no "?", yet it answers).
  const c = await scope.console("SCDP");
  assert.ok(c.block && c.block.bytes > 700_000);
  assert.equal((await scope.console("TDIV?")).reply, "2.00E-07");
});

test("setup: PNSU? brings the XML file; sending it back restores the settings", async () => {
  const blob = await scope.setupBlob();
  assert.match(new TextDecoder().decode(blob), /^<\?xml[\s\S]*<nsp_config>/);
  await scope.write("channel.scale@1", 1);
  const r = await scope.restoreSetup(blob);
  assert.deepEqual(r.errors, []);
  assert.equal(scope.values.get("channel.scale@1"), 0.2);
});

test("a query it does not know: no reply, a command error, and the link stays", async () => {
  const r = await scope.console("*OPT?");
  assert.equal(r.reply, null);
  assert.ok(r.errors.some((e) => e.code === -100));
  assert.equal(await scope.readKey("timebase.scale"), 2e-7);
});

test("deep capture reads every point in chunks of WFSU first point / number of points", async () => {
  await scope.write("timebase.scale", 1e-3); // 14 × 1 ms at 500 MSa/s = 7 000 000 points, the 7 Mpts the pair allows
  const srate = Number(scope.values.get("acquire.srate"));
  const total = Math.round(srate * 1e-3 * 14);
  assert.equal(total, 7_000_000);
  await scope.action("root.stop", null);
  const deep = new DeepStore();
  const meta = await deep.capture(scope, ["CHANnel1"], 3_000_000, false, () => {});
  assert.equal(meta.points, Math.min(total, 3_000_000));
  assert.equal(meta.available, total);
  assert.ok(sim().log.some((l) => l === `WFSU SP,0,NP,${C.siglent.deep_chunk_points},FP,${C.siglent.deep_chunk_points}`), "second chunk from point 1 000 000");
  close(meta.xinc, 1 / srate, 1e-15, "every point");
  close(meta.xorigin, -7e-3, 1e-9, "first point 7 divisions before the trigger");
  const v = deep.volts("CHANnel1", 0, 200_000);
  const e = extrema(v);
  close(e.max - e.min, C.siglent.sim.ch1_vpp, 0.06, "deep CH1 Vpp");
  await scope.write("timebase.scale", 2e-7);
  await scope.action("root.run", null);
});

test("edge capture on the T3DSO: one trigger on the clock, every rising edge's 10–90 % time", async () => {
  const truth = (() => {
    const src = clockSource();
    const dt = 5e-12;
    const v = Float32Array.from({ length: Math.round(3e-6 / dt) }, (_, i) => sampleSource(src, i * dt));
    return findEdges(v, dt, 0).rises.mean!;
  })();
  // Only the clock (CH2) on: its pair-mate CH1 off, so 1 GSa/s.
  await scope.write("channel.display@1", false);
  const runner = new BurstRunner(new DeepStore());
  const s = await runner.run(scope, checkBurst({ trigger: 2, level: 1.65, windowS: 10e-6, waitS: 5, channels: [2], maxPoints: 14_000_000 }), () => {});
  assert.equal(s.phase, "done", s.error ?? "");
  // 14 divisions, the trigger 1 division from the left: 13 divisions after it hold 10 µs → 1 µs/div.
  assert.equal(s.setup!.timeDiv, 1e-6);
  assert.equal(scope.values.get("timebase.delay"), -6e-6, "trigger delay −6 divisions puts the trigger 1 division from the left");
  const r = s.results[0];
  assert.ok(r.counts.rise >= 13 && r.counts.rise <= 15, `rises ${r.counts.rise}`);
  const first = r.edges.find((e) => e.kind === "rise" && e.t > -50e-9)!;
  close(first.t, 0, 3e-9, "trigger edge at t = 0");
  close(r.rises.mean!, truth, 0.6e-9, "mean rise (1 GSa/s on ~5 ns edges)");
  assert.equal(await scope.drv.status(), "STOP");
  await scope.write("channel.display@1", true);
});
