// A virtual USB-TMC instrument: the simulated MHO984 behind the two bulk
// pipes, speaking real USB-TMC framing. Lets the whole USB path — tags,
// headers, padding, replies split over several transfers, REQUEST sizes —
// run in tests without a device on the cable.

import { SimScope } from "../../sim/instrument.ts";
import { makeBlock } from "../../core/src/scpi/block.ts";
import { TMC, msgIn, parseOut } from "../../core/src/scpi/usbtmc.ts";
import type { BulkPipe } from "../usbtmc.ts";

export type VirtualOptions = {
  /** Largest bulk-IN transfer the device returns; longer messages continue in further transfers. */
  maxTransfer?: number;
  /** Behave like instruments that never set EOM on the last chunk. */
  noEom?: boolean;
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
  requests = 0;
  transfersIn = 0;
  badTags = 0;

  constructor(scope = new SimScope(), opts: VirtualOptions = {}) {
    this.scope = scope;
    this.opts = { maxTransfer: opts.maxTransfer ?? 64 * 1024, noEom: opts.noEom ?? false, packet: opts.packet ?? 512 };
    this.maxPacket = this.opts.packet;
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
    const next = this.inQueue.shift();
    if (!next) {
      await new Promise((r) => setTimeout(r, Math.min(timeoutMs, 50)));
      throw new Error("USB transfer timed out (the virtual device had nothing to send)");
    }
    if (length % this.maxPacket !== 0) throw new Error(`bulk-IN length ${length} is not whole packets of ${this.maxPacket}`);
    this.transfersIn++;
    if (next.length > length) {
      this.inQueue.unshift(next.slice(length));
      return next.slice(0, length);
    }
    return next;
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}
