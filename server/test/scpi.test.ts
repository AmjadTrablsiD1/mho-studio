// The SCPI client's one rule: one query on the line at a time. A fake
// instrument answers each query with its own name after a delay and counts how
// many are outstanding at once — more than one means replies get paired with
// the wrong questions (MHO984, 2026-10-17: ":CHAN1:SCAL?" → "OMEG").

import { test } from "node:test";
import assert from "node:assert/strict";
import { Duplex } from "node:stream";

const { ScpiClient } = await import("../scpi.ts");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Answers "X?" with "X" after `delayMs`; records the most queries ever outstanding. */
function fakeInstrument(delayMs = 15) {
  let outstanding = 0;
  const seen = { max: 0 };
  const d = new Duplex({
    read() {},
    write(chunk, _enc, done) {
      for (const line of String(chunk).split("\n").filter(Boolean)) {
        if (!line.endsWith("?")) continue;
        outstanding++;
        seen.max = Math.max(seen.max, outstanding);
        setTimeout(() => {
          outstanding--;
          d.push(`${line.slice(0, -1)}\n`);
        }, delayMs);
      }
      done();
    },
  });
  return { conn: d, seen };
}

test("a call from a timer set inside a finished section waits its turn; it does not inherit the lock", async () => {
  const { conn, seen } = fakeInstrument();
  const scpi = new ScpiClient();
  scpi.attach(conn, "fake", 0);
  let leaked!: Promise<string>;
  await scpi.exclusive(async () => {
    assert.equal(await scpi.query("A?"), "A");
    // A backstop timer, a reconnect, a next loop iteration: started here, running later.
    leaked = new Promise((resolve, reject) => setTimeout(() => scpi.query("LEAK?").then(resolve, reject), 25));
  });
  const other = scpi.exclusive(async () => {
    await sleep(20);
    const b = await scpi.query("B?"); // on the line from 20 to 35 ms: the timer fires at 25
    const c = await scpi.query("C?");
    return [b, c];
  });
  assert.deepEqual(await other, ["B", "C"]);
  assert.equal(await leaked, "LEAK");
  assert.equal(seen.max, 1, "two queries were on the line at once");
  scpi.close();
});

test("work started by onClose (the reconnect) does not run as if it held the line", async () => {
  const { conn, seen } = fakeInstrument();
  const scpi = new ScpiClient();
  scpi.attach(conn, "fake", 0);
  let fromClose!: Promise<string>;
  const second = fakeInstrument();
  scpi.onClose = () => {
    // What ScopeService.lost() does: reopen, then query (handshake, live loop).
    fromClose = (async () => {
      await sleep(5);
      scpi.attach(second.conn, "fake", 0);
      await sleep(5);
      return scpi.query("RECONNECT?");
    })();
  };
  await scpi.exclusive(async () => {
    await scpi.query("A?");
    // Closing from inside a section, as the USB backstop timer does.
    setTimeout(() => scpi.close("the USB link stopped responding"), 0);
    await sleep(2);
  });
  await sleep(1);
  const other = scpi.exclusive(async () => {
    await sleep(8);
    const b = await scpi.query("B?");
    await sleep(20);
    return b;
  });
  assert.equal(await other, "B");
  assert.equal(await fromClose, "RECONNECT");
  assert.equal(second.seen.max, 1, "the reconnect's query overlapped another section");
  assert.ok(seen.max <= 1);
  scpi.close();
});

test("nested calls inside a section still run directly (no deadlock)", async () => {
  const { conn, seen } = fakeInstrument(5);
  const scpi = new ScpiClient();
  scpi.attach(conn, "fake", 0);
  const r = await scpi.exclusive(async () => [await scpi.query("A?"), await scpi.exclusive(() => scpi.query("B?"))]);
  assert.deepEqual(r, ["A", "B"]);
  assert.equal(seen.max, 1);
  scpi.close();
});
