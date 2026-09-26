import { test } from "node:test";
import assert from "node:assert/strict";
import { TMC, expectsReply, msgIn, msgOut, nextTag, parseInHeader, parseOut, replyComplete, requestIn, wholePackets } from "../src/scpi/usbtmc.ts";
import { makeBlock } from "../src/scpi/block.ts";

const enc = new TextEncoder();

test("DEV_DEP_MSG_OUT: header fields as USBTMC 1.0 table 3, payload padded to 4", () => {
  const m = msgOut(7, enc.encode("*IDN?\n"));
  assert.equal(m.length, 12 + 8); // 6 bytes → padded to 8
  assert.deepEqual([...m.subarray(0, 12)], [1, 7, 0xf8, 0, 6, 0, 0, 0, 1, 0, 0, 0]);
  assert.equal(new TextDecoder().decode(m.subarray(12, 18)), "*IDN?\n");
  assert.deepEqual([...m.subarray(18)], [0, 0]);
  const p = parseOut(m);
  assert.equal(p.size, 6);
  assert.equal(p.eom, true);
});

test("second example: a 4-byte payload needs no padding; EOM clear when asked", () => {
  const m = msgOut(255, enc.encode("RUN\n"), false);
  assert.equal(m.length, 16);
  assert.equal(m[2], 0x00);
  assert.equal(m[8], 0);
});

test("REQUEST_DEV_DEP_MSG_IN carries the size little-endian", () => {
  const r = requestIn(3, 1048576);
  assert.deepEqual([...r], [2, 3, 0xfc, 0, 0x00, 0x00, 0x10, 0x00, 0, 0, 0, 0]);
});

test("DEV_DEP_MSG_IN header parses; a bad complement or MsgID is refused", () => {
  const b = msgIn(9, enc.encode("1.0E-3\n"), true);
  assert.deepEqual(parseInHeader(b), { msgId: 2, tag: 9, size: 7, eom: true });
  const bad = b.slice();
  bad[2] = 0;
  assert.throws(() => parseInHeader(bad), /complement/);
  const wrong = b.slice();
  wrong[0] = 1;
  assert.throws(() => parseInHeader(wrong), /MsgID/);
  assert.throws(() => parseInHeader(new Uint8Array(4)), /shorter/);
});

test("tags run 1..255 and wrap without 0", () => {
  assert.equal(nextTag(0), 1);
  assert.equal(nextTag(254), 255);
  assert.equal(nextTag(255), 1);
});

test("which messages expect a reply", () => {
  assert.equal(expectsReply(enc.encode("*IDN?\n")), true);
  assert.equal(expectsReply(enc.encode(":WAV:DATA?\n")), true);
  assert.equal(expectsReply(enc.encode(":CHAN1:SCAL 0.5\n")), false);
  assert.equal(expectsReply(enc.encode(":MEAS:ITEM? VPP,CHAN1\n")), true);
  assert.equal(expectsReply(enc.encode(":TRIG:EDGE:SOUR CHAN1;:TRIG:STAT?\n")), true);
  // a block argument full of '?' is data, not a query
  assert.equal(expectsReply(enc.encode(':SYST:SET #210{"a":"??"}\n')), false);
});

test("a reply is complete when its line ends or its block is whole", () => {
  assert.equal(replyComplete(enc.encode("1.0E-3\n")), true);
  assert.equal(replyComplete(enc.encode("1.0E-3")), false);
  const blk = makeBlock(new Uint8Array(100).fill(0x0a));
  assert.equal(replyComplete(blk.subarray(0, 50)), false, "newlines inside a block do not end it");
  assert.equal(replyComplete(blk.subarray(0, blk.length - 1)), true);
  assert.equal(wholePackets(513, 512), 1024);
  assert.equal(TMC.rigolVendorId, 0x1ab1);
});
