// The STM32 board's 16-byte command link: packets, the stream reader that
// separates ACKs from the printf log, and the Si5351 payloads.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AckReader, CMD_MAGIC, Cmd, DATA_MAGIC, dacSourceText, decodeClkFreq, decodeDacSine, decodeDacStatus, decodeVersion, encodeClkFlags, encodeClkFreq, encodeDacSine, encodeDacSineReply,
  encodeDacStatus, encodeVersion, getU48, packAck, packCmd, parseCmd, putU48, type Ack,
} from "../src/board/protocol.ts";
import { cycleHz } from "../src/dsp/bode.ts";

test("a command packet is 16 bytes, little-endian, as the firmware expects", () => {
  const p = packCmd(Cmd.ClkFreq, 0x1234, encodeClkFreq(1, 1000000.5, true));
  assert.equal(p.length, 16);
  assert.deepEqual([...p.subarray(0, 8)], [0x5a, 0x5a, 0xde, 0xc0, 0x34, 0x12, 0x71, 0x00]);
  assert.equal(p[8], 1);
  assert.equal(p[9], 1);
  assert.equal(getU48(p, 10), 100000050);
  const back = parseCmd(p)!;
  assert.equal(back.seq, 0x1234);
  assert.equal(back.cmd, Cmd.ClkFreq);
  assert.equal(new DataView(p.buffer).getUint32(0, true), CMD_MAGIC);
});

test("u48 holds the Si5351's whole range in 0.01 Hz", () => {
  const b = new Uint8Array(8);
  for (const v of [0, 1, 250000, 20_000_000_000, 2 ** 48 - 1]) {
    putU48(b, 2, v);
    assert.equal(getU48(b, 2), v);
  }
});

test("the reader finds ACKs among log text, across any chunking, and skips data frames", () => {
  const acks: Ack[] = [];
  const lines: string[] = [];
  const r = new AckReader();
  r.onAck = (a) => acks.push(a);
  r.onText = (l) => lines.push(l);
  const enc = new TextEncoder();
  const data = new Uint8Array(12 + 5);
  new DataView(data.buffer).setUint32(0, DATA_MAGIC, true);
  new DataView(data.buffer).setUint16(6, 5, true);
  data.set([0x5a, 0x5a, 0xed, 0xac, 0x00], 12); // an ACK magic inside a data frame is payload, not an ACK
  const stream = new Uint8Array([
    ...enc.encode("SI5351: CLK0 on at 1000.00 Hz\r\n"),
    ...packAck(7, Cmd.ClkGet, 0, Uint8Array.of(0, 1, 0x40, 0x42, 0x0f, 0, 0, 0)),
    ...data,
    ...enc.encode("Z"), // the first byte of both magics
    ...enc.encode("ZZ tail\n"),
    ...packAck(8, Cmd.Ping, 0, enc.encode("mhostud!")),
  ]);
  for (const step of [1, 3, 5, 16, 1000]) {
    acks.length = 0;
    lines.length = 0;
    for (let i = 0; i < stream.length; i += step) r.push(stream.subarray(i, i + step));
    assert.deepEqual(acks.map((a) => a.seq), [7, 8], `chunks of ${step}`);
    assert.deepEqual(lines, ["SI5351: CLK0 on at 1000.00 Hz", "ZZZ tail"], `chunks of ${step}`);
    assert.equal(decodeClkFreq(acks[0].payload).hz, 10000);
  }
});

test("ClkFreq/ClkGet flags describe the output as it is", () => {
  const p = new Uint8Array(8);
  p[0] = 2;
  p[1] = encodeClkFlags({ on: true, pllB: true, integer: false, shared: true, unreachable: false, sweeping: true, drive: 3 });
  putU48(p, 2, 123456789);
  const c = decodeClkFreq(p);
  assert.deepEqual(c, { ch: 2, on: true, pllB: true, integer: false, shared: true, unreachable: false, sweeping: true, drive: 3, hz: 1234567.89 });
  assert.equal(p[1], 0x01 | 0x02 | 0x08 | 0x20 | 0xc0);
});

test("version: protocol, firmware and the build date", () => {
  assert.deepEqual(decodeVersion(encodeVersion({ protocol: 22, firmware: 2, day: 5, month: 9, year: 2026 })), { protocol: 22, firmware: 2, built: "2026-09-05" });
});

test("cycleHz reads a square's and a sine's rate, and nothing from noise-free flat lines", () => {
  const dt = 1e-6;
  const sq = Float32Array.from({ length: 1000 }, (_, i) => ((i * dt * 4000) % 1 < 0.5 ? 3.3 : 0));
  assert.ok(Math.abs(cycleHz(sq, dt)! / 4000 - 1) < 0.01);
  const sine = Float32Array.from({ length: 1000 }, (_, i) => Math.sin(2 * Math.PI * 7000 * i * dt) + 0.02 * Math.sin(i * 1.7));
  assert.ok(Math.abs(cycleHz(sine, dt)! / 7000 - 1) < 0.02);
  assert.equal(cycleHz(new Float32Array(1000), dt), null);
});

test("DacSine: f32 frequency, peak and centre in mV; the reply is what came out", () => {
  const p = encodeDacSine(1234.5, 500, 1650);
  const v = new DataView(p.buffer);
  assert.equal(v.getFloat32(0, true), 1234.5);
  assert.equal(v.getUint16(4, true), 500);
  assert.equal(v.getUint16(6, true), 1650);
  assert.deepEqual(decodeDacSine(encodeDacSineReply({ hz: 7005.75, rateHz: 399328 })), { hz: 7005.75, rateHz: 399328 });
  const st = { running: true, source: 0x13, length: 4096, rateHz: 100000 };
  assert.deepEqual(decodeDacStatus(encodeDacStatus(st)), st);
  assert.equal(dacSourceText(st), "stored waveform 3");
  assert.equal(dacSourceText({ ...st, running: false }), "idle");
});
