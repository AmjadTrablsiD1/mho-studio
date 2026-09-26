// The server's service layer against the simulated MHO984, over real TCP:
// the same path a real instrument takes.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.MHO_STUDIO_HOME = mkdtempSync(join(tmpdir(), "mho-studio-test-"));

const { ScopeService } = await import("../scope.ts");
const { DeepStore } = await import("../deep.ts");
const { BodeRunner, checkConfig } = await import("../bode.ts");

const events: { type: string; data: unknown }[] = [];
const scope = new ScopeService((type, data) => events.push({ type, data }));
after(async () => {
  await scope.disconnect();
});

test("connects to the simulator, reads identity, options and the primary settings", async () => {
  const link = await scope.connect({ sim: true });
  assert.equal(link.state, "connected");
  assert.equal(link.idn?.model, "MHO984");
  assert.equal(scope.options.AFG100, true);
  assert.equal(scope.values.get("channel.scale@1"), 0.5);
  assert.equal(scope.values.get("trigger.edge.slope"), "POSitive");
  assert.equal(scope.values.get("acquire.mdepth"), "AUTO");
  assert.ok(scope.values.has("trigger.edge.level"));
});

test("a write is read back; an off-sequence scale is reported as coerced, a range error is surfaced", async () => {
  const r = await scope.write("channel.scale@2", 0.3);
  assert.equal(r.coerced, true);
  assert.equal(r.value, 0.2);
  const o = await scope.write("channel.offset@2", 500);
  assert.equal(o.coerced, true);
  assert.ok(o.errors.some((e) => e.code === -222));
  await scope.write("channel.scale@2", 0.5);
  await scope.write("channel.offset@2", -1);
});

test("confirmation is required to switch a generator output on", async () => {
  await scope.write("source.output.state@2", false);
  await assert.rejects(scope.write("source.output.state@2", true), /generator output/);
});

test("a live frame decodes both displayed channels in volts", async () => {
  await scope.frame();
  const a = scope.latest.get("CHANnel1")!;
  assert.equal(a.volts.length, 1000);
  const max = Math.max(...a.volts);
  const min = Math.min(...a.volts);
  assert.ok(Math.abs(max - min - 2) < 0.1, `CH1 Vpp ${max - min}`);
  assert.ok(scope.latest.has("CHANnel2"));
});

test("measurements: the instrument value and the app's cross-check agree", async () => {
  await scope.addMeasurement("FREQuency", "CHANnel1");
  await scope.frame();
  const rows = await scope.addMeasurement("VPP", "CHANnel2");
  const f = rows.find((r) => r.slot.item === "FREQuency")!;
  assert.ok(Math.abs(f.value! - 5000) < 5, `freq ${f.value}`);
  assert.ok(f.cross !== null && Math.abs(f.cross - 5000) < 50, `cross ${f.cross}`);
  const left = await scope.removeMeasurement(f.slot.id);
  assert.equal(left.length, 1);
});

test("console sends raw SCPI and reports the error queue", async () => {
  const r = await scope.console(":TIMebase:SCALe?");
  assert.equal(Number(r.reply), 1e-4);
  const bad = await scope.console(":NOT:A:COMMAND 1");
  assert.equal(bad.errors[0].code, -100);
});

test("over LAN too, an unanswered query costs only itself: the next query resynchronises", async () => {
  const r = await scope.console(":NOT:A:REAL:QUERY?");
  assert.equal(r.reply, null);
  assert.equal(scope.link.state, "connected");
  assert.equal(await scope.readKey("timebase.scale"), 1e-4);
});

test("screenshot is a PNG", async () => {
  const png = await scope.screenshot();
  assert.deepEqual([...png.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
});

test("deep capture reads the whole memory in chunks and resumes", async () => {
  const deep = new DeepStore();
  let progress = 0;
  const meta = await deep.capture(scope, ["CHANnel1", "CHANnel2"], 600_000, true, () => progress++);
  assert.equal(meta.points, 600_000);
  assert.ok(progress >= 6, "at least three chunks per channel");
  const v = deep.view("CHANnel1", 0, meta.points, 500);
  assert.equal(v.min.length, 500);
  assert.ok(Math.max(...v.max) > 0.9 && Math.min(...v.min) < -0.9);
  const a = deep.analyse("CHANnel1", 0, meta.points, "hann");
  assert.ok(Math.abs(a.peaks[0].hz - 5000) < 20, `peak ${a.peaks[0].hz}`);
  assert.notEqual(scope.status, "STOP");
  const rows = [...deep.csv(0, 10)].join("");
  assert.equal(rows.trim().split("\n").length, 12);
});

test("Bode sweep of the simulated low-pass finds fc = 20 kHz and puts every setting back", async () => {
  const before = { tb: scope.values.get("timebase.scale"), f: scope.values.get("source.frequency@1"), s2: scope.values.get("channel.scale@2") };
  const runner = new BodeRunner();
  const st = await runner.run(scope, checkConfig({ startHz: 1000, stopHz: 200000, points: 16, settleMs: 20 }), () => {});
  assert.equal(st.error, null);
  assert.equal(st.points.length, 16);
  assert.ok(st.corner, "a −3 dB corner");
  assert.ok(Math.abs(st.corner!.hz - 20000) / 20000 < 0.08, `corner ${st.corner!.hz}`);
  // second-order Butterworth: −90° at fc
  assert.ok(Math.abs(st.corner!.phaseDeg + 90) < 8, `phase ${st.corner!.phaseDeg}`);
  const low = st.points[0];
  assert.ok(Math.abs(low.gainDb) < 0.3, `passband ${low.gainDb}`);
  await scope.readKeys(["timebase.scale", "source.frequency@1", "channel.scale@2"]);
  assert.equal(scope.values.get("timebase.scale"), before.tb);
  assert.equal(scope.values.get("source.frequency@1"), before.f);
  assert.equal(scope.values.get("channel.scale@2"), before.s2);
});
