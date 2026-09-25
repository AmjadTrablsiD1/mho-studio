import { test } from "node:test";
import assert from "node:assert/strict";
import { compile, match, render, shortForm, splitMessage } from "../src/scpi/header.ts";
import { encode, matchOption, numericOption, parseBool, parseError, parseIdn, parseNumber } from "../src/scpi/values.ts";
import { makeBlock, parseBlockArg, ReplyReader } from "../src/scpi/block.ts";

test("short forms follow the capitals, numbers stay literal", () => {
  assert.equal(shortForm("CHANnel1"), "CHAN1");
  assert.equal(shortForm("HRESolution"), "HRES");
  assert.equal(shortForm("RFALl"), "RFAL");
  assert.equal(shortForm("FIFTy"), "FIFT");
  assert.equal(shortForm("20M"), "20M");
  assert.equal(shortForm("1k"), "1k");
  assert.equal(shortForm("RS232"), "RS232");
});

test("render puts the short form on the wire and drops optional nodes", () => {
  assert.equal(render(":CHANnel<n>:SCALe", { n: 2 }), ":CHAN2:SCAL");
  assert.equal(render(":TIMebase[:MAIN]:SCALe"), ":TIM:SCAL");
  assert.equal(render(":TIMebase[:MAIN][:OFFSet]"), ":TIM");
  assert.equal(render(":MATH<n>:SOURce1", { n: 3 }), ":MATH3:SOUR1");
  assert.equal(render(":LA:POD<n>:THReshold", { n: 2 }), ":LA:POD2:THR");
  assert.equal(render("*IDN"), "*IDN");
  assert.equal(render(":CHANnel<n>:SCALe", { n: 1 }, "long"), ":CHANNEL1:SCALE");
});

test("compiled headers accept short, long, any case, optional nodes and default suffix", () => {
  const c = compile(":CHANnel<n>:SCALe");
  assert.deepEqual(match(c, ":CHAN2:SCAL"), { n: 2 });
  assert.deepEqual(match(c, ":channel3:scale"), { n: 3 });
  assert.deepEqual(match(c, ":CHAN:SCAL"), { n: 1 });
  assert.equal(match(c, ":CHANN2:SCAL"), null, "in-between forms are not SCPI");
  const t = compile(":TIMebase[:MAIN]:SCALe");
  assert.ok(match(t, ":TIM:SCAL"));
  assert.ok(match(t, ":TIMEBASE:MAIN:SCALE"));
  const o = compile(":TIMebase[:MAIN][:OFFSet]");
  assert.ok(match(o, ":TIM"));
  assert.ok(match(o, ":TIM:MAIN:OFFS"));
  assert.ok(match(o, ":TIM:OFFSET"));
  assert.ok(match(compile("*IDN"), "*idn"));
});

test("a program message splits into units and relative headers inherit the path", () => {
  const u = splitMessage(":TRIG:EDGE:SOUR CHAN1;LEV 0.2;:WAV:DATA?");
  assert.deepEqual(u, [
    { header: ":TRIG:EDGE:SOUR", args: "CHAN1", query: false },
    { header: ":TRIG:EDGE:LEV", args: "0.2", query: false },
    { header: ":WAV:DATA", args: "", query: true },
  ]);
  const b = splitMessage(":SYST:SET #15a;b;c");
  assert.equal(b.length, 1, "a ';' inside a block is data");
  assert.equal(b[0].args, "#15a;b;c");
});

test("values: numbers, invalid measurements, bools, options by short form and by value", () => {
  assert.equal(parseNumber("5.000000E-02"), 0.05);
  assert.equal(parseNumber("9.9E37"), null);
  assert.equal(parseNumber("1k"), 1000);
  assert.equal(parseBool("1"), true);
  assert.equal(parseBool("OFF"), false);
  const slopes = ["POSitive", "NEGative", "RFALl"];
  assert.equal(matchOption("POS", slopes), "POSitive");
  assert.equal(matchOption("rfal", slopes), "RFALl");
  const depths = ["AUTO", "1k", "10k", "100k", "1M", "25M"];
  assert.equal(matchOption("1.000000E+04", depths), "10k");
  assert.equal(matchOption("2.5E+07", depths), "25M");
  assert.equal(matchOption("AUTO", depths), "AUTO");
  assert.equal(matchOption("CHAN2", ["CHANnel1", "CHANnel2"]), "CHANnel2");
  assert.equal(numericOption("2.5e7"), 2.5e7);
});

test("encode writes what the instrument parses", () => {
  assert.equal(encode(0.05, "number"), "0.05");
  assert.equal(encode(2e-9, "number"), "2e-9");
  assert.equal(encode(true, "bool"), "1");
  assert.equal(encode("POSitive", "enum"), "POS");
  assert.equal(encode("20M", "enum"), "20M");
  assert.equal(encode("a;b", "string"), "a b");
});

test("errors and identity parse", () => {
  assert.deepEqual(parseError('-113,"Undefined header; command cannot be found"'), { code: -113, message: "Undefined header; command cannot be found" });
  assert.deepEqual(parseError("0,No error"), { code: 0, message: "No error" });
  const id = parseIdn("RIGOL TECHNOLOGIES,MHO984,MHO9A0001,00.01.02\n");
  assert.equal(id.model, "MHO984");
  assert.equal(id.firmware, "00.01.02");
});

test("reply reader frames lines and blocks however the bytes are split", () => {
  const payload = new Uint8Array(3000);
  for (let i = 0; i < payload.length; i++) payload[i] = (i * 7) & 0xff; // contains many 0x0a bytes
  const enc = new TextEncoder();
  const stream = new Uint8Array([...enc.encode("RIGOL TECHNOLOGIES,MHO984,X,1\n"), ...makeBlock(payload), ...enc.encode("1.0E-3\r\n")]);
  for (const cut of [1, 2, 3, 7, 11, 64, 1000, stream.length]) {
    const r = new ReplyReader();
    const got = [];
    for (let i = 0; i < stream.length; i += cut) {
      r.push(stream.subarray(i, i + cut));
      let x;
      while ((x = r.next())) got.push(x);
    }
    assert.equal(got.length, 3, `cut ${cut}`);
    assert.deepEqual(got[0], { kind: "line", text: "RIGOL TECHNOLOGIES,MHO984,X,1" });
    assert.equal(got[1].kind, "block");
    assert.deepEqual((got[1] as { data: Uint8Array }).data, payload);
    assert.deepEqual(got[2], { kind: "line", text: "1.0E-3" });
  }
});

test("a block whose newline arrives late does not become an empty reply", () => {
  const r = new ReplyReader();
  const blk = makeBlock(new Uint8Array([1, 2, 3]));
  r.push(blk.subarray(0, blk.length - 1));
  assert.equal(r.next()?.kind, "block");
  r.push(new Uint8Array([0x0a]));
  r.push(new TextEncoder().encode("OK\n"));
  assert.deepEqual(r.next(), { kind: "line", text: "OK" });
});

test("block arguments parse back", () => {
  assert.deepEqual([...parseBlockArg("#15hello")!], [...new TextEncoder().encode("hello")]);
  assert.equal(parseBlockArg("hello"), null);
});
