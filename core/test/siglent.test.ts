// Siglent-made scopes (Teledyne T3DSO1204): parsing and framing, checked
// against bytes the real instrument sent on 2026-10-14 (fixtures/t3dso1204/).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { familyOf } from "../src/registry/families.ts";
import { esrErrors, parseSiglentPava, siglentCodes, siglentIdn, siglentNumber, siglentT0, siglentVolts } from "../src/scpi/siglent.ts";
import { ReplyReader, type Reply } from "../src/scpi/block.ts";
import { bmpLength, decodeBmp, encodeBmp565 } from "../src/img/bmp.ts";

const fx = (name: string) => new Uint8Array(readFileSync(new URL(`./fixtures/t3dso1204/${name}`, import.meta.url)));
const enc = new TextEncoder();
const close = (a: number, b: number, tol: number, what = "") => assert.ok(Math.abs(a - b) <= tol, `${what} ${a} ≠ ${b} (±${tol})`);

/** Feed `bytes` in pieces of `step`, collecting every reply. */
function feed(r: ReplyReader, bytes: Uint8Array, step: number): Reply[] {
  const out: Reply[] = [];
  for (let i = 0; i < bytes.length; i += step) {
    r.push(bytes.subarray(i, i + step));
    for (let x = r.next(); x; x = r.next()) out.push(x);
  }
  return out;
}

const cat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};

test("the T3DSO1204 answers 'Lecroy,…' but is a Siglent-made scope; LeCroy and RIGOL stay what they are", () => {
  const idn = new TextDecoder().decode(fx("idn.bin"));
  assert.equal(familyOf(idn), "siglent");
  assert.equal(siglentIdn(idn).model, "T3DSO1204", "the model's trailing space is trimmed");
  assert.equal(familyOf("Siglent Technologies,SDS1204X-E,SDSMMEBQ4R5097,8.1.6.1.37R2"), "siglent");
  assert.equal(familyOf("LECROY,WM8ZI-A,LCRY0000SIM,7.9.0"), "lecroy");
  assert.equal(familyOf("RIGOL TECHNOLOGIES,MHO984,MHO9A000000,00.01.00"), "rigol");
});

test("numbers as the instrument writes them, with and without headers and units", () => {
  const cases: [string, number | null][] = [
    ["1.00E+00", 1], ["1.00E+00V", 1], ["5.00E+08Sa/s", 5e8], ["-0.00E+00S", -0], ["2.00E+00", 2], ["7M", 7e6], ["700K", 7e5], ["1.4M", 1.4e6], ["14K", 14e3],
    ["10", 10], ["3.50E+02pts", 350], ["OFF", null], ["", null],
  ];
  for (const [s, want] of cases) assert.equal(siglentNumber(s), want, s);
  assert.deepEqual(parseSiglentPava("PKPK,4.000000E-02"), { value: 0.04, state: "OK" });
  assert.deepEqual(parseSiglentPava("C2:PAVA MEAN,-1.766000E-02V"), { value: -0.01766, state: "OK" });
  assert.deepEqual(parseSiglentPava("FREQ,****"), { value: null, state: "****" });
  assert.deepEqual(esrErrors(48).map((e) => e.code), [-100, -200], "*ESR? 48 = command + execution error (seen on the real one)");
});

test("volts and times: code × V/div / 25 − offset; first point at −delay − 7 divisions", () => {
  // The real CH2 at 1 V/div read 0 and ±1 codes, and its own PKPK was 40 mV: one code is 40 mV.
  const v = siglentVolts(Int8Array.from([0, 1, -1, 100, -128]), { vdiv: 1, ofst: 0 }, 25);
  assert.deepEqual(Array.from(v, (x) => Math.round(x * 1e6) / 1e6), [0, 0.04, -0.04, 4, -5.12]);
  close(siglentVolts(Int8Array.from([25]), { vdiv: 0.2, ofst: -1.65 }, 25)[0], 1.85, 1e-6, "offset subtracted");
  // 50 ns/div, 14 divisions, no delay: the record starts 350 ns before the trigger (350 points at 500 MSa/s, as the real one sent).
  close(siglentT0({ tdiv: 50e-9, trdl: 0, sara: 5e8 }, 14), -350e-9, 1e-15, "t0");
  close(siglentT0({ tdiv: 50e-9, trdl: 100e-9, sara: 5e8 }, 14, 10), -430e-9, 1e-15, "t0 with delay, from point 10");
});

test("a real DAT2 reply: the 'DAT2,' before the block and both newlines after it are dropped, in any chunking", () => {
  const dat2 = fx("c2-wf-dat2.bin");
  assert.equal(dat2.length, 368, "DAT2,#9000000350 + 350 bytes + \\n\\n");
  const next = enc.encode("Lecroy,T3DSO1204 ,T0101C22230356,8.3.6.1.37R8\n");
  for (const step of [1, 3, 17, 64, 1000]) {
    const r = new ReplyReader();
    r.framing = { blockPrefix: true, blockTrailer: 2 };
    const replies = feed(r, cat(dat2, next), step);
    assert.equal(replies.length, 2, `chunks of ${step}`);
    assert.equal(replies[0].kind, "block");
    const codes = siglentCodes((replies[0] as { data: Uint8Array }).data);
    assert.equal(codes.length, 350);
    assert.ok(codes.every((c) => c >= -1 && c <= 1), "the real record was noise of ±1 code");
    assert.deepEqual(replies[1], { kind: "line", text: "Lecroy,T3DSO1204 ,T0101C22230356,8.3.6.1.37R8" });
  }
  // With the header on ("C2:WF DESC,#9…") the same.
  const r = new ReplyReader();
  r.framing = { blockPrefix: true, blockTrailer: 2 };
  const [d] = feed(r, fx("c2-wf-desc.bin"), 50);
  assert.equal(d.kind, "block");
  assert.equal((d as { data: Uint8Array }).data.length, 346);
  // Without the Siglent framing, a plain RIGOL reader still treats text with a '#' in it as a line.
  const plain = new ReplyReader();
  assert.deepEqual(feed(plain, enc.encode("CH1 #2 probe,ON\n"), 4), [{ kind: "line", text: "CH1 #2 probe,ON" }]);
});

test("a real screenshot: a raw BMP framed by its own length, 800×480 RGB565 top-down", () => {
  const bmp = new Uint8Array(gunzipSync(fx("scdp.bmp.gz")));
  assert.equal(bmp.length, 768067, "768066 bytes of BMP + \\n");
  assert.equal(bmpLength(bmp), 768066);
  const r = new ReplyReader();
  r.framing = { blockPrefix: true, blockTrailer: 2 };
  r.expectBmp = true;
  const replies = feed(r, cat(bmp, enc.encode("Lecroy,T3DSO1204 ,x,y\n")), 65536);
  assert.equal(replies.length, 2);
  const img = decodeBmp((replies[0] as { data: Uint8Array }).data);
  assert.deepEqual([img.w, img.h], [800, 480]);
  assert.equal((replies[1] as { text: string }).text, "Lecroy,T3DSO1204 ,x,y");
  // The screen is not one colour: there is a picture in it.
  const colours = new Set<number>();
  for (let i = 0; i < img.rgb.length; i += 3 * 97) colours.add((img.rgb[i] << 16) | (img.rgb[i + 1] << 8) | img.rgb[i + 2]);
  assert.ok(colours.size > 5, `${colours.size} colours`);
  // Round trip through the simulator's encoder (RGB565 keeps the top 5/6/5 bits).
  const back = decodeBmp(encodeBmp565(img));
  assert.deepEqual([back.w, back.h], [800, 480]);
  for (let i = 0; i < img.rgb.length; i += 997) assert.ok(Math.abs(back.rgb[i] - img.rgb[i]) <= 8, `pixel byte ${i}`);
});
