// A LeCroy VICP link as a stream the SCPI client can use: each write becomes
// one VICP message (DATA|EOI|REMOTE with the next sequence number), and each
// whole message that comes back is handed over as one reply ("reply" event),
// so replies are framed by EOI rather than by newlines or block headers.
//
// The instrument echoes the sequence number of the message it answers. A
// reply with any other number belongs to a query the client already gave up
// on, and is dropped here: the conversation cannot slip out of step.

import { Duplex } from "node:stream";
import { nextSeq, replyOfMessage, vicpMessage, VicpFramer } from "../core/src/scpi/vicp.ts";
import type { Conn } from "./transport.ts";

export class VicpStream extends Duplex {
  /** Tells the SCPI client that replies arrive whole, as "reply" events. */
  readonly framed = true;
  private inner: Conn;
  private framer = new VicpFramer();
  private seq = 0;
  /** Replies dropped because they answered an earlier message. */
  dropped = 0;

  constructor(inner: Conn) {
    super();
    this.inner = inner;
    inner.on("data", (d: Buffer) => this.received(new Uint8Array(d.buffer, d.byteOffset, d.length)));
    inner.once("close", () => this.destroy());
    inner.once("error", (e: Error) => this.destroy(e));
  }

  setNoDelay(on: boolean): void {
    this.inner.setNoDelay?.(on);
  }

  override _write(chunk: Buffer | string, _enc: BufferEncoding, cb: (e?: Error | null) => void): void {
    let b = typeof chunk === "string" ? Buffer.from(chunk, "latin1") : chunk;
    // The message boundary is EOI; a trailing newline is the RIGOL habit and not needed here.
    if (b.length && b[b.length - 1] === 0x0a) b = b.subarray(0, b.length - 1);
    this.seq = nextSeq(this.seq);
    this.inner.write(vicpMessage(new Uint8Array(b.buffer, b.byteOffset, b.length), this.seq), cb);
  }

  override _read(): void {
    /* replies are emitted as "reply" events, not pushed as bytes */
  }

  private received(d: Uint8Array): void {
    let messages;
    try {
      messages = this.framer.push(d);
    } catch (e) {
      this.destroy(e as Error);
      return;
    }
    for (const m of messages) {
      // 0: an instrument older than VICP 1a, which does not number its replies — take it as it comes.
      if (m.seq !== 0 && m.seq !== this.seq) {
        this.dropped++;
        continue;
      }
      this.emit("reply", replyOfMessage(m.data));
    }
    const need = this.framer.blockLength;
    if (need !== null && need > 4096) this.emit("progress", this.framer.pending, need);
  }

  override _destroy(err: Error | null, cb: (e: Error | null) => void): void {
    this.framer.clear();
    this.inner.destroy();
    cb(err);
  }
}
