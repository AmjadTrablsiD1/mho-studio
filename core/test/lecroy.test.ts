// LeCroy support without the instrument: VICP framing, the WAVEDESC
// descriptor, and LeCroy's reply formats. Each formula has two worked examples
// with numbers checked by hand.

import { test } from "node:test";
import assert from "node:assert/strict";
import { nextSeq, parseVicpHeader, replyOfMessage, vicpHeader, vicpMessage, VICP, VicpFramer } from "../src/scpi/vicp.ts";
import { after, buildLecroyWave, decodeLecroyWave, field, lecroyBool, lecroyIdn, lecroyNumber, parsePava, parseWavedesc, preambleOf } from "../src/scpi/lecroy.ts";
import { codes as wordCodes, toVolts } from "../src/wave/decode.ts";
import { familyOf, protocolForPort } from "../src/registry/families.ts";
import { LECROY_CONTROLS, LECROY_MEASUREMENTS } from "../src/registry/lecroy.ts";

const enc = new TextEncoder();
const close = (a: number, b: number, tol: number) => assert.ok(Math.abs(a - b) <= tol, `${a} ≠ ${b} (±${tol})`);

// ------------------------------------------------------------------- VICP

test("VICP header: operation, version 1, sequence, big-endian length", () => {
  // "*IDN?" is 5 bytes: header 80|01|40 = 0xC1, 01, seq 7, 00, 00 00 00 05.
  const m = vicpMessage(enc.encode("*IDN?"), 7);
  assert.deepEqual([...m.subarray(0, 8)], [0xc1, 0x01, 0x07, 0x00, 0x00, 0x00, 0x00, 0x05]);
  // A 70 000-byte block: 70000 = 0x00011170.
  assert.deepEqual([...vicpHeader(VICP.DATA | VICP.EOI, 255, 70000)], [0x81, 0x01, 0xff, 0x00, 0x00, 0x01, 0x11, 0x70]);
  assert.deepEqual(parseVicpHeader(vicpHeader(0x81, 3, 70000)), { op: 0x81, version: 1, seq: 3, length: 70000 });
});

test("sequence numbers run 1..255 and skip 0", () => {
  assert.equal(nextSeq(0), 1);
  assert.equal(nextSeq(254), 255);
  assert.equal(nextSeq(255), 1);
});

test("framer: bytes split anywhere, a message over several blocks, only EOI ends it", () => {
  const a = vicpHeader(VICP.DATA, 4, 3);
  const b = vicpHeader(VICP.DATA | VICP.EOI, 4, 4);
  const stream = new Uint8Array([...a, ...enc.encode("50E"), ...b, ...enc.encode("-3 V")]);
  for (let cut = 1; cut < stream.length; cut++) {
    const f = new VicpFramer();
    const got = [...f.push(stream.subarray(0, cut)), ...f.push(stream.subarray(cut))];
    assert.equal(got.length, 1, `cut at ${cut}`);
    assert.equal(new TextDecoder().decode(got[0].data), "50E-3 V");
    assert.equal(got[0].seq, 4);
  }
});

test("framer: an SRQ notice is not a reply; a non-VICP header is a framing error", () => {
  const f = new VicpFramer();
  const srq = new Uint8Array([...vicpHeader(VICP.DATA | VICP.SRQ | VICP.EOI, 0, 1), 0x31]);
  assert.deepEqual(f.push(srq), []);
  assert.throws(() => new VicpFramer().push(enc.encode("RIGOL TECHNOLOGIES,MHO984\n")), /not a VICP header/);
});

test("a whole message becomes a line, a block or raw bytes", () => {
  assert.deepEqual(replyOfMessage(enc.encode("50E-3 V\n")), { kind: "line", text: "50E-3 V" });
  // "ALL,#9000000004" + 4 data bytes (one of them a newline) + "\n": the block's 4 bytes.
  const blk = new Uint8Array([...enc.encode("ALL,#9000000004"), 1, 10, 3, 4, 10]);
  const r = replyOfMessage(blk);
  assert.equal(r.kind, "block");
  assert.deepEqual([...(r as { data: Uint8Array }).data], [1, 10, 3, 4]);
  // A '#' in text whose "length" does not fit the message is just text.
  assert.deepEqual(replyOfMessage(enc.encode("NOTE #12 OK")), { kind: "line", text: "NOTE #12 OK" });
  // A screen dump is binary without a block header.
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
  assert.equal(replyOfMessage(png).kind, "block");
});

// ---------------------------------------------------------- reply formats

test("numbers: a unit after a space is ignored, a glued suffix multiplies (MA is mega)", () => {
  assert.equal(lecroyNumber("50E-3 V"), 0.05);
  assert.equal(lecroyNumber("1E-6 S"), 1e-6);
  assert.equal(lecroyNumber("10MA"), 1e7);
  assert.equal(lecroyNumber("2.5K"), 2500);
  assert.equal(lecroyNumber("10M"), 0.01);
  assert.equal(lecroyNumber("-1.65"), -1.65);
  assert.equal(lecroyNumber("OFF"), null);
});

test("VBS booleans, identity with and without header, fields and pairs", () => {
  assert.equal(lecroyBool("-1"), true);
  assert.equal(lecroyBool("0"), false);
  assert.equal(lecroyBool("ON"), true);
  assert.deepEqual(lecroyIdn("*IDN LECROY,WM8ZI-A,LCRY1234,7.9.0"), { vendor: "LECROY", model: "WM8ZI-A", serial: "LCRY1234", firmware: "7.9.0", raw: "LECROY,WM8ZI-A,LCRY1234,7.9.0" });
  assert.equal(lecroyIdn("LECROY,SDA8ZI,X,6.1").model, "SDA8ZI");
  assert.equal(field("EDGE,SR,C1,HT,OFF", 0), "EDGE");
  assert.equal(after("EDGE,SR,C3,HT,OFF", "SR"), "C3");
  assert.equal(after("C1,OFF,C2,20MHZ,C3,OFF", "C2"), "20MHZ");
});

test("PAVA: value and state; a state that is not OK-ish gives no value", () => {
  assert.deepEqual(parsePava("PKPK,812.5E-3 V,OK"), { value: 0.8125, state: "OK" });
  assert.deepEqual(parsePava("C1,FREQ,10.00E6 HZ,AV"), { value: 10e6, state: "AV" });
  assert.deepEqual(parsePava("RISE,UNDEF,NP"), { value: null, state: "NP" });
});

test("family and protocol: LeCroy by *IDN? vendor, VICP by port 1861", () => {
  assert.equal(familyOf("LECROY,WM8ZI-A,LCRY1234,7.9.0"), "lecroy");
  assert.equal(familyOf("TELEDYNE LECROY,HDO6104,X,1"), "lecroy");
  assert.equal(familyOf("RIGOL TECHNOLOGIES,MHO984,X,00.01.00"), "rigol");
  assert.equal(protocolForPort(1861), "vicp");
  assert.equal(protocolForPort(5555), "raw");
});

// --------------------------------------------------------------- WAVEDESC

/**
 * volts = VERTICAL_GAIN × code − VERTICAL_OFFSET
 *  Example 1: 100 mV/div, 6400 codes/div → gain 15.625 µV/code; offset 0;
 *             code +6400 → +100 mV, code −3200 → −50 mV.
 *  Example 2: 1 V/div → gain 156.25 µV/code; offset −1.65 V (the trace moved down);
 *             code 0 → 1.65 V, code +6400 → 2.65 V.
 * time of point i = HORIZ_INTERVAL × i + HORIZ_OFFSET
 *  Example 1: 40 GS/s (25 ps), first point −500 ns: point 20000 → 0 s (the trigger).
 *  Example 2: sparsed ×20 (500 ps), first point −500 ns: point 1000 → 0 s; point 1999 → +499.5 ns.
 * HORIZ_INTERVAL is a 32-bit float in the descriptor, so a time 20 000 points out
 * is good to ~1e-14 s (float32 keeps ~7 digits); the checks allow 0.1 ps.
 */
test("WAVEDESC → volts and times (two worked examples each)", () => {
  const w1 = buildLecroyWave({ codes: Int16Array.from([6400, -3200, 0]), gain: 0.1 / 6400, offset: 0, interval: 25e-12, horizOffset: -500e-9, source: 0, instrument: "LECROYWM8ZI-A" });
  const d1 = decodeLecroyWave(w1);
  close(d1.volts[0], 0.1, 1e-6);
  close(d1.volts[1], -0.05, 1e-6);
  close(d1.desc.horizOffset + 20000 * d1.desc.interval, 0, 1e-13);

  const w2 = buildLecroyWave({ codes: Int16Array.from([0, 6400]), gain: 1 / 6400, offset: -1.65, interval: 500e-12, horizOffset: -500e-9, source: 1, instrument: "LECROYWM8ZI-A", order: "big" });
  const d2 = decodeLecroyWave(w2);
  assert.equal(d2.desc.order, "big");
  close(d2.volts[0], 1.65, 1e-6);
  close(d2.volts[1], 2.65, 1e-6);
  close(d2.desc.horizOffset + 1000 * d2.desc.interval, 0, 1e-13);
  close(d2.desc.horizOffset + 1999 * d2.desc.interval, 499.5e-9, 1e-13);
});

test("the descriptor is found after a block prefix and reads the template's fields", () => {
  const w = buildLecroyWave({ codes: Int16Array.from([1, 2, 3, 4]), gain: 1e-3, offset: 0.25, interval: 1e-9, horizOffset: -2e-9, source: 2, instrument: "LECROYSDA8ZI", firstPoint: 10, sparsing: 5 });
  const withJunk = new Uint8Array([0x20, 0x20, ...w]);
  const d = parseWavedesc(withJunk);
  assert.equal(d.template, "LECROY_2_3");
  assert.equal(d.commType, "word");
  assert.equal(d.count, 4);
  assert.equal(d.firstPoint, 10);
  assert.equal(d.sparsing, 5);
  assert.equal(d.source, 2);
  assert.equal(d.instrument, "LECROYSDA8ZI");
  assert.throws(() => parseWavedesc(enc.encode("not a waveform at all")), /no WAVEDESC/);
});

test("the app's preamble gives the same volts as the descriptor (unsigned codes, yref 32768)", () => {
  const signed = Int16Array.from([-12800, 0, 6400, 32000]);
  const w = buildLecroyWave({ codes: signed, gain: 0.2 / 6400, offset: 0.3, interval: 1e-10, horizOffset: 0, source: 0, instrument: "X" });
  const { desc, volts } = decodeLecroyWave(w);
  const pre = preambleOf(desc, signed.length);
  const u = Int32Array.from(signed, (c) => c + 32768);
  const v2 = toVolts(u, pre);
  for (let i = 0; i < volts.length; i++) close(v2[i], volts[i], 1e-6);
  // and the RIGOL decoder's WORD path agrees when fed the same unsigned codes as bytes
  const bytes = new Uint8Array(u.length * 2);
  u.forEach((c, i) => ((bytes[2 * i] = c & 0xff), (bytes[2 * i + 1] = c >> 8)));
  assert.deepEqual([...wordCodes(bytes, "WORD", "little")], [...u]);
});

// --------------------------------------------------------------- registry

test("LeCroy registry: shared ids for the common controls; every settable one has a set template", () => {
  const ids = new Set(LECROY_CONTROLS.map((c) => c.id));
  for (const id of ["channel.display", "channel.scale", "channel.offset", "timebase.scale", "trigger.edge.level", "trigger.edge.source", "trigger.sweep", "root.run", "root.stop", "root.single"]) assert.ok(ids.has(id), id);
  for (const c of LECROY_CONTROLS) {
    if (c.kind !== "action" && c.kind !== "readonly") assert.ok(c.w, `${c.id} has no set template`);
    if (c.query) assert.ok(c.q, `${c.id} has no query template`);
  }
  assert.ok(LECROY_MEASUREMENTS.every((m) => /^[A-Z0-9]+$/.test(m.item)));
});
