// A virtual USB-TMC instrument: the simulated MHO984 behind the two bulk
// pipes, speaking real USB-TMC framing. Lets the whole USB path — tags,
// headers, padding, replies split over several transfers, REQUEST sizes —
// run in tests without a device on the cable.
//
// It also copies two behaviours measured on the real MHO984 over USB
// (2026-09-26) that caused a crash and a dead link in the app:
//  • a REQUEST for a reply that does not exist is never answered, and after
//    the host gives up the device answers nothing more until a USB-TMC clear;
//  • the USB library throws synchronously if the device is released or closed
//    while a transfer is pending.

import { SimScope } from "../../sim/instrument.ts";
import { makeBlock } from "../../core/src/scpi/block.ts";
import { TMC, msgIn, parseOut } from "../../core/src/scpi/usbtmc.ts";
import { pipeFor, type BulkPipe, type UsbDevCore } from "../usbtmc.ts";

export type VirtualOptions = {
  /** Largest bulk-IN transfer the device returns; longer messages continue in further transfers. */
  maxTransfer?: number;
  /** Behave like instruments that never set EOM on the last chunk. */
  noEom?: boolean;
  /** A reply left over from an earlier session, waiting on bulk-IN with an old tag (seen on the MHO984). */
  leftover?: string;
  packet?: number;
};

export class VirtualUsbtmc implements BulkPipe {
  readonly maxPacket: number;
  readonly scope: SimScope;
  private readonly opts: Required<VirtualOptions>;
  private incoming: Uint8Array[] = [];
  /** Reply bytes waiting to be asked for (REQUEST_DEV_DEP_MSG_IN). */
  private output = new Uint8Array(0);
  /** Transfers queued on bulk-IN; a read never spans two of them. */
  private inQueue: Uint8Array[] = [];
  closed = false;
  /** Gave up on a missing reply: silent until clear(). */
  stuck = false;
  clears = 0;
  private busy = false;
  requests = 0;
  transfersIn = 0;
  badTags = 0;

  constructor(scope = new SimScope(), opts: VirtualOptions = {}) {
    this.scope = scope;
    this.opts = { maxTransfer: opts.maxTransfer ?? 64 * 1024, noEom: opts.noEom ?? false, packet: opts.packet ?? 512, leftover: opts.leftover ?? "" };
    this.maxPacket = this.opts.packet;
    if (this.opts.leftover) this.inQueue.push(msgIn(152, new TextEncoder().encode(this.opts.leftover), true));
  }

  async out(data: Uint8Array): Promise<void> {
    if (this.closed) throw new Error("device closed");
    const m = parseOut(data);
    if ((m.tag ^ 0xff) !== data[2]) this.badTags++;
    if (m.msgId === TMC.devDepMsgOut) {
      if ((data.length - TMC.header) % 4 !== 0) throw new Error("DEV_DEP_MSG_OUT not padded to 4 bytes");
      this.incoming.push(m.data.slice());
      if (!m.eom) return;
      const total = this.incoming.reduce((s, x) => s + x.length, 0);
      const msg = new Uint8Array(total);
      let o = 0;
      for (const x of this.incoming) {
        msg.set(x, o);
        o += x.length;
      }
      this.incoming = [];
      const text = new TextDecoder("latin1").decode(msg).replace(/\r?\n$/, "");
      const parts: Uint8Array[] = [];
      const lines: string[] = [];
      for (const r of this.scope.exec(text)) {
        if (typeof r === "string") lines.push(r);
        else {
          if (lines.length) parts.push(new TextEncoder().encode(`${lines.splice(0).join(";")}\n`));
          parts.push(makeBlock(r));
        }
      }
      if (lines.length) parts.push(new TextEncoder().encode(`${lines.join(";")}\n`));
      for (const p of parts) this.append(p);
      return;
    }
    if (m.msgId === TMC.requestDevDepMsgIn) {
      this.requests++;
      if (this.stuck || this.output.length === 0) return; // nothing to say: the IN read will time out
      const n = Math.min(m.size, this.output.length);
      const payload = this.output.slice(0, n);
      this.output = this.output.slice(n);
      const eom = this.output.length === 0 && !this.opts.noEom;
      const whole = msgIn(m.tag, payload, eom);
      // Split the message into transfers of at most maxTransfer bytes (only the first has the header).
      for (let i = 0; i < whole.length; i += this.opts.maxTransfer) this.inQueue.push(whole.slice(i, i + this.opts.maxTransfer));
      return;
    }
    throw new Error(`virtual USB-TMC: unexpected MsgID ${m.msgId}`);
  }

  private append(b: Uint8Array): void {
    const o = new Uint8Array(this.output.length + b.length);
    o.set(this.output, 0);
    o.set(b, this.output.length);
    this.output = o;
  }

  async in(length: number, timeoutMs: number): Promise<Uint8Array> {
    if (this.closed) throw new Error("device closed");
    const next = this.stuck ? undefined : this.inQueue.shift();
    if (!next) {
      this.busy = true;
      await new Promise((r) => setTimeout(r, timeoutMs));
      this.busy = false;
      this.stuck = true;
      throw new Error("transferIn error: Cancelled");
    }
    if (length % this.maxPacket !== 0) throw new Error(`bulk-IN length ${length} is not whole packets of ${this.maxPacket}`);
    this.transfersIn++;
    if (next.length > length) {
      this.inQueue.unshift(next.slice(length));
      return next.slice(0, length);
    }
    return next;
  }

  async clear(): Promise<void> {
    this.clears++;
    this.stuck = false;
    this.output = new Uint8Array(0);
    this.inQueue = [];
    this.incoming = [];
  }

  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }

  /**
   * This device as the USB library presents it, wrapped by the app's own
   * pipeFor(): so tests go through the real wrapper, and the library's quirks
   * (a synchronous throw from release/close while a transfer is pending) hit it.
   */
  asLibraryDevice(): UsbDevCore {
    const borrow = () => {
      if (this.busy) throw Object.assign(new Error("The same native value cannot be borrowed mutably while another borrow is active"), { code: "InvalidArg" });
    };
    return {
      nativeTransferOut: async (_ep: number, _t: number, data: Uint8Array) => (await this.out(data), data.length),
      nativeTransferIn: (_ep: number, t: number, len: number) => this.in(len, t),
      nativeControlTransferIn: async (setup: { request: number }) => {
        if (setup.request === TMC.initiateClear) {
          await this.clear();
          return Uint8Array.of(TMC.statusSuccess);
        }
        if (setup.request === TMC.checkClearStatus) return Uint8Array.of(TMC.statusSuccess, 0);
        return null;
      },
      clearHalt: async () => undefined,
      releaseInterface: ((_n: number) => {
        borrow();
        return Promise.resolve();
      }) as UsbDevCore["releaseInterface"],
      close: (() => {
        borrow();
        this.closed = true;
        return Promise.resolve();
      }) as UsbDevCore["close"],
    };
  }

  /** The pipe the app would build for this device. */
  pipe(): BulkPipe {
    return pipeFor(this.asLibraryDevice(), 0, 1, 1, this.maxPacket);
  }
}
