// A raw-SCPI client over one byte stream: the MHO984's TCP port 5555, or its
// USB-TMC interface wrapped as a stream (usbtmc.ts), or a LeCroy's VICP link
// (vicp.ts), which hands over whole replies instead of bytes.
//
// Commands are strictly sequential: one message out, and for a query one
// reply in, before the next goes. `exclusive()` holds the line for a whole
// sequence (":WAV:SOUR CHAN2" … ":WAV:DATA?") so no other loop can slip a
// command in between.
//
// A query the instrument does not answer is an error for that query only
// (ENOREPLY), not a lost link: the MHO984 answers an unknown or unimplemented
// query with silence. Over USB the stream clears the instrument and says so;
// over TCP a late reply could still arrive, so the next query first
// resynchronises on *IDN? and throws away anything that came before it.

import { AsyncLocalStorage } from "node:async_hooks";
import { C } from "../core/src/constants.ts";
import { ReplyReader, type Reply } from "../core/src/scpi/block.ts";
import { connectTo, type Conn } from "./transport.ts";
import { NO_REPLY } from "./usbtmc.ts";
import { VicpStream } from "./vicp.ts";
import type { Protocol } from "../core/src/registry/families.ts";

export type Traffic = { t: number; dir: "out" | "in"; text: string; bytes?: number };

export class ScpiError extends Error {
  code: string;
  constructor(message: string, code: string) {
    super(message);
    this.code = code;
  }
}

export class ScpiClient {
  private conn: Conn | null = null;
  private reader = new ReplyReader();
  private waiter: { resolve: (r: Reply) => void; reject: (e: Error) => void; timer: NodeJS.Timeout } | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  /** Set inside an exclusive section, so nested calls from that section run directly. */
  private inside = new AsyncLocalStorage<boolean>();
  host = "";
  port = 0;
  lastRttMs: number | null = null;
  bytesIn = 0;
  bytesOut = 0;
  commands = 0;
  onTraffic: ((t: Traffic) => void) | null = null;
  onClose: ((why: string) => void) | null = null;
  onProgress: ((have: number, need: number) => void) | null = null;
  /** A reply may still be in flight from a query we gave up on (TCP): resynchronise before the next one. */
  private stale = false;
  /** What *IDN? answers on this instrument; the resync waits for exactly this line. */
  syncToken: string | null = null;

  get connected(): boolean {
    return this.conn !== null;
  }

  async open(host: string, port: number, protocol: Protocol = "raw"): Promise<void> {
    this.close("reopen");
    const tcp = await connectTo(host, port, C.instrument.connect_timeout_ms);
    tcp.setNoDelay?.(true);
    this.attach(protocol === "vicp" ? new VicpStream(tcp) : tcp, host, port);
  }

  /** Use an already-open byte stream (the USB-TMC link, or a test's virtual device). */
  attach(conn: Conn, host: string, port: number): void {
    this.close("reopen");
    this.host = host;
    this.port = port;
    this.conn = conn;
    this.reader.clear();
    this.stale = false;
    conn.on(NO_REPLY, (msg: string) => this.noReply(msg));
    conn.on("reply", (r: Reply) => {
      this.bytesIn += r.kind === "line" ? r.text.length : r.data.length;
      this.reader.pushReply(r);
      this.deliver();
    });
    conn.on("progress", (have: number, need: number) => this.onProgress?.(have, need));
    conn.on("data", (d: Buffer) => {
      this.bytesIn += d.length;
      this.reader.push(new Uint8Array(d.buffer, d.byteOffset, d.length));
      const p = this.reader.progress();
      if (p && this.onProgress) this.onProgress(p.have, p.need);
      this.deliver();
    });
    const gone = (why: string) => () => {
      if (this.conn === conn) this.close(why);
    };
    conn.on("close", gone("the instrument closed the connection"));
    conn.on("error", (e: Error) => gone(e.message)());
  }

  close(why = "closed"): void {
    const c = this.conn;
    this.conn = null;
    if (this.waiter) {
      clearTimeout(this.waiter.timer);
      this.waiter.reject(new ScpiError(`connection lost: ${why}`, "ECONNRESET"));
      this.waiter = null;
    }
    this.reader.clear();
    if (c) {
      c.removeAllListeners("data");
      c.removeAllListeners("reply");
      c.destroy();
      if (why !== "reopen" && why !== "closed") this.onClose?.(why);
    }
  }

  /** The stream says no reply is coming (USB, after clearing the instrument). */
  private noReply(msg: string): void {
    this.reader.clear();
    const w = this.waiter;
    if (!w) return;
    this.waiter = null;
    clearTimeout(w.timer);
    w.reject(new ScpiError(`the instrument gave no reply (${msg})`, "ENOREPLY"));
  }

  private get usb(): boolean {
    return typeof (this.conn as { setReplyTimeout?: unknown } | null)?.setReplyTimeout === "function";
  }

  private deliver(): void {
    if (!this.waiter) return;
    const r = this.reader.next();
    if (!r) return;
    const w = this.waiter;
    this.waiter = null;
    clearTimeout(w.timer);
    w.resolve(r);
  }

  /** Run `fn` with the line to ourselves. Nested calls from inside `fn` run directly. */
  exclusive<T>(fn: () => Promise<T>): Promise<T> {
    if (this.inside.getStore()) return fn();
    const run = () => this.inside.run(true, fn);
    const p = this.chain.then(run, run);
    this.chain = p.catch(() => undefined);
    return p;
  }

  private send(cmd: string, replyTimeoutMs?: number): void {
    if (!this.conn) throw new ScpiError("not connected", "ENOTCONN");
    if (replyTimeoutMs !== undefined) (this.conn as { setReplyTimeout?: (ms: number) => void }).setReplyTimeout?.(replyTimeoutMs);
    const line = cmd.endsWith("\n") ? cmd : `${cmd}\n`;
    this.conn.write(line);
    this.bytesOut += line.length;
    this.commands++;
    this.onTraffic?.({ t: Date.now(), dir: "out", text: cmd.length > 300 ? `${cmd.slice(0, 300)}… (${cmd.length} bytes)` : cmd });
  }

  /**
   * Wait for the next reply. Over USB the stream enforces `timeoutMs` itself
   * and reports a missing reply; our own timer is only a backstop for a stream
   * that stopped responding altogether, and that does close the link. Over TCP
   * a timeout marks the line stale and the next query resynchronises.
   */
  private receive(timeoutMs: number, what: string): Promise<Reply> {
    const usb = this.usb;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => {
          this.waiter = null;
          if (usb) {
            this.close("the USB link stopped responding");
            return reject(new ScpiError(`USB link stopped responding during ${what}`, "ETIMEDOUT"));
          }
          this.stale = true;
          this.reader.clear();
          reject(new ScpiError(`no reply to ${what} within ${timeoutMs} ms`, "ENOREPLY"));
        },
        usb ? timeoutMs + C.usb.backstop_ms : timeoutMs,
      );
      this.waiter = { resolve, reject, timer };
      this.deliver();
    });
  }

  /** TCP only: send *IDN? and discard every reply until its answer, so late replies cannot shift the conversation. */
  private async resync(): Promise<void> {
    this.stale = false;
    this.reader.clear();
    this.send("*IDN?");
    const until = Date.now() + C.instrument.resync_ms;
    while (Date.now() < until) {
      const r = await new Promise<Reply | null>((resolve) => {
        const timer = setTimeout(() => {
          this.waiter = null;
          resolve(null);
        }, Math.max(50, until - Date.now()));
        this.waiter = { resolve, reject: () => resolve(null), timer };
        this.deliver();
      });
      if (!r) break;
      if (r.kind === "line" && (this.syncToken ? r.text.trim() === this.syncToken : /,/.test(r.text))) return;
    }
    this.close("could not resynchronise after a missing reply");
    throw new ScpiError("the instrument stopped answering", "ETIMEDOUT");
  }

  /** Send a query and wait for its reply, resynchronising first if an earlier reply went missing. */
  private async ask(cmd: string, timeoutMs: number): Promise<Reply> {
    if (this.stale) await this.resync();
    this.send(cmd, timeoutMs);
    return this.receive(timeoutMs, cmd.length > 60 ? `${cmd.slice(0, 60)}…` : cmd);
  }

  write(cmd: string): Promise<void> {
    return this.exclusive(async () => {
      if (this.stale) await this.resync();
      this.send(cmd);
    });
  }

  /** A query whose reply is one line. */
  query(cmd: string, timeoutMs: number = C.instrument.query_timeout_ms): Promise<string> {
    return this.exclusive(async () => {
      const t0 = performance.now();
      const r = await this.ask(cmd, timeoutMs);
      this.lastRttMs = performance.now() - t0;
      const text = r.kind === "line" ? r.text : new TextDecoder("latin1").decode(r.data);
      this.onTraffic?.({ t: Date.now(), dir: "in", text: text.length > 300 ? `${text.slice(0, 300)}…` : text, bytes: r.kind === "block" ? r.data.length : undefined });
      return text;
    });
  }

  /** A query whose reply is a #N block (waveform, image, setup). A line reply comes back as its bytes. */
  queryBlock(cmd: string, timeoutMs: number = C.instrument.block_timeout_ms): Promise<Uint8Array> {
    return this.exclusive(async () => {
      const t0 = performance.now();
      const r = await this.ask(cmd, timeoutMs);
      this.lastRttMs = performance.now() - t0;
      const data = r.kind === "block" ? r.data : new TextEncoder().encode(r.text);
      this.onTraffic?.({ t: Date.now(), dir: "in", text: `#block ${data.length} bytes`, bytes: data.length });
      return data;
    });
  }

  /** Either kind of reply, for the console. */
  queryAny(cmd: string, timeoutMs: number = C.instrument.block_timeout_ms): Promise<Reply> {
    return this.exclusive(async () => {
      const r = await this.ask(cmd, timeoutMs);
      this.onTraffic?.({ t: Date.now(), dir: "in", text: r.kind === "line" ? r.text : `#block ${r.data.length} bytes`, bytes: r.kind === "block" ? r.data.length : undefined });
      return r;
    });
  }

  /** Send raw bytes (a command with a binary block argument). */
  writeBytes(bytes: Uint8Array, label: string): Promise<void> {
    return this.exclusive(async () => {
      if (!this.conn) throw new ScpiError("not connected", "ENOTCONN");
      this.conn.write(bytes);
      this.bytesOut += bytes.length;
      this.commands++;
      this.onTraffic?.({ t: Date.now(), dir: "out", text: label, bytes: bytes.length });
    });
  }
}
