// The whole service over USB-TMC, against the simulated MHO984 behind a
// virtual USB-TMC device: every byte goes through the real framing code in
// server/usbtmc.ts. Only the cable and the OS USB stack are missing.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.MHO_STUDIO_HOME = mkdtempSync(join(tmpdir(), "mho-studio-usb-"));

const { ScopeService } = await import("../scope.ts");
const { DeepStore } = await import("../deep.ts");
const { UsbtmcStream } = await import("../usbtmc.ts");
const { VirtualUsbtmc } = await import("./virtual-usbtmc.ts");
const { loadSettings } = await import("../store.ts");

type Dev = InstanceType<typeof VirtualUsbtmc>;
function service(dev: Dev, chunk: number) {
  const s = new ScopeService(() => {});
  s.usbOpener = async () => ({
    conn: new UsbtmcStream(dev, chunk) as never,
    info: { id: "SIM-USB-1", vendorId: 0x1ab1, productId: 0x0515, manufacturer: "Rigol", product: "MHO984 (virtual)", serial: "SIM-USB-1", rigol: true, usbtmc: true },
  });
  return s;
}

const dev = new VirtualUsbtmc(undefined, { maxTransfer: 16 * 1024 });
// A small request size, so waveform and image replies need several REQUESTs and several transfers each.
const scope = service(dev, 100_000);
after(async () => {
  await scope.disconnect();
});

test("connects over USB-TMC and reads identity, options and settings", async () => {
  const link = await scope.connect({ usb: true });
  assert.equal(link.state, "connected");
  assert.equal(link.kind, "usb");
  assert.equal(link.transport, "usb-tmc");
  assert.equal(link.idn?.model, "MHO984");
  assert.equal(link.usb?.id, "SIM-USB-1");
  assert.equal(scope.values.get("channel.scale@1"), 0.5);
  assert.equal(dev.badTags, 0);
  const s = loadSettings();
  assert.equal(s.lastKind, "usb");
  assert.equal(s.usbId, "SIM-USB-1");
});

test("writes are read back over USB the same as over LAN", async () => {
  const r = await scope.write("channel.scale@2", 0.3);
  assert.equal(r.value, 0.2);
  assert.equal(r.coerced, true);
});

test("a live frame arrives in volts", async () => {
  await scope.frame();
  const a = scope.latest.get("CHANnel1")!;
  assert.equal(a.volts.length, 1000);
  assert.ok(Math.abs(Math.max(...a.volts) - Math.min(...a.volts) - 2) < 0.1);
});

test("big replies: a screenshot and a deep capture span many requests and transfers", async () => {
  const before = { req: dev.requests, tin: dev.transfersIn };
  const png = await scope.screenshot();
  assert.deepEqual([...png.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
  const deep = new DeepStore();
  const meta = await deep.capture(scope, ["CHANnel1"], 300_000, true, () => {});
  assert.equal(meta.points, 300_000);
  const v = deep.view("CHANnel1", 0, meta.points, 100);
  assert.ok(Math.max(...v.max) > 0.9);
  assert.ok(dev.requests - before.req > 8, `requests ${dev.requests - before.req}`);
  assert.ok(dev.transfersIn - before.tin > 40, `transfers ${dev.transfersIn - before.tin}`);
});

test("a setup file goes out as one binary message and comes back", async () => {
  const blob = await scope.setupBlob();
  await scope.write("timebase.scale", 2e-3);
  const r = await scope.restoreSetup(blob);
  assert.deepEqual(r.errors, []);
  assert.equal(scope.values.get("timebase.scale"), 1e-4);
});

test("an instrument that never sets EOM still works (replies end by their own framing)", async () => {
  const quirky = new VirtualUsbtmc(undefined, { noEom: true, maxTransfer: 4096 });
  const s = service(quirky, 50_000);
  await s.connect({ usb: true });
  await s.frame();
  assert.equal(s.latest.get("CHANnel1")!.volts.length, 1000);
  assert.deepEqual([...(await s.screenshot()).subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
  await s.disconnect();
});

test("unplugging the device drops the link and the service keeps trying to reconnect", async () => {
  const d = new VirtualUsbtmc();
  const s = service(d, 1 << 20);
  await s.connect({ usb: true });
  await d.close();
  await assert.rejects(s.readKey("timebase.scale"));
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(s.link.state, "lost");
  await s.disconnect();
});
