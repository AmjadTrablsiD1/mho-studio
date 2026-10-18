// The server's service layer against the simulated MHO984, over real TCP:
// the same path a real instrument takes.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.MHO_STUDIO_HOME = mkdtempSync(join(tmpdir(), "mho-studio-test-"));
process.env.MHO_STUDIO_NO_USB = "1"; // never touch a real instrument on this computer's USB
process.env.MHO_STUDIO_NO_SERIAL = "1"; // nor the STM32 board on its serial port

const { ScopeService } = await import("../scope.ts");
const { DeepStore } = await import("../deep.ts");
const { BodeRunner, checkConfig } = await import("../bode.ts");
const { BoardService } = await import("../board.ts");

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

test("live frames: one round trip per channel while nothing changes; a change, or time, brings a fresh preamble", async () => {
  const { C } = await import("../../core/src/constants.ts");
  const sent = () => scope.traffic.filter((t) => t.dir === "out").map((t) => t.text);
  const vpp = () => {
    const v = scope.latest.get("CHANnel1")!.volts;
    return Math.max(...v) - Math.min(...v);
  };
  await scope.frame();
  scope.traffic.length = 0;
  await scope.frame();
  // Two channels on: two DATA? queries and the source switches between them; no preamble, no repeated MODE or FORMat.
  let out = sent();
  assert.equal(out.filter((x) => /PREamble\?/i.test(x)).length, 0, out.join(" | "));
  assert.equal(out.filter((x) => /DATA\?/i.test(x)).length, 2);
  assert.ok(!out.some((x) => /:WAVeform:(MODE|FORMat)/i.test(x)), out.join(" | "));
  // A setting written through the app: the next frame reads both preambles again, and CH1 still shows its 2 Vpp.
  await scope.write("channel.scale@1", 1);
  scope.traffic.length = 0;
  await scope.frame();
  assert.equal(sent().filter((x) => /PREamble\?/i.test(x)).length, 2);
  assert.ok(Math.abs(vpp() - 2) < 0.1, `CH1 Vpp ${vpp()} at 1 V/div`);
  // A knob turned at the instrument (the app does not know yet): shown right within the preamble's maximum age.
  const sim = (scope as unknown as { sim: { scope: { exec: (m: string) => unknown } } }).sim.scope;
  sim.exec(":CHANnel1:SCALe 0.5");
  await new Promise((r) => setTimeout(r, C.loops.preamble_max_age_ms + 50));
  scope.traffic.length = 0;
  await scope.frame();
  assert.equal(sent().filter((x) => /PREamble\?/i.test(x)).length, 2);
  assert.ok(Math.abs(vpp() - 2) < 0.1, `CH1 Vpp ${vpp()} after the knob`);
  await scope.write("channel.scale@1", 0.5);
  // The console may change what the driver last set: it sends everything again afterwards.
  await scope.console(":WAVeform:MODE RAW");
  scope.traffic.length = 0;
  await scope.frame();
  out = sent();
  assert.ok(out.includes(":WAVeform:MODE NORMal"), out.join(" | "));
  assert.equal(scope.latest.get("CHANnel1")!.volts.length, 1000);
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

test("a measurement can be changed after it was added: quantity, channel, delay pair — in place", async () => {
  for (const r of scope.measureRows()) await scope.removeMeasurement(r.slot.id);
  const [a] = await scope.addMeasurement("VPP", "CHANnel1");
  await scope.addMeasurement("FREQuency", "CHANnel1");
  const before = scope.measureRows()[0].stats.n;
  assert.ok(before >= 1);
  // Change the channel: CH2 is the filtered copy of CH1's 2 Vpp, so the reading changes and the statistics restart.
  let rows = await scope.updateMeasurement(a.slot.id, { src1: "CHANnel2" });
  assert.equal(rows[0].slot.id, a.slot.id, "same row, same place");
  assert.equal(rows[0].slot.src1, "CHANnel2");
  assert.equal(rows[0].stats.n, 1, "statistics start again");
  // Change the quantity.
  rows = await scope.updateMeasurement(a.slot.id, { item: "PERiod" });
  assert.equal(rows[0].slot.item, "PERiod");
  assert.ok(Math.abs(rows[0].value! - 2e-4) < 2e-6, `period ${rows[0].value}`);
  // A two-source quantity gets a second channel; then that one can be changed too.
  rows = await scope.updateMeasurement(a.slot.id, { item: "RRDelay" });
  assert.ok(rows[0].slot.src2 && rows[0].slot.src2 !== rows[0].slot.src1);
  rows = await scope.updateMeasurement(a.slot.id, { src2: "CHANnel1" });
  assert.equal(rows[0].slot.src2, "CHANnel1");
  // The instrument measures what the list says (the guide's delete-all, then each again).
  const sim = (scope as unknown as { sim: { scope: { log: string[] } } }).sim.scope;
  assert.ok(sim.log.some((l) => /^:MEASure:ITEM RRDelay,CHANnel2,CHANnel1$/i.test(l)), "instrument told the new pair");
  await assert.rejects(scope.updateMeasurement(a.slot.id, { item: "NOPE" }), /unknown measurement/);
  await assert.rejects(scope.updateMeasurement("m999", { item: "VPP" }), /no such measurement/);
  for (const r of scope.measureRows()) await scope.removeMeasurement(r.slot.id);
  assert.equal(scope.measureRows().length, 0);
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

test("Bode sweep driven by the STM32 board's Si5351 finds the same corner and puts the board and the scope back", async () => {
  const board = new BoardService();
  const runner = new BodeRunner();
  // Not connected yet: refused before anything is touched.
  assert.throws(() => runner.check(scope, checkConfig({ generator: "board" }), board), /connect the STM32 board first/);
  assert.throws(() => checkConfig({ generator: "board", startHz: 1000 }), /for the Si5351.*2\.5 kHz/);
  await board.connect("sim");
  after(() => board.disconnect().catch(() => {}));
  await board.set(0, 1e6, false);
  await board.drive(0, 1);
  const before = { c1: scope.values.get("channel.coupling@1"), tb: scope.values.get("timebase.scale"), gen: scope.values.get("source.frequency@1") };
  const st = await runner.run(scope, checkConfig({ generator: "board", clk: 0, drive: 3, startHz: 2500, stopHz: 200000, points: 14, settleMs: 20 }), () => {}, board);
  assert.equal(st.error, null);
  assert.match(st.generator ?? "", /CLK0 \(Si5351, 8 mA\)/);
  assert.equal(st.points.length, 14);
  assert.ok(Math.abs(st.corner!.hz - 20000) / 20000 < 0.08, `corner ${st.corner!.hz}`);
  assert.ok(Math.abs(st.corner!.phaseDeg + 90) < 8, `phase ${st.corner!.phaseDeg}`);
  // The square's fundamental: 4/π × 1.65 V.
  assert.ok(Math.abs(st.points[0].vin - (4 / Math.PI) * 1.65) < 0.05, `vin ${st.points[0].vin}`);
  // Each point is at the frequency the board reported.
  const sent = board.sim!.log.filter((l) => l.cmd === 0x71).length;
  assert.ok(sent >= 14, `ClkFreq commands ${sent}`);
  // The board is as it was: CLK0 off at 1 MHz, 4 mA; not held.
  const c0 = await board.get(0);
  assert.deepEqual({ on: c0.on, hz: c0.hz, drive: c0.drive }, { on: false, hz: 1e6, drive: 1 });
  assert.equal(board.state.busy, null);
  await scope.readKeys(["channel.coupling@1", "timebase.scale", "source.frequency@1"]);
  assert.equal(scope.values.get("channel.coupling@1"), before.c1);
  assert.equal(scope.values.get("timebase.scale"), before.tb);
  assert.equal(scope.values.get("source.frequency@1"), before.gen);
  assert.match(runner.csv(), /generator STM32 board CLK0/);
  await board.disconnect();
});

test("Bode on a board output that is not the one wired to CH1 stops at the first point and says so", async () => {
  const board = new BoardService();
  await board.connect("sim");
  try {
    await board.set(0, 1e6, true); // CLK0 is on the bench's tee; the sweep is told to use CLK1
    const runner = new BodeRunner();
    const st = await runner.run(scope, checkConfig({ generator: "board", clk: 1, startHz: 5000, stopHz: 50000, points: 4, settleMs: 20 }), () => {}, board);
    // (1 MHz on a screen set for 5 kHz is undersampled, so the rate CH1 "shows" is an alias — it is still not 5 kHz.)
    assert.match(st.error ?? "", /CH1 shows .*, not the 5(\.000)? kHz from STM32 board CLK1.*wired to CH1/);
    assert.equal(st.points.length, 0);
    assert.equal((await board.get(1)).on, false, "CLK1 put back off");
  } finally {
    await board.set(0, 1e6, false);
    await board.disconnect();
  }
});

test("Bode sweep driven by the board's DAC sine: same corner, each point at the DAC's own frequency, the DAC stopped afterwards", async () => {
  const { SimBoard, planDacSine } = await import("../../sim/board.ts");
  assert.throws(() => checkConfig({ generator: "dac", stopHz: 100000 }), /for the board's DAC.*60 kHz/);
  assert.throws(() => checkConfig({ generator: "dac", amplitudeVpp: 3.3 }), /at most 3 Vpp/);
  const board = new BoardService();
  // It was playing the FDM waveform before: reported, not silently lost.
  board.simFactory = () => new SimBoard({ dac: { running: true, source: 1, length: 4096, rateHz: 100000 } });
  await board.connect("sim");
  try {
    const runner = new BodeRunner();
    const st = await runner.run(scope, checkConfig({ generator: "dac", amplitudeVpp: 1, startHz: 1000, stopHz: 60000, points: 12, settleMs: 20 }), () => {}, board);
    assert.equal(st.error, null);
    assert.match(st.generator ?? "", /DAC \(PC4, 1 Vpp sine\)/);
    assert.ok(Math.abs(st.corner!.hz - 20000) / 20000 < 0.08, `corner ${st.corner!.hz}`);
    assert.ok(Math.abs(st.points[0].vin - 0.5) < 0.02, `vin ${st.points[0].vin}`);
    // The axis is the DAC's frequencies, not the plan's.
    const asked = [1000, 60000];
    assert.equal(st.points[0].hz, planDacSine(asked[0]).hz);
    assert.ok(st.points.some((p, i) => i > 0 && i < st.points.length - 1 && p.hz !== Math.round(p.hz)), "fractional, achieved frequencies");
    assert.equal(board.state.dac?.running, false);
    assert.ok(st.notes.some((n) => /playing the FDM waveform before the sweep/.test(n)), st.notes.join(" | "));
  } finally {
    await board.disconnect();
  }
});

test("measurements survive a reconnect: the app lists them again and the instrument shows exactly them", async () => {
  type Sim = { log: string[] };
  const sim = () => (scope as unknown as { sim: { scope: Sim } }).sim.scope;
  for (const r of scope.measureRows()) await scope.removeMeasurement(r.slot.id);
  await scope.addMeasurement("FREQuency", "CHANnel1");
  await scope.addMeasurement("VPP", "CHANnel2");
  await scope.connect({ sim: true });
  let rows = scope.measureRows();
  assert.deepEqual(rows.map((r) => `${r.slot.item} ${r.slot.src1}`), ["FREQuency CHANnel1", "VPP CHANnel2"]);
  // The instrument was told: delete all, then these two — no third one from adding again.
  const log = sim().log;
  const del = log.lastIndexOf(":MEASure:DELete");
  assert.ok(del >= 0, "measurements cleared on the instrument");
  assert.deepEqual(log.slice(del + 1).filter((l) => /^:MEASure:ITEM /i.test(l)), [":MEASure:ITEM FREQuency,CHANnel1", ":MEASure:ITEM VPP,CHANnel2"]);
  // Changed in the app: saved again, and still there after the next reconnect.
  await scope.removeMeasurement(rows[1].slot.id);
  await scope.connect({ sim: true });
  rows = scope.measureRows();
  assert.deepEqual(rows.map((r) => r.slot.item), ["FREQuency"]);
  for (const r of rows) await scope.removeMeasurement(r.slot.id);
});

test("the first measurement added in the app clears what the instrument still showed from before", async () => {
  type Sim = { log: string[]; exec: (m: string) => unknown };
  const sim = () => (scope as unknown as { sim: { scope: Sim } }).sim.scope;
  for (const r of scope.measureRows()) await scope.removeMeasurement(r.slot.id);
  // Two items set on the instrument (front panel, or an earlier session the app no longer knows of).
  sim().exec(":MEASure:ITEM VMAX,CHANnel1");
  sim().exec(":MEASure:ITEM VMIN,CHANnel2");
  sim().log.length = 0;
  await scope.addMeasurement("FREQuency", "CHANnel1");
  const log = sim().log;
  assert.ok(log.includes(":MEASure:DELete"), log.join(" | "));
  assert.deepEqual(log.slice(log.indexOf(":MEASure:DELete") + 1).filter((l) => /^:MEASure:ITEM /i.test(l)), [":MEASure:ITEM FREQuency,CHANnel1"]);
  // The second is simply added.
  sim().log.length = 0;
  await scope.addMeasurement("VPP", "CHANnel2");
  assert.ok(!sim().log.includes(":MEASure:DELete"));
  for (const r of scope.measureRows()) await scope.removeMeasurement(r.slot.id);
});

test("all-measure (AMSource): every single-source parameter of the channel, computed from the screen record — no queries, nothing added on the scope", async () => {
  type Sim = { log: string[]; exec: (m: string) => unknown };
  const sim = () => (scope as unknown as { sim: { scope: Sim } }).sim.scope;
  await scope.write("measure.amsource", "CHANnel1");
  sim().log.length = 0;
  await scope.frame();
  const a = scope.allMeasure!;
  assert.deepEqual(a.srcs, ["CHANnel1"]);
  assert.equal(a.points, 1000);
  const v = (item: string) => a.values.find((x) => x.item === item)!.value!;
  assert.ok(Math.abs(v("VPP") - 2) < 0.1, `VPP ${v("VPP")}`);
  assert.ok(Math.abs(v("PERiod") - 2e-4) < 4e-6, `PERiod ${v("PERiod")}`);
  assert.ok(a.values.length >= 20, `${a.values.length} parameters`);
  // The frame read the traces and nothing else: no :MEASure:ITEM? (each one would appear on the scope's own list).
  assert.ok(!sim().log.some((l) => /MEAS/i.test(l)), sim().log.join(" | "));
  await scope.write("measure.amsource", "OFF");
  await scope.frame();
  assert.equal(scope.allMeasure, null);
});

test("'show only this list on the scope': the instrument's measurements become exactly the app's", async () => {
  type Sim = { log: string[]; exec: (m: string) => unknown };
  const sim = () => (scope as unknown as { sim: { scope: Sim } }).sim.scope;
  for (const r of scope.measureRows()) await scope.removeMeasurement(r.slot.id);
  await scope.addMeasurement("FREQuency", "CHANnel1");
  // Items that got onto the scope some other way (an earlier version asked each all-measure item, which added it).
  sim().exec(":MEASure:ITEM VMAX,CHANnel1");
  sim().exec(":MEASure:ITEM VMIN,CHANnel1");
  sim().log.length = 0;
  await scope.syncMeasurements();
  const log = sim().log;
  assert.equal(log[0], ":MEASure:DELete");
  assert.deepEqual(log.filter((l) => /^:MEASure:ITEM /i.test(l)), [":MEASure:ITEM FREQuency,CHANnel1"]);
  for (const r of scope.measureRows()) await scope.removeMeasurement(r.slot.id);
});

test("spectrum of a full-rate capture: the whole bandwidth up to half the sample rate, or a chosen span at full resolution", async () => {
  const deep = new DeepStore();
  const meta = await deep.capture(scope, ["CHANnel1"], 1_000_000, true, () => {});
  const fs = 1 / meta.xinc;
  const full = deep.analyse("CHANnel1", 0, meta.points, "hann");
  assert.ok(Math.abs(full.nyquistHz - fs / 2) <= full.binDf, `bandwidth ${full.nyquistHz} of ${fs / 2}`);
  assert.equal(full.f0, 0);
  assert.ok(full.bins.length <= 4096, "a wide span is compressed for sending");
  // The 5 kHz generator signal (period 200 µs) is the top peak.
  const top = full.peaks[0];
  assert.ok(Math.abs(top.hz - 5000) < 3 * full.binDf, `top peak ${top.hz}`);
  // A narrow span around it: every bin of the record, nothing compressed, peaks only inside it.
  const span = deep.analyse("CHANnel1", 0, meta.points, "hann", 4000, 6000);
  assert.equal(span.df, span.binDf, "full resolution inside the span");
  assert.ok(span.f0 <= 4000 && span.f0 > 4000 - 2 * span.binDf, `starts at ${span.f0}`);
  assert.ok(span.f0 + span.df * (span.bins.length - 1) >= 6000 - span.binDf);
  assert.ok(span.peaks.length > 0 && span.peaks.every((p) => p.hz >= span.f0 && p.hz <= 6000 + span.binDf));
  assert.ok(Math.abs(span.peaks[0].hz - 5000) < 3 * span.binDf);
});
