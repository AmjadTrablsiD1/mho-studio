// The service against the simulated LeCroy X-Stream over real TCP and VICP:
// the same path a real LeCroy on port 1861 takes. What this cannot prove is
// listed in sim/README.md; it proves the app's half of the conversation.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.MHO_STUDIO_HOME = mkdtempSync(join(tmpdir(), "mho-studio-lecroy-"));

const { ScopeService } = await import("../scope.ts");
const { DeepStore } = await import("../deep.ts");
const { VicpStream } = await import("../vicp.ts");
const { probe } = await import("../discover.ts");
const { startLecroySim } = await import("../../sim/lecroy-server.ts");
const { vicpMessage, VicpFramer } = await import("../../core/src/scpi/vicp.ts");
const { C } = await import("../../core/src/constants.ts");

const events: { type: string; data: unknown }[] = [];
const scope = new ScopeService((type, data) => events.push({ type, data }));
after(async () => {
  await scope.disconnect();
});

const close = (a: number, b: number, tol: number, what = "") => assert.ok(Math.abs(a - b) <= tol, `${what} ${a} ≠ ${b} (±${tol})`);

test("connects over VICP, recognises a LeCroy, turns headers off and reads the primary settings", async () => {
  const link = await scope.connect({ sim: true, simModel: "lecroy" });
  assert.equal(link.state, "connected");
  assert.equal(link.family, "lecroy");
  assert.equal(link.protocol, "vicp");
  assert.equal(link.idn?.vendor, "LECROY");
  assert.equal(link.idn?.model, "WM8ZI-A");
  assert.equal(scope.values.get("channel.scale@1"), 0.1);
  assert.equal(scope.values.get("channel.offset@2"), -1.65);
  assert.equal(scope.values.get("channel.display@1"), true);
  assert.equal(scope.values.get("channel.display@3"), false);
  assert.equal(scope.values.get("channel.coupling@1"), "D1M");
  assert.equal(scope.values.get("timebase.scale"), 1e-7);
  assert.equal(scope.values.get("acquire.mdepth"), 100000);
  assert.equal(scope.values.get("acquire.srate"), 4e10);
  assert.equal(scope.values.get("trigger.sweep"), "AUTO");
  assert.equal(scope.values.get("trigger.mode"), "Edge");
  assert.equal(scope.values.get("trigger.edge.source"), "C1");
  assert.equal(scope.values.get("trigger.edge.slope"), "Positive");
  assert.equal(scope.values.get("acquire.mode"), "RealTime");
  assert.equal(scope.values.get("timebase.delay"), 0);
  assert.equal(await scope.readKey("channel.bwlimit@2"), "Full");
  assert.equal(scope.reg.family, "lecroy");
});

test("writes go out in LeCroy syntax and are read back", async () => {
  const r = await scope.write("channel.scale@1", 0.2);
  assert.equal(r.value, 0.2);
  assert.equal(r.coerced, false);
  await scope.write("trigger.edge.level", 0.05);
  assert.equal(scope.values.get("trigger.edge.level"), 0.05);
  await scope.write("channel.bwlimit@2", "20MHz");
  assert.equal(scope.values.get("channel.bwlimit@2"), "20MHz");
  await scope.write("channel.invert@1", true);
  assert.equal(scope.values.get("channel.invert@1"), true);
  await scope.write("channel.invert@1", false);
  await scope.write("channel.scale@1", 0.1);
  const sim = (scope as unknown as { sim: { port: number } }).sim;
  assert.ok(sim.port > 0);
});

test("setting the trigger source re-reads level and slope of the new source", async () => {
  await scope.write("trigger.edge.source", "C2");
  assert.equal(scope.values.get("trigger.edge.source"), "C2");
  assert.equal(scope.values.get("trigger.edge.level"), 1.65);
  await scope.write("trigger.edge.source", "C1");
  assert.equal(scope.values.get("trigger.edge.level"), 0.05);
});

test("channel names: written as LabelsText, switched on with ViewLabels, shown back", async () => {
  const r = await scope.write("channel.label.content@1", "VIN 'probe' \"A\"");
  assert.equal(r.value, "VIN probe A");
  assert.equal(scope.values.get("channel.label.show@1"), true);
  const sim = (scope as unknown as { sim: { scope: { log: string[] } } }).sim.scope;
  assert.ok(sim.log.some((l) => l === `VBS 'app.Acquisition.C1.LabelsText = "VIN probe A"'`));
  assert.ok(sim.log.some((l) => l === "VBS 'app.Acquisition.C1.ViewLabels = True'"));
  await scope.write("channel.label.content@1", "");
});

test("every trigger type of the automation manual can be chosen, and its own fields set", async () => {
  for (const t of ["Width", "Glitch", "Interval", "Dropout", "Logic", "Qualify", "State", "Edge"]) {
    const r = await scope.write("trigger.mode", t);
    assert.equal(r.value, t);
  }
  await scope.write("trigger.mode", "Width");
  await scope.write("trigger.width.range", "Delta");
  assert.equal((await scope.write("trigger.width.nominal", 10e-9)).value, 10e-9);
  await scope.write("trigger.mode", "Logic");
  await scope.write("trigger.logic.type", "Nand");
  await scope.write("trigger.logic.state@3", "High");
  assert.equal(await scope.readKey("trigger.logic.state@3"), "High");
  await scope.write("trigger.holdoff.type", "Time");
  assert.equal((await scope.write("trigger.holdoff", 2e-6)).value, 2e-6);
  // A value outside the manual's list is refused by the app before it reaches the scope.
  await assert.rejects(scope.write("trigger.mode", "Runt"), /not one of the options/);
  await scope.write("trigger.mode", "Edge");
  await scope.write("trigger.holdoff.type", "Off");
});

test("trigger position (HorOffset) moves the record; the screen centre follows", async () => {
  await scope.write("timebase.delay", 200e-9);
  await scope.frame();
  close(Number(scope.values.get("timebase.offset")), -200e-9, 1e-9, "centre after +200 ns");
  await scope.write("timebase.delay", 0);
  await scope.frame();
});

test("sequence mode and its segment count; segments only matter in sequence mode", async () => {
  await scope.write("acquire.mode", "Sequence");
  assert.equal((await scope.write("acquire.segments", 500)).value, 500);
  await scope.write("acquire.mode", "RealTime");
});

test("a live frame: sparsed to ~2000 points, decoded in volts, screen centre from the descriptor", async () => {
  await scope.frame();
  const a = scope.latest.get("CHANnel1")!;
  // 100 ns/div at 40 GS/s is 40 000 points; every 20th → 2000 points 500 ps apart.
  assert.equal(a.volts.length, 2000);
  close(a.pre.xinc, 500e-12, 1e-15, "xinc");
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of a.volts) {
    lo = Math.min(lo, v);
    hi = Math.max(hi, v);
  }
  close(hi - lo, C.lecroy.sim.ch1_vpp, 0.03, "CH1 Vpp");
  close(Number(scope.values.get("timebase.offset")), 0, 1e-9, "screen centre");
  const b = scope.latest.get("CHANnel2")!;
  close(Math.max(...b.volts), C.sim.clock_v, 0.5, "clock high");
});

test("measurements come from PARAMETER_VALUE? and agree with the app's own cross-check", async () => {
  await scope.addMeasurement("PKPK", "CHANnel1");
  await scope.addMeasurement("FREQ", "CHANnel1");
  await scope.frame();
  await (scope as unknown as { readMeasurements: () => Promise<void> }).readMeasurements();
  const rows = scope.measureRows();
  const pk = rows.find((r) => r.slot.item === "PKPK")!;
  const f = rows.find((r) => r.slot.item === "FREQ")!;
  close(pk.value!, 0.8, 0.03, "PKPK");
  close(pk.cross!, 0.8, 0.03, "PKPK cross");
  close(f.value!, C.lecroy.sim.ch1_sine_hz, 2e5, "FREQ");
  close(f.cross!, C.lecroy.sim.ch1_sine_hz, 2e5, "FREQ cross");
  await assert.rejects(scope.addMeasurement("VMAX", "CHANnel1"), /unknown measurement/);
  for (const r of rows) await scope.removeMeasurement(r.slot.id);
});

test("run / stop / single map to TRMD; Run returns to the last running mode", async () => {
  await scope.write("trigger.sweep", "NORM");
  await scope.action("root.stop", null);
  assert.equal(scope.status, "STOP");
  await scope.action("root.run", null);
  assert.notEqual(scope.status, "STOP");
  assert.equal((await scope.readKey("trigger.sweep")), "NORM");
  await scope.action("root.single", null);
  await scope.frame(); // the single acquisition happens
  assert.equal(await scope.drv.status(), "STOP");
  await scope.write("trigger.sweep", "AUTO");
});

test("an unanswered query fails alone (LeCroy stays silent and sets CMR); the link stays", async () => {
  const r = await scope.console("C1:NOSUCH?");
  assert.equal(r.reply, null);
  assert.match(r.errors[0].message, /no reply/);
  assert.ok(r.errors.some((e) => e.code === 1 && /unrecognized/.test(e.message)));
  assert.equal(scope.link.state, "connected");
  assert.equal(await scope.readKey("channel.scale@1"), 0.1);
  const v = await scope.console("VBS? 'return=app.Acquisition.Horizontal.SampleMode'");
  assert.equal(v.reply, "RealTime");
});

test("a late reply to an abandoned query is dropped by its VICP sequence number", async () => {
  // A fake instrument: ignores "A?" until "B?" arrives, then answers A late and B on time.
  const server = net.createServer((sock) => {
    const f = new VicpFramer();
    let seqA = 0;
    sock.on("data", (d) => {
      for (const m of f.push(new Uint8Array(d))) {
        const text = new TextDecoder().decode(m.data);
        if (text === "A?") seqA = m.seq;
        if (text === "B?") {
          sock.write(vicpMessage(new TextEncoder().encode("late answer to A\n"), seqA, false));
          sock.write(vicpMessage(new TextEncoder().encode("b\n"), m.seq, false));
        }
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as net.AddressInfo).port;
  const tcp = net.connect({ host: "127.0.0.1", port });
  await new Promise((r) => tcp.once("connect", r));
  const s = new VicpStream(tcp);
  const got: string[] = [];
  s.on("reply", (r: { kind: string; text?: string }) => got.push(r.text ?? ""));
  s.write("A?\n");
  s.write("B?\n");
  await new Promise((r) => setTimeout(r, 150));
  assert.deepEqual(got, ["b"]);
  assert.equal(s.dropped, 1);
  s.destroy();
  server.close();
});

test("screenshot: SCDP after HCSU, raw PNG bytes", async () => {
  const img = await scope.screenshot();
  assert.deepEqual([...img.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
});

test("deep capture reads every point in chunks; a sparsed screen record is every Nth of them", async () => {
  await scope.write("timebase.scale", 1e-4);
  await scope.write("acquire.mdepth", 10_000_000);
  // 1 ms window, 10 Mpts of memory → 10 GS/s; the maximum rate does not bind.
  assert.equal(scope.values.get("acquire.srate"), 1e10);
  await scope.action("root.stop", null);
  const sparse = await scope.readTrace("CHANnel1");
  const sp = Math.ceil(10_000_000 / C.lecroy.screen_points);
  const deep = new DeepStore();
  let chunks = 0;
  const meta = await deep.capture(scope, ["CHANnel1"], 2_500_000, false, () => chunks++);
  assert.equal(meta.points, 2_500_000);
  assert.equal(chunks, Math.ceil(2_500_000 / C.lecroy.deep_chunk_points));
  close(meta.xinc, 1e-10, 1e-16, "deep xinc");
  close(meta.xorigin, sparse.pre.xorigin, 1e-12, "same first point");
  const v = deep.volts("CHANnel1", 0, 2_500_000);
  for (const k of [0, 1, 7, 100, Math.floor(2_499_999 / sp)]) close(v[k * sp], sparse.volts[k], 1e-6, `point ${k}`);
  await scope.write("acquire.mdepth", 100000);
  await scope.write("timebase.scale", 1e-7);
  await scope.action("root.run", null);
});

test("a setup file (PNSU) goes out as a block and comes back", async () => {
  const blob = await scope.setupBlob();
  assert.match(new TextDecoder().decode(blob), /C1:VDIV/);
  await scope.write("channel.scale@1", 0.5);
  await scope.restoreSetup(blob);
  assert.equal(await scope.readKey("channel.scale@1"), 0.1);
});

test("features this family lacks are refused, not attempted", async () => {
  await assert.rejects(scope.syncClock(), /not offered/);
  await assert.rejects(scope.busTable(1), /not offered/);
  await assert.rejects(scope.write("source.frequency@1", 1000), /no control/);
});

test("discovery finds a LeCroy by asking *IDN? inside a VICP frame", async () => {
  const h = await startLecroySim(0);
  try {
    const f = await probe("127.0.0.1", h.port, 1000, "vicp");
    assert.equal(f?.model, "WM8ZI-A");
    assert.equal(await probe("127.0.0.1", h.port, 500, "raw"), null);
  } finally {
    await h.close();
  }
});

test("the same service then drives the simulated MHO984 with the RIGOL driver", async () => {
  const link = await scope.connect({ sim: true, simModel: "rigol" });
  assert.equal(link.family, "rigol");
  assert.equal(link.protocol, "raw");
  assert.equal(scope.values.get("channel.scale@1"), 0.5);
  assert.equal(scope.values.get("trigger.edge.slope"), "POSitive");
});
