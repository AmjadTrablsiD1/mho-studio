// The oscilloscope over USB: its rear USB Device port is a USB-TMC (USB488)
// interface. This file finds it, claims it, and wraps it as a Duplex stream
// that looks exactly like the TCP socket to server/scpi.ts: SCPI text and
// #N blocks go in and come out, USB-TMC framing (core/src/scpi/usbtmc.ts)
// happens underneath.
//
// USB access is the `usb` package (v3: Rust + nusb, prebuilt per platform, no
// libusb, no compiler). It is an optional dependency: if it cannot load, USB
// is reported unavailable and LAN keeps working.
//
// Platform notes (they are shown to the user too):
//  • macOS: no driver claims a USB-TMC interface; it just works.
//  • Windows: the interface needs the WinUSB driver. If NI-VISA / RIGOL
//    UltraSigma installed their own, switch it once with Zadig.
//  • Linux: the kernel's usbtmc driver claims it; we detach it, which needs
//    permission on the device (a udev rule).

import { Duplex } from "node:stream";
import { C } from "../core/src/constants.ts";
import { TMC, expectsReply, msgOut, nextTag, parseInHeader, replyComplete, requestIn, wholePackets } from "../core/src/scpi/usbtmc.ts";
import type { Conn } from "./transport.ts";

/** The two bulk pipes, whatever provides them (the real device, or a virtual one in tests). */
export interface BulkPipe {
  readonly maxPacket: number;
  out(data: Uint8Array, timeoutMs: number): Promise<void>;
  in(length: number, timeoutMs: number): Promise<Uint8Array>;
  close(): Promise<void>;
}

export class UsbtmcStream extends Duplex {
  private tag = 0;
  private queue: Promise<void> = Promise.resolve();
  private readonly pipe: BulkPipe;
  /** Largest reply chunk asked for per REQUEST_DEV_DEP_MSG_IN. */
  private readonly chunk: number;

  constructor(pipe: BulkPipe, chunk: number = C.usb.request_bytes) {
    super();
    this.pipe = pipe;
    this.chunk = chunk;
  }

  setNoDelay(): this {
    return this;
  }

  _read(): void {
    /* replies are pushed as they are read */
  }

  _write(chunk: Buffer, _enc: BufferEncoding, cb: (e?: Error | null) => void): void {
    const data = new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.length);
    // Strictly one message at a time: the next command goes out only after this one's reply is in.
    this.queue = this.queue.then(async () => {
      if (this.destroyed) return;
      try {
        this.tag = nextTag(this.tag);
        await this.pipe.out(msgOut(this.tag, data, true), C.usb.write_timeout_ms);
        cb();
      } catch (e) {
        cb(e as Error);
        this.destroy(e as Error);
        return;
      }
      if (!expectsReply(data)) return;
      try {
        await this.readReply();
      } catch (e) {
        this.destroy(e as Error);
      }
    });
  }

  /** Ask for the reply in chunks until the device marks the end (or the reply is visibly complete). */
  private async readReply(): Promise<void> {
    const parts: Uint8Array[] = [];
    let total = 0;
    let empty = 0;
    for (;;) {
      this.tag = nextTag(this.tag);
      const tag = this.tag;
      await this.pipe.out(requestIn(tag, this.chunk), C.usb.write_timeout_ms);
      // +3: the payload is padded to a multiple of 4, and a read shorter than the transfer overflows
      const first = await this.pipe.in(wholePackets(TMC.header + this.chunk + 3, this.pipe.maxPacket), C.usb.read_timeout_ms);
      const h = parseInHeader(first);
      if (h.tag !== tag) throw new Error(`USB-TMC: reply tag ${h.tag}, expected ${tag}`);
      const take = (b: Uint8Array) => {
        if (!b.length || this.destroyed) return;
        parts.push(b);
        total += b.length;
        this.push(Buffer.from(b.buffer, b.byteOffset, b.length));
      };
      let have = Math.min(h.size, first.length - TMC.header);
      take(first.subarray(TMC.header, TMC.header + have));
      // A long DEV_DEP_MSG_IN continues in further transfers, without a header.
      while (have < h.size) {
        const more = await this.pipe.in(wholePackets(h.size - have + 3, this.pipe.maxPacket), C.usb.read_timeout_ms);
        if (!more.length) throw new Error("USB-TMC: the device stopped in the middle of a reply");
        const n = Math.min(more.length, h.size - have);
        take(more.subarray(0, n));
        have += n;
      }
      if (h.eom) return;
      if (h.size === 0 && ++empty > 3) throw new Error("USB-TMC: the device keeps sending empty replies without end-of-message");
      // Some instruments leave EOM clear on the last chunk; stop when the reply is complete anyway.
      if (total && replyComplete(concatTail(parts, total))) return;
    }
  }

  _destroy(err: Error | null, cb: (e?: Error | null) => void): void {
    void this.pipe.close().finally(() => cb(err));
  }
}

/** The whole reply so far, for the completeness check (replies here are at most a chunked block). */
function concatTail(parts: Uint8Array[], total: number): Uint8Array {
  if (parts.length === 1) return parts[0];
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

// ------------------------------------------------------------ the real USB

type UsbEndpoint = { endpointNumber: number; direction: "in" | "out"; type: string; packetSize: number };
type UsbAlt = { interfaceClass: number; interfaceSubclass: number; endpoints: UsbEndpoint[] };
type UsbIface = { interfaceNumber: number; alternate: UsbAlt };
type UsbDev = {
  vendorId: number;
  productId: number;
  bus: string;
  address: number;
  manufacturerName: string | null;
  productName: string | null;
  serialNumber: string | null;
  configuration: { interfaces: UsbIface[] } | null;
  opened: boolean;
  open(): Promise<void>;
  close(): Promise<void>;
  selectConfiguration(v: number): Promise<void>;
  claimInterface(n: number): Promise<void>;
  releaseInterface(n: number): Promise<void>;
  clearHalt(d: "in" | "out", ep: number): Promise<void>;
  detachKernelDriver(n: number): Promise<void>;
  nativeTransferIn(ep: number, timeout: number, length: number): Promise<Uint8Array | null>;
  nativeTransferOut(ep: number, timeout: number, data: Uint8Array): Promise<number>;
  nativeControlTransferIn(setup: { requestType: string; recipient: string; request: number; value: number; index: number }, timeout: number, length: number): Promise<Uint8Array | null>;
};
type UsbModule = { usb: { getDevices(): Promise<UsbDev[]> } };

let loaded: { mod: UsbModule | null; error: string | null } | null = null;

async function load(): Promise<{ mod: UsbModule | null; error: string | null }> {
  if (loaded) return loaded;
  try {
    const m = (await import("usb")) as unknown as UsbModule & { default?: UsbModule };
    loaded = { mod: m.usb ? m : (m.default as UsbModule), error: null };
  } catch (e) {
    loaded = { mod: null, error: `USB support did not load (${(e as Error).message}). Run ./install.sh again; LAN still works.` };
  }
  return loaded;
}

export type UsbInfo = {
  id: string;
  vendorId: number;
  productId: number;
  manufacturer: string | null;
  product: string | null;
  serial: string | null;
  rigol: boolean;
  usbtmc: boolean | null;
};

const idOf = (d: UsbDev) => d.serialNumber || `${d.bus}-${d.address}`;
const hex4 = (n: number) => n.toString(16).padStart(4, "0");

function tmcInterface(d: UsbDev): UsbIface | null {
  try {
    return d.configuration?.interfaces.find((i) => i.alternate.interfaceClass === TMC.interfaceClass && i.alternate.interfaceSubclass === TMC.interfaceSubclass) ?? null;
  } catch {
    return null;
  }
}

export async function listUsb(): Promise<{ available: boolean; error: string | null; platformNote: string; devices: UsbInfo[] }> {
  const { mod, error } = await load();
  const platformNote =
    process.platform === "win32"
      ? "Windows: the scope's USB interface must use the WinUSB driver. If NI-VISA or RIGOL UltraSigma is installed, switch it once with Zadig (Options → List all devices → the RIGOL device → WinUSB)."
      : process.platform === "linux"
        ? "Linux: the kernel usbtmc driver is detached when connecting; your user needs access to the device (a udev rule for vendor 1ab1)."
        : "macOS: nothing to install.";
  if (!mod) return { available: false, error, platformNote, devices: [] };
  let devs: UsbDev[] = [];
  try {
    devs = await mod.usb.getDevices();
  } catch (e) {
    return { available: false, error: `Could not list USB devices: ${(e as Error).message}`, platformNote, devices: [] };
  }
  const out: UsbInfo[] = [];
  for (const d of devs) {
    const t = tmcInterface(d);
    const rigol = d.vendorId === TMC.rigolVendorId;
    if (!t && !rigol) continue;
    out.push({ id: idOf(d), vendorId: d.vendorId, productId: d.productId, manufacturer: d.manufacturerName, product: d.productName, serial: d.serialNumber, rigol, usbtmc: t ? true : d.configuration ? false : null });
  }
  return { available: true, error: null, platformNote, devices: out };
}

/** Open the USB-TMC interface of a device (by id from listUsb, or the first RIGOL/USB-TMC device). */
export async function openUsb(id?: string | null): Promise<{ conn: Conn; info: UsbInfo }> {
  const { mod, error } = await load();
  if (!mod) throw new Error(error ?? "USB is not available");
  const devs = await mod.usb.getDevices();
  const candidates = devs.filter((d) => tmcInterface(d) || d.vendorId === TMC.rigolVendorId);
  const dev = id ? candidates.find((d) => idOf(d) === id) : (candidates.find((d) => d.vendorId === TMC.rigolVendorId) ?? candidates[0]);
  if (!dev) throw Object.assign(new Error(id ? `USB device ${id} is not connected` : "No RIGOL or USB-TMC instrument is connected by USB. Use the rear USB Device port (square, type B) and a data cable."), { code: "ENODEV" });
  try {
    if (!dev.opened) await dev.open();
    if (!dev.configuration) await dev.selectConfiguration(1);
    const iface = tmcInterface(dev);
    if (!iface) throw new Error(`${dev.productName ?? hex4(dev.productId)} has no USB-TMC interface`);
    if (process.platform === "linux") await dev.detachKernelDriver(iface.interfaceNumber).catch(() => {});
    await dev.claimInterface(iface.interfaceNumber);
    const bulkIn = iface.alternate.endpoints.find((e) => e.type === "bulk" && e.direction === "in");
    const bulkOut = iface.alternate.endpoints.find((e) => e.type === "bulk" && e.direction === "out");
    if (!bulkIn || !bulkOut) throw new Error("the USB-TMC interface has no bulk endpoints");
    await dev.clearHalt("in", bulkIn.endpointNumber).catch(() => {});
    await dev.clearHalt("out", bulkOut.endpointNumber).catch(() => {});
    await initiateClear(dev, iface.interfaceNumber);
    const pipe: BulkPipe = {
      maxPacket: bulkIn.packetSize || 512,
      out: async (data, timeout) => {
        const n = await dev.nativeTransferOut(bulkOut.endpointNumber, timeout, data);
        if (n < 0) throw new Error("USB bulk-OUT stalled");
      },
      in: async (length, timeout) => {
        const r = await dev.nativeTransferIn(bulkIn.endpointNumber, timeout, length);
        if (!r) throw new Error("USB bulk-IN stalled");
        return r;
      },
      close: async () => {
        await dev.releaseInterface(iface.interfaceNumber).catch(() => {});
        await dev.close().catch(() => {});
      },
    };
    const info: UsbInfo = { id: idOf(dev), vendorId: dev.vendorId, productId: dev.productId, manufacturer: dev.manufacturerName, product: dev.productName, serial: dev.serialNumber, rigol: dev.vendorId === TMC.rigolVendorId, usbtmc: true };
    return { conn: new UsbtmcStream(pipe) as unknown as Conn, info };
  } catch (e) {
    await dev.close().catch(() => {});
    const m = (e as Error).message;
    const hint = process.platform === "win32" && /NOT_SUPPORTED|access|driver/i.test(m) ? " — on Windows the interface needs the WinUSB driver (Zadig)." : process.platform === "linux" && /access|permission/i.test(m) ? " — add a udev rule giving your user access to vendor 1ab1." : /busy|exclusive|claim/i.test(m) ? " — another program (VISA, UltraSigma, a second MHO Studio) has the device open." : "";
    throw new Error(`Could not open the USB device: ${m}${hint}`);
  }
}

/**
 * USB-TMC INITIATE_CLEAR: throw away whatever a previous session left in the
 * instrument's buffers, so the first reply we read is the answer to our first
 * question. Best effort — an instrument that does not support it still works.
 */
async function initiateClear(dev: UsbDev, iface: number): Promise<void> {
  const setup = (request: number) => ({ requestType: "class", recipient: "interface", request, value: 0, index: iface });
  try {
    const r = await dev.nativeControlTransferIn(setup(TMC.initiateClear), 1000, 1);
    if (!r || r[0] !== TMC.statusSuccess) return;
    for (let i = 0; i < 20; i++) {
      const s = await dev.nativeControlTransferIn(setup(TMC.checkClearStatus), 1000, 2);
      if (!s || s[0] !== TMC.statusPending) return;
      await new Promise((res) => setTimeout(res, 50));
    }
  } catch {
    /* not supported: carry on */
  }
}
