// A raw-SCPI client over one TCP connection (the MHO984's port 5555).
//
// Commands are strictly sequential: one message out, and for a query one
// reply in, before the next goes. `exclusive()` holds the line for a whole
// sequence (":WAV:SOUR CHAN2" … ":WAV:DATA?") so no other loop can slip a
// command in between. A timeout leaves the stream in an unknown state (a late
// reply would be taken as the answer to the next question), so it closes the
// connection; the service reconnects.

import { AsyncLocalStorage } from "node:async_hooks";
import { C } from "../core/src/constants.ts";
import { ReplyReader, type Reply } from "../core/src/scpi/block.ts";
import { connectTo, type Conn } from "./transport.ts";

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

  get connected(): boolean {
    return this.conn !== null;
  }

  async open(host: string, port: number): Promise<void> {
    this.close("reopen");
    this.host = host;
    this.port = port;
    const conn = await connectTo(host, port, C.instrument.connect_timeout_ms);
    conn.setNoDelay?.(true);
    this.conn = conn;
    this.reader.clear();
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
      c.destroy();
      if (why !== "reopen" && why !== "closed") this.onClose?.(why);
    }
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

  private send(cmd: string): void {
    if (!this.conn) throw new ScpiError("not connected", "ENOTCONN");
    const line = cmd.endsWith("\n") ? cmd : `${cmd}\n`;
    this.conn.write(line);
    this.bytesOut += line.length;
    this.commands++;
    this.onTraffic?.({ t: Date.now(), dir: "out", text: cmd.length > 300 ? `${cmd.slice(0, 300)}… (${cmd.length} bytes)` : cmd });
  }

  private receive(timeoutMs: number): Promise<Reply> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiter = null;
        const e = new ScpiError(`no reply from ${this.host}:${this.port} within ${timeoutMs} ms`, "ETIMEDOUT");
        this.close("timeout");
        reject(e);
      }, timeoutMs);
      this.waiter = { resolve, reject, timer };
      this.deliver();
    });
  }

  write(cmd: string): Promise<void> {
    return this.exclusive(async () => this.send(cmd));
  }

  /** A query whose reply is one line. */
  query(cmd: string, timeoutMs: number = C.instrument.query_timeout_ms): Promise<string> {
    return this.exclusive(async () => {
      const t0 = performance.now();
      this.send(cmd);
      const r = await this.receive(timeoutMs);
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
      this.send(cmd);
      const r = await this.receive(timeoutMs);
      this.lastRttMs = performance.now() - t0;
      const data = r.kind === "block" ? r.data : new TextEncoder().encode(r.text);
      this.onTraffic?.({ t: Date.now(), dir: "in", text: `#block ${data.length} bytes`, bytes: data.length });
      return data;
    });
  }

  /** Either kind of reply, for the console. */
  queryAny(cmd: string, timeoutMs: number = C.instrument.block_timeout_ms): Promise<Reply> {
    return this.exclusive(async () => {
      this.send(cmd);
      const r = await this.receive(timeoutMs);
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
