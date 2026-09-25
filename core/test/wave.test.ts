import { test } from "node:test";
import assert from "node:assert/strict";
import { codes, detectWordOrder, formatPreamble, parsePreamble, toVolts } from "../src/wave/decode.ts";
import { offsetLimit, scaleLimits, snap125, step125, stepFine } from "../src/wave/steps.ts";
import { fmt, parseSI, si } from "../src/format.ts";
import { BY_ID, CONTROLS, key, parseKey, relevant } from "../src/registry/controls.ts";
import { MEASUREMENTS } from "../src/registry/measurements.ts";
import { compile } from "../src/scpi/header.ts";

test("the guide's own preamble example decodes", () => {
  const p = parsePreamble("0,0,1000,1,1.000000E-8,-5.000000E-6,0.000000E-12,4.000000E-03,0,128");
  assert.equal(p.format, "BYTE");
  assert.equal(p.points, 1000);
  assert.equal(p.yref, 128);
  // Guide: volts = (0x8E − YORigin − YREFerence) × YINCrement = (142 − 0 − 128) × 4 mV = 56 mV
  const v = toVolts(codes(new Uint8Array([0x8e]), "BYTE"), p);
  assert.ok(Math.abs(v[0] - 0.056) < 1e-6);
  assert.deepEqual(parsePreamble(formatPreamble(p)), p);
});

test("second example: WORD, non-zero YORigin (offset), little-endian", () => {
  const p = parsePreamble("1,0,2,1,1.0E-6,0,0,2.666667E-05,-3750,32768");
  // 0.2 V/div → yinc = 0.2/7500; offset −0.1 V → yorigin = offset/yinc = −3750 (guide §3.28.10)
  const data = new Uint8Array([0x00, 0x80, 0x10, 0x81]); // 32768, 33040
  const v = toVolts(codes(data, "WORD", "little"), p);
  assert.ok(Math.abs(v[0] - 3750 * 2.666667e-5) < 1e-6); // 0.1 V
  assert.ok(Math.abs(v[1] - (33040 - 32768 + 3750) * 2.666667e-5) < 1e-6);
  assert.throws(() => parsePreamble("1,2,3"));
});

test("word order is detected from smoothness, both ways", () => {
  const n = 1000;
  const le = new Uint8Array(2 * n);
  const be = new Uint8Array(2 * n);
  for (let i = 0; i < n; i++) {
    const c = 32768 + Math.round(9000 * Math.sin(i / 20));
    le[2 * i] = c & 0xff;
    le[2 * i + 1] = c >> 8;
    be[2 * i] = c >> 8;
    be[2 * i + 1] = c & 0xff;
  }
  const a = detectWordOrder(le);
  const b = detectWordOrder(be);
  assert.equal(a.order, "little");
  assert.equal(b.order, "big");
  assert.ok(a.confidence > 8 && b.confidence > 8);
});

test("1-2-5 knob and fine steps", () => {
  assert.equal(step125(0.05, 1), 0.1);
  assert.equal(step125(0.1, 1), 0.2);
  assert.equal(step125(0.2, -1), 0.1);
  assert.equal(step125(1e-9, -1), 5e-10);
  assert.ok(Math.abs(step125(0.3, 1) - 0.5) < 1e-12, "off-sequence snaps up");
  assert.ok(Math.abs(step125(0.3, -1) - 0.2) < 1e-12, "and down");
  assert.equal(snap125(0.19), 0.2);
  assert.equal(stepFine(0.1, 1), 0.101);
});

test("offset limits follow guide §3.6.5 at both impedances", () => {
  assert.equal(offsetLimit(0.05, "OMEG"), 1);
  assert.equal(offsetLimit(0.1, "OMEG"), 10);
  assert.equal(offsetLimit(1, "OMEG"), 20);
  assert.equal(offsetLimit(5, "OMEG"), 100);
  assert.equal(offsetLimit(0.1, "FIFTy"), 1);
  assert.equal(offsetLimit(0.5, "FIFTy"), 4);
  assert.equal(offsetLimit(1, "OMEG", 10), 100, "10× probe: 0.1 V/div at the input → ±10 V there, ±100 V at the tip");
  assert.deepEqual(scaleLimits("FIFT"), [0.0002, 1]);
});

test("formatter: digits the number deserves, prefixes, parsing what people type", () => {
  assert.deepEqual(si(0.0002, "V"), { value: "200", unit: "µV" });
  assert.deepEqual(si(1234567, "Hz"), { value: "1.23", unit: "MHz" });
  assert.deepEqual(si(2e-6, "s/div"), { value: "2", unit: "µs/div" });
  assert.equal(fmt(45.678, "%"), "45.7 %");
  assert.equal(fmt(2.5e7, "pts"), "25 Mpts");
  assert.equal(fmt(null, "V"), "— V");
  assert.equal(parseSI("200m"), 0.2);
  assert.equal(parseSI("200 mV"), 0.2);
  assert.equal(parseSI("1.5k"), 1500);
  assert.equal(parseSI("2us"), 2e-6);
  assert.equal(parseSI("2µs"), 2e-6);
  assert.equal(parseSI("abc"), null);
});

test("registry: every control compiles, ids are unique, curated facts are there", () => {
  const ids = new Set<string>();
  for (const c of CONTROLS) {
    assert.ok(!ids.has(c.id), `duplicate ${c.id}`);
    ids.add(c.id);
    assert.ok(compile(c.header).re instanceof RegExp);
    if (c.kind === "enum" && !c.hidden) assert.ok(c.options && c.options.length, `${c.id} has no options`);
    if (c.when) assert.ok(BY_ID.has(c.when.id), `${c.id} depends on unknown ${c.when.id}`);
    for (const a of c.after ?? []) assert.ok(BY_ID.has(a), `${c.id} re-reads unknown ${a}`);
  }
  assert.ok(CONTROLS.length > 600, `${CONTROLS.length} controls`);
  const scale = BY_ID.get("channel.scale")!;
  assert.equal(scale.step, "125");
  assert.deepEqual(scale.suffix?.values, [1, 2, 3, 4]);
  assert.equal(BY_ID.get("trigger.edge.slope")!.options!.find((o) => o.value === "POSitive")!.label, "Rising");
  assert.equal(BY_ID.get("source.output.state")!.confirm !== undefined, true);
  assert.equal(key("channel.scale", 2), "channel.scale@2");
  assert.deepEqual(parseKey("channel.scale@2"), { id: "channel.scale", n: 2 });
  assert.equal(MEASUREMENTS.length, 41);
});

test("relevance: pulse fields only while the trigger type is Pulse; bus fields bind to their own bus", () => {
  const uw = BY_ID.get("trigger.pulse.uwidth")!;
  assert.equal(relevant(uw, null, () => "EDGE"), false);
  assert.equal(relevant(uw, null, () => "PULS"), true);
  const baud = BY_ID.get("bus.rs232.baud")!;
  const vals: Record<string, string> = { "bus.mode@1": "SPI", "bus.mode@2": "RS232" };
  assert.equal(relevant(baud, 1, (k) => vals[k]), false);
  assert.equal(relevant(baud, 2, (k) => vals[k]), true);
});
