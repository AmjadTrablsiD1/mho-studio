// The oscilloscope as the app sees it: the link, a mirror of every value read
// back from the instrument, the live waveform loop, measurements, readings.
//
// Rule: the instrument is the truth. After every write the value is read back
// and the error queue drained; the UI shows what the scope actually set, and
// says so when that differs from what was asked for.

import { C } from "../core/src/constants.ts";
import { key, keysOf, parseKey, relevant, type Control } from "../core/src/registry/controls.ts";
import { familyOf, protocolForPort, type Family, type Protocol, type Registry } from "../core/src/registry/families.ts";
import { encode, matchOption, parseBool, parseIdn, parseNumber, type Identity, type Value } from "../core/src/scpi/values.ts";
import { lecroyIdn } from "../core/src/scpi/lecroy.ts";
import { codes, detectWordOrder, toVolts, type ByteOrder, type Preamble } from "../core/src/wave/decode.ts";
import { delay, measureAll, Stats } from "../core/src/dsp/measure.ts";
import type { Slot } from "../core/src/registry/measurements.ts";
import { ScpiClient, ScpiError, type Traffic } from "./scpi.ts";
import { transportStatus, type Conn } from "./transport.ts";
import { openUsb, type UsbInfo } from "./usbtmc.ts";
import { loadSettings, loadUnsupported, saveSettings, saveUnsupported } from "./store.ts";
import { log } from "./log.ts";
import { startSim } from "../sim/server.ts";
import { startLecroySim } from "../sim/lecroy-server.ts";
import { HttpError } from "./errors.ts";
import { RigolDriver } from "./drivers/rigol.ts";
import { LecroyDriver } from "./drivers/lecroy.ts";
import type { Driver } from "./drivers/types.ts";

export { HttpError };
export type SimModel = Family;
type SimRunning = { port: number; close: () => Promise<void> };

export type LinkState = "idle" | "connecting" | "connected" | "lost";
export type LinkKind = "tcp" | "usb" | "sim";
export type Link = {
  state: LinkState;
  kind: LinkKind;
  /** How messages are framed on TCP: raw SCPI lines (RIGOL) or VICP (LeCroy). */
  protocol: Protocol;
  /** Which driver speaks to it, chosen from *IDN?. */
  family: Family;
  usb: UsbInfo | null;
  host: string;
  port: number;
  sim: boolean;
  idn: Identity | null;
  error: string | null;
  transport: string | null;
  rttMs: number | null;
  wordOrder: ByteOrder;
  wordOrderLocked: boolean;
  modelWarning: string | null;
};

export type Trace = { src: string; points: number; xinc: number; xorigin: number; yinc: number; volts: string };
export type MeasureRow = { slot: Slot; value: number | null; stats: ReturnType<Stats["snapshot"]>; cross: number | null };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const b64 = (a: Float32Array) => Buffer.from(a.buffer, a.byteOffset, a.byteLength).toString("base64");

export type Latest = { volts: Float32Array; pre: Preamble; t: number };

export class ScopeService {
  readonly scpi = new ScpiClient();
  link: Link = { state: "idle", kind: "tcp", protocol: "raw", family: "rigol", usb: null, host: "", port: C.instrument.scpi_port, sim: false, idn: null, error: null, transport: null, rttMs: null, wordOrder: C.wire.word_order_default as ByteOrder, wordOrderLocked: false, modelWarning: null };
  values = new Map<string, Value>();
  options: Record<string, boolean> = {};
  status = "—";
  busy: string | null = null;
  viewers = 0;
  latest = new Map<string, Latest>();
  slots: Slot[] = [];
  private stats = new Map<string, Stats>();
  private cross = new Map<string, number | null>();
  readings: { counter: number | null; dvm: number | null } = { counter: null, dvm: null };
  traffic: Traffic[] = [];
  frames = 0;
  fps = 0;
  private sim: SimRunning | null = null;
  private simModel: SimModel | null = null;
  /** The family driver, chosen at connect from *IDN?. */
  drv: Driver = new RigolDriver(this);
  private loopToken = 0;
  private frameDirty = true;
  private wantConnected = false;
  private orderVotes = 0;
  private slotSeq = 0;
  private broadcast: (type: string, data: unknown) => void;

  constructor(broadcast: (type: string, data: unknown) => void) {
    this.broadcast = broadcast;
    this.scpi.onTraffic = (t) => {
      this.traffic.push(t);
      if (this.traffic.length > 400) this.traffic.splice(0, 200);
      this.broadcast("traffic", t);
    };
    this.scpi.onClose = (why) => void this.lost(why);
  }

  snapshot() {
    return {
      unsupported: [...this.unsupported],
      link: this.link,
      values: Object.fromEntries(this.values),
      options: this.options,
      status: this.status,
      busy: this.busy,
      measure: this.measureRows(),
      readings: this.readings,
      settings: loadSettings(),
      traffic: this.traffic.slice(-120),
      stats: this.linkStats(),
    };
  }

  linkStats() {
    return { rttMs: this.scpi.lastRttMs, bytesIn: this.scpi.bytesIn, bytesOut: this.scpi.bytesOut, commands: this.scpi.commands, frames: this.frames, fps: this.fps };
  }

  private setLink(p: Partial<Link>): void {
    this.link = { ...this.link, ...p };
    this.broadcast("link", this.link);
  }

  // -------------------------------------------------------------- connect

  /** How the USB link is opened; tests put a virtual USB-TMC device here. */
  usbOpener: (id?: string | null) => Promise<{ conn: Conn; info: UsbInfo }> = openUsb;

  async connect(opts: { host?: string; port?: number; sim?: boolean; simModel?: SimModel; usb?: boolean; usbId?: string | null; protocol?: Protocol }): Promise<Link> {
    this.wantConnected = true;
    this.loopToken++;
    this.scpi.close("reopen");
    const kind: LinkKind = opts.usb ? "usb" : opts.sim ? "sim" : "tcp";
    let host = (opts.host ?? "").trim();
    let port = Number(opts.port ?? C.instrument.scpi_port);
    let protocol: Protocol = opts.protocol === "vicp" || opts.protocol === "raw" ? opts.protocol : protocolForPort(port);
    if (kind === "sim") {
      const model: SimModel = opts.simModel === "lecroy" ? "lecroy" : "rigol";
      if (this.sim && this.simModel !== model) await this.stopSim();
      if (!this.sim) this.sim = model === "lecroy" ? await startLecroySim(0) : await startSim(0);
      this.simModel = model;
      host = "127.0.0.1";
      port = this.sim.port;
      protocol = model === "lecroy" ? "vicp" : "raw";
    } else if (kind === "usb") {
      host = "USB";
      port = 0;
      protocol = "raw";
    } else {
      if (!host) throw new HttpError(400, "enter the oscilloscope's IP address (Utility → I/O → LAN on a RIGOL; Windows network settings on a LeCroy)");
      if (!/^[\w.:-]+$/.test(host)) throw new HttpError(400, "host must be a hostname or an IP address");
      if (!(port > 0 && port < 65536)) throw new HttpError(400, "port must be 1–65535");
    }
    this.values.clear();
    this.latest.clear();
    this.setLink({ state: "connecting", kind, protocol, host, port, sim: kind === "sim", usb: null, error: null, idn: null, modelWarning: null, wordOrderLocked: false });
    try {
      await this.openLink(kind, host, port, opts.usbId ?? null);
      await this.handshake();
    } catch (e) {
      this.scpi.close("closed");
      this.setLink({ state: "idle", error: this.explain(e as Error, host, port) });
      throw new HttpError(502, this.link.error!);
    }
    const s = loadSettings();
    if (kind === "tcp") saveSettings({ ...s, host, port, protocol, lastKind: "tcp", recent: [host, ...s.recent.filter((h) => h !== host)].slice(0, 8) });
    else if (kind === "usb") saveSettings({ ...s, lastKind: "usb", usbId: this.link.usb?.id ?? null });
    else saveSettings({ ...s, lastKind: "sim", simModel: this.simModel ?? "rigol" });
    this.startLoop();
    return this.link;
  }

  private async stopSim(): Promise<void> {
    const sim = this.sim;
    this.sim = null;
    this.simModel = null;
    if (sim) await sim.close();
  }

  /** Open the byte stream for a link: a TCP socket (raw or VICP), or the USB-TMC interface. */
  private async openLink(kind: LinkKind, host: string, port: number, usbId: string | null): Promise<void> {
    if (kind === "usb") {
      const { conn, info } = await this.usbOpener(usbId);
      this.scpi.attach(conn, "USB", 0);
      this.link = { ...this.link, usb: info };
    } else {
      await this.scpi.open(host, port, this.link.protocol);
    }
  }

  private explain(e: Error, host: string, port: number): string {
    const code = (e as NodeJS.ErrnoException).code ?? (e as ScpiError).code ?? "";
    if (host === "USB") return e.message;
    if (code === "ECONNREFUSED" && this.link.protocol === "vicp") return `${host} refused port ${port}. On the LeCroy, Utilities → Utilities Setup → Remote must be set to TCPIP (VICP), and the Windows firewall on the scope must let port ${port} in.`;
    if (code === "ECONNREFUSED") return `${host} refused port ${port}. Is it the oscilloscope, and is LAN enabled (Utility → I/O)? A LeCroy listens on port ${C.lecroy.vicp_port} (VICP).`;
    if (code === "ETIMEDOUT" || /within/.test(e.message)) return `No answer from ${host}:${port}. Check the cable, the IP address and that the PC is on the same network.`;
    if (code === "EHOSTUNREACH" || code === "ENETUNREACH") return `${host} is unreachable from this computer (${code}). On macOS, check System Settings → Privacy & Security → Local Network.`;
    return e.message;
  }

  private async handshake(): Promise<void> {
    // A reply left over from a previous session can answer the first question (seen over USB);
    // the stream clears it and reports no reply, so ask once more.
    const raw = await this.scpi.query("*IDN?").catch((e) => {
      if (e instanceof ScpiError && e.code === "ENOREPLY") return this.scpi.query("*IDN?");
      throw e;
    });
    const family = familyOf(raw.trim().replace(/^\*?IDN\s+/i, ""));
    const idn = family === "lecroy" ? lecroyIdn(raw) : parseIdn(raw);
    this.drv = family === "lecroy" ? new LecroyDriver(this) : new RigolDriver(this);
    this.slots = [];
    this.stats.clear();
    this.cross.clear();
    this.scpi.syncToken = idn.raw;
    this.unsupported = new Set(loadUnsupported(`${idn.model} ${idn.firmware}`));
    this.options = {};
    this.scpi.syncToken = await this.drv.init(raw);
    const warn =
      family === "lecroy"
        ? this.link.sim ? null : `LeCroy support follows the X-Stream remote control manual and has been tested on the simulator only; "${idn.model}" is the first real one it meets. Values it does not answer are learned and skipped.`
        : /MHO9/i.test(idn.model) ? null : `This app is built for the MHO984; "${idn.model || idn.raw}" answered. Commands follow the MHO900 guide and may differ on it.`;
    this.setLink({ state: "connected", family, idn, transport: this.link.kind === "usb" ? "usb-tmc" : this.link.protocol === "vicp" ? `vicp over ${transportStatus().active ?? "tcp"}` : transportStatus().active, modelWarning: warn, error: null });
    this.broadcast("unsupported", [...this.unsupported]);
    this.broadcast("measure", this.measureRows());
    log(`connected: ${idn.raw} over ${this.link.kind}/${this.link.protocol} as ${family}${this.unsupported.size ? `; ${this.unsupported.size} queries known unanswered on this firmware` : ""}`);
    await this.drainErrors();
    this.broadcast("options", this.options);
    await this.readKeys(this.primaryKeys());
    await this.readKeys(this.triggerTypeKeys());
    this.status = await this.drv.status();
    this.broadcast("status", this.status);
    this.frameDirty = true;
  }

  /** The control table of the instrument on the line. */
  get reg(): Registry {
    return this.drv.reg;
  }

  async disconnect(): Promise<Link> {
    this.wantConnected = false;
    this.loopToken++;
    this.scpi.close("closed");
    await this.stopSim();
    this.setLink({ state: "idle", error: null });
    return this.link;
  }

  private async lost(why: string): Promise<void> {
    if (!this.wantConnected) return;
    log(`link lost: ${why}`);
    this.loopToken++;
    this.setLink({ state: "lost", error: `Connection lost (${why}). Reconnecting…` });
    for (let attempt = 1; this.wantConnected && this.link.state === "lost"; attempt++) {
      await sleep(C.instrument.reconnect_backoff_ms * Math.min(attempt, 5));
      if (!this.wantConnected || this.link.state !== "lost") return;
      try {
        await this.openLink(this.link.kind, this.link.host, this.link.port, this.link.usb?.id ?? null);
        await this.handshake();
        this.startLoop();
        return;
      } catch (e) {
        this.scpi.close("closed");
        this.setLink({ state: "lost", error: `${this.explain(e as Error, this.link.host, this.link.port)} Retrying (attempt ${attempt})…` });
      }
    }
  }

  get ready(): boolean {
    return this.link.state === "connected" && this.scpi.connected;
  }

  private need(): void {
    if (!this.ready) throw new HttpError(409, "not connected to an oscilloscope");
  }

  /** Features an option gates: the generator needs AFG50 or AFG100. */
  has(needs: string | undefined): boolean {
    if (!needs) return true;
    if (needs === "AFG") return !!(this.options.AFG100 || this.options.AFG50);
    return !!this.options[needs];
  }

  // --------------------------------------------------------------- values

  primaryKeys(): string[] {
    return this.reg.controls.filter((c) => c.primary && c.query && this.has(c.needs)).flatMap(keysOf);
  }

  triggerTypeKeys(): string[] {
    const mode = String(this.values.get("trigger.mode") ?? "EDGE");
    return this.groupKeys("trigger", null).filter((k) => {
      const c = this.reg.byId.get(parseKey(k).id)!;
      return c.sub && c.when?.id === "trigger.mode" && relevant(c, null, () => mode, this.reg.byId);
    });
  }

  /** Every readable key in a group (optionally one sub-group and one suffix). */
  groupKeys(group: string, sub: string | null | undefined, n?: number): string[] {
    return this.reg.controls.filter((c) => c.group === group && (sub === undefined || c.sub === sub) && c.query && !c.hidden && this.has(c.needs))
      .flatMap((c) => (c.suffix ? (n ? [key(c.id, n)] : keysOf(c)) : [c.id]));
  }

  private queryOf(k: string): { c: Control; n: number | null; q: string } {
    const { id, n } = parseKey(k);
    const c = this.reg.byId.get(id);
    if (!c) throw new HttpError(404, `no control ${id} on this instrument`);
    if (!c.query) throw new HttpError(400, `${c.header} cannot be read`);
    return { c, n, q: this.drv.queryOf(c, n) };
  }

  /** A value the driver works out itself (LeCroy's screen centre, from each record). */
  setComputed(k: string, v: Value): void {
    this.values.set(k, v);
    this.broadcast("values", { [k]: v });
  }

  /**
   * Read one value. A query this firmware does not answer is remembered (per
   * model and firmware, on disk) and not asked again: each costs a timeout
   * plus a clear, and a settings panel may hold dozens.
   */
  async readKey(k: string): Promise<Value> {
    const { c, n, q } = this.queryOf(k);
    if (this.unsupported.has(c.id)) {
      this.values.set(k, null);
      return null;
    }
    try {
      const v = this.drv.parse(c, n, await this.scpi.query(q, C.instrument.value_timeout_ms));
      this.values.set(k, v);
      return v;
    } catch (e) {
      if (e instanceof ScpiError && e.code === "ENOREPLY") this.markUnsupported(c.id, q);
      throw e;
    }
  }

  /** Several values in one compound query (":A?;:B?"): one USB/TCP round trip instead of one each. */
  private async readBatch(keys: string[]): Promise<void> {
    const live = keys.filter((k) => !this.unsupported.has(parseKey(k).id));
    if (!this.reg.features.compound) {
      for (const k of live) await this.readKey(k).catch((e) => this.tolerate(e));
      return;
    }
    for (let i = 0; i < live.length; i += C.instrument.batch_queries) {
      const group = live.slice(i, i + C.instrument.batch_queries);
      const qs = group.map((k) => this.queryOf(k));
      let parts: string[] | null = null;
      try {
        parts = (await this.scpi.query(qs.map((x) => x.q).join(";"), C.instrument.value_timeout_ms * 2)).split(";");
      } catch (e) {
        if (!(e instanceof ScpiError) || e.code !== "ENOREPLY") throw e;
      }
      if (parts && parts.length === group.length) {
        group.forEach((k, j) => this.values.set(k, this.drv.parse(qs[j].c, qs[j].n, parts![j])));
      } else {
        // One of them is not answered (or a value held a ';'): ask one by one, which also finds the culprit.
        for (const k of group) await this.readKey(k).catch((e) => this.tolerate(e));
      }
    }
  }

  /** ENOREPLY is a per-query failure; anything else (a lost link) propagates. */
  private tolerate(e: unknown): void {
    if (e instanceof ScpiError && e.code === "ENOREPLY") return;
    throw e;
  }

  unsupported = new Set<string>();

  private markUnsupported(id: string, q: string): void {
    if (this.unsupported.has(id)) return;
    this.unsupported.add(id);
    log(`no reply to ${q} — marked unsupported on ${this.link.idn?.model} fw ${this.link.idn?.firmware}`);
    saveUnsupported(this.firmwareKey(), [...this.unsupported]);
    this.broadcast("unsupported", [...this.unsupported]);
  }

  private firmwareKey(): string {
    return `${this.link.idn?.model ?? "?"} ${this.link.idn?.firmware ?? "?"}`;
  }

  async readKeys(keys: string[]): Promise<Record<string, Value>> {
    const read: string[] = [];
    for (const k of keys) {
      try {
        await this.readKey(k);
        read.push(k);
      } catch (e) {
        if (e instanceof ScpiError && e.code === "ENOREPLY") {
          read.push(k);
          continue;
        }
        if (e instanceof ScpiError) throw e;
      }
    }
    await this.drainErrors();
    // Publish the mirror as it is now, not as it was when each key was read: a write that
    // landed in between has already put the newer value there (and broadcast it), and an
    // older reading sent after it would roll the interface back.
    const out = this.current(read);
    if (read.length) this.broadcast("values", out);
    return out;
  }

  private current(keys: string[]): Record<string, Value> {
    const out: Record<string, Value> = {};
    for (const k of keys) out[k] = this.values.get(k) ?? null;
    return out;
  }

  /** Read and clear the instrument's error queue (registers, on a LeCroy). */
  drainErrors(): Promise<{ code: number; message: string }[]> {
    return this.drv.errors();
  }

  private needsConfirm(c: Control, v: Value): boolean {
    if (!c.confirm) return false;
    if (c.kind === "bool") return v === true;
    if (c.id === "channel.impedance") return v === "FIFTy";
    return true;
  }

  async write(k: string, value: Value, confirmed = false) {
    this.need();
    const { id, n } = parseKey(k);
    const c = this.reg.byId.get(id);
    if (!c) throw new HttpError(404, `no control ${id} on this instrument`);
    if (!c.set || c.kind === "readonly") throw new HttpError(400, `${c.label} is read-only`);
    if (c.kind === "action") throw new HttpError(400, `${c.label} is an action`);
    if (c.suffix && n !== null && !c.suffix.values.includes(n)) throw new HttpError(400, `${c.label}: no ${c.suffix.name}=${n}`);
    let v: Value = value;
    if (c.kind === "number") {
      v = Number(value);
      if (!Number.isFinite(v)) throw new HttpError(400, `${c.label}: not a number`);
    } else if (c.kind === "bool") v = value === true || value === "ON" || value === 1 || value === "1";
    else if (c.kind === "enum") {
      const o = matchOption(String(value), c.options?.map((x) => x.value) ?? []);
      if (!o) throw new HttpError(400, `${c.label}: "${value}" is not one of the options`);
      v = o;
    }
    if (this.needsConfirm(c, v) && !confirmed) throw new HttpError(409, c.confirm!);
    const result = await this.scpi.exclusive(async () => {
      await this.scpi.write(this.drv.setOf(c, c.suffix ? (n ?? 1) : null, v));
      for (const t of c.then ?? []) {
        const tc = this.reg.byId.get(t.id);
        if (tc) await this.scpi.write(this.drv.setOf(tc, tc.suffix ? (n ?? 1) : null, t.value));
      }
      await sleep(C.loops.after_write_settle_ms);
      const readback = c.query
        ? await this.readKey(k).catch((e) => {
            this.tolerate(e); // this firmware does not answer the query form: keep what was sent
            return v;
          })
        : v;
      const also = [...(c.after ?? []), ...(c.then ?? []).map((t) => t.id)].flatMap((a) => {
        const ac = this.reg.byId.get(a);
        if (!ac?.query) return [];
        return ac.suffix ? (c.suffix ? [key(a, n ?? 1)] : keysOf(ac)) : [a];
      });
      const extra: Record<string, Value> = {};
      for (const a of also) extra[a] = await this.readKey(a).catch(() => null);
      if (c.id === "trigger.mode") for (const t of this.triggerTypeKeys()) extra[t] = await this.readKey(t).catch(() => null);
      const errors = await this.drainErrors();
      return { readback, extra, errors };
    });
    this.broadcast("values", this.current([k, ...Object.keys(result.extra)]));
    this.frameDirty = true;
    const coerced = !same(v, result.readback);
    return { key: k, requested: v, value: result.readback, coerced, errors: result.errors };
  }

  async action(id: string, n: number | null, confirmed = false) {
    this.need();
    const c = this.reg.byId.get(id);
    if (!c || c.kind !== "action") throw new HttpError(404, `no action ${id} on this instrument`);
    if (c.confirm && !confirmed) throw new HttpError(409, c.confirm);
    await this.drv.action(c, n);
    if (id === "root.autoset" || id === "common.rst" || id === "system.reset") {
      await sleep(id === "root.autoset" ? 1500 : 800);
      await this.scpi.query("*OPC?", 15000).catch(() => "");
      await this.readKeys(this.primaryKeys());
      await this.readKeys(this.triggerTypeKeys());
    }
    const errors = await this.drainErrors();
    this.status = await this.drv.status();
    this.broadcast("status", this.status);
    this.frameDirty = true;
    return { id, errors, status: this.status };
  }

  // ------------------------------------------------------------ live loop

  private startLoop(): void {
    const token = ++this.loopToken;
    void this.loop(token);
  }

  private async loop(token: number): Promise<void> {
    let lastStatus = 0;
    let lastWatch = Date.now();
    let lastMeasure = 0;
    let lastReadings = 0;
    let fpsCount = 0;
    let fpsAt = Date.now();
    while (token === this.loopToken && this.ready) {
      const t0 = Date.now();
      try {
        if (this.busy || !this.viewers) {
          await sleep(C.loops.idle_backoff_ms);
          continue;
        }
        if (t0 - lastStatus >= C.loops.status_period_ms) {
          lastStatus = t0;
          const st = await this.drv.status();
          if (st !== this.status) {
            this.status = st;
            this.broadcast("status", st);
            this.frameDirty = true;
          }
        }
        const live = this.status !== "STOP";
        if (live || this.frameDirty) {
          this.frameDirty = false;
          await this.frame();
          fpsCount++;
        }
        if (t0 - fpsAt >= 1000) {
          this.fps = (fpsCount * 1000) / (t0 - fpsAt);
          fpsCount = 0;
          fpsAt = t0;
          this.broadcast("stats", this.linkStats());
        }
        if (t0 - lastWatch >= C.loops.watch_period_ms) {
          lastWatch = t0;
          await this.watch();
        }
        if (this.slots.length && t0 - lastMeasure >= C.loops.measure_period_ms) {
          lastMeasure = t0;
          await this.readMeasurements();
        }
        if (t0 - lastReadings >= C.loops.counter_period_ms && (this.values.get("counter.enable") === true || this.values.get("dvm.enable") === true)) {
          lastReadings = t0;
          await this.readReadings();
        }
      } catch (e) {
        if (e instanceof ScpiError && (e.code === "ETIMEDOUT" || e.code === "ECONNRESET" || e.code === "ENOTCONN")) return; // lost() takes over
        if (e instanceof ScpiError && e.code === "ENOREPLY") log(`live loop: ${e.message}`);
        this.broadcast("problem", { message: (e as Error).message });
        await sleep(C.loops.idle_backoff_ms);
      }
      const spent = Date.now() - t0;
      const wait = (this.status === "STOP" ? C.loops.idle_backoff_ms : C.loops.live_period_ms) - spent;
      if (wait > 0) await sleep(wait);
    }
  }

  /** Which sources are on screen: displayed channels (and math, on a RIGOL). */
  visibleSources(): string[] {
    return this.drv.visibleSources();
  }

  /** One screen record of every visible source. */
  async frame(): Promise<void> {
    const srcs = this.visibleSources();
    const traces: Trace[] = [];
    await this.scpi.exclusive(async () => {
      const recs = await this.drv.frame(srcs);
      for (const [src, { volts, pre }] of recs) {
        this.latest.set(src, { volts, pre, t: Date.now() });
        traces.push({ src, points: volts.length, xinc: pre.xinc, xorigin: pre.xorigin, yinc: pre.yinc, volts: b64(volts) });
      }
    });
    this.frames++;
    this.broadcast("frame", { t: Date.now(), seq: this.frames, status: this.status, traces });
  }

  /** One screen record of one source, outside the live loop (Bode uses it). */
  async readTrace(src: string): Promise<Latest> {
    return this.scpi.exclusive(async () => {
      const r = await this.drv.readTrace(src);
      const l = { ...r, t: Date.now() };
      this.latest.set(src, l);
      return l;
    });
  }

  decode(data: Uint8Array, pre: Preamble): Float32Array {
    if (pre.format === "WORD" && !this.link.wordOrderLocked) {
      const d = detectWordOrder(data);
      if (d.confidence >= C.wire.word_order_confidence) {
        if (d.order === this.link.wordOrder) this.orderVotes++;
        else {
          this.orderVotes = 1;
          this.link.wordOrder = d.order;
        }
        if (this.orderVotes >= 3) this.setLink({ wordOrderLocked: true, wordOrder: d.order });
      }
    }
    return toVolts(codes(data, pre.format, this.link.wordOrder), pre);
  }

  /** Values a person may change at the instrument itself. */
  private async watch(): Promise<void> {
    const keys = this.reg.controls.filter((c) => c.watch && c.query && this.has(c.needs)).flatMap(keysOf);
    const before = new Map(keys.map((k) => [k, this.values.get(k) ?? null]));
    await this.readBatch(keys);
    const changed: Record<string, Value> = {};
    for (const k of keys) if (!same(before.get(k) ?? null, this.values.get(k) ?? null)) changed[k] = this.values.get(k) ?? null;
    if (Object.keys(changed).length) {
      if ("trigger.mode" in changed) for (const t of this.triggerTypeKeys()) changed[t] = await this.readKey(t);
      this.broadcast("values", this.current(Object.keys(changed)));
      this.frameDirty = true;
    }
  }

  // ---------------------------------------------------------- measurements

  async addMeasurement(item: string, src1: string, src2?: string): Promise<MeasureRow[]> {
    this.need();
    const m = this.reg.measurements.find((x) => x.item === item);
    if (!m) throw new HttpError(400, `unknown measurement ${item} on this instrument`);
    if (m.dual && !src2) throw new HttpError(400, `${m.label} needs two sources`);
    if (this.slots.length >= C.measure.max_items) throw new HttpError(400, `at most ${C.measure.max_items} measurements`);
    if (!/^(CHANnel[1-4]|MATH[1-4]|D\d{1,2})$/.test(src1) || (src2 && !/^(CHANnel[1-4]|MATH[1-4]|D\d{1,2})$/.test(src2))) throw new HttpError(400, "bad source");
    const slot: Slot = { id: `m${++this.slotSeq}`, item, src1, src2: m.dual ? src2 : undefined };
    await this.drv.addMeasurement(slot);
    await this.drainErrors();
    this.slots.push(slot);
    this.stats.set(slot.id, new Stats());
    await this.readMeasurements();
    return this.measureRows();
  }

  async removeMeasurement(id: string): Promise<MeasureRow[]> {
    this.slots = this.slots.filter((s) => s.id !== id);
    this.stats.delete(id);
    this.cross.delete(id);
    if (this.ready) {
      await this.drv.measurementsChanged(this.slots);
      await this.drainErrors();
    }
    const rows = this.measureRows();
    this.broadcast("measure", rows);
    return rows;
  }

  resetStats(): MeasureRow[] {
    for (const s of this.slots) this.stats.set(s.id, new Stats());
    const rows = this.measureRows();
    this.broadcast("measure", rows);
    return rows;
  }

  measureRows(): MeasureRow[] {
    return this.slots.map((slot) => {
      const st = this.stats.get(slot.id)?.snapshot() ?? new Stats().snapshot();
      return { slot, value: st.last, stats: st, cross: this.cross.get(slot.id) ?? null };
    });
  }

  private async readMeasurements(): Promise<void> {
    for (const s of this.slots) {
      this.stats.get(s.id)?.add(await this.drv.readMeasurement(s));
      this.cross.set(s.id, this.crossCheck(s));
    }
    this.broadcast("measure", this.measureRows());
  }

  /** The same quantity computed here from the last 1000-point screen record. */
  private crossCheck(s: Slot): number | null {
    const a = this.latest.get(s.src1);
    if (!a || Date.now() - a.t > 5000) return null;
    const dt = a.pre.xinc;
    const dual = /^(RR|RF|FR|FF)(DEL|PH)/i.exec(s.item);
    if (dual) {
      const b = s.src2 ? this.latest.get(s.src2) : undefined;
      if (!b) return null;
      const d = delay(a.volts, b.volts, dt, dual[1][0].toUpperCase() as "R" | "F", dual[1][1].toUpperCase() as "R" | "F");
      if (d === null) return null;
      if (/^DEL/i.test(dual[2])) return d;
      const p = measureAll(a.volts, dt).PERiod;
      return p ? (d / p) * 360 : null;
    }
    const m = measureAll(a.volts, dt);
    const def = this.reg.measurements.find((x) => x.item === s.item);
    const v = m[def?.cross ?? s.item] ?? null;
    if (v !== null && (s.item === "TVMAX" || s.item === "TVMIN")) return v + a.pre.xorigin;
    return v;
  }

  private async readReadings(): Promise<void> {
    const counter = this.values.get("counter.enable") === true ? parseNumber(await this.scpi.query(":COUNter:CURRent?")) : null;
    const dvm = this.values.get("dvm.enable") === true ? parseNumber(await this.scpi.query(":DVM:CURRent?")) : null;
    this.readings = { counter, dvm };
    this.broadcast("readings", this.readings);
  }

  // ------------------------------------------------------------- one-shots

  async screenshot(): Promise<Uint8Array> {
    this.need();
    return this.scpi.exclusive(() => this.drv.screenshot());
  }

  async setupBlob(): Promise<Uint8Array> {
    this.need();
    return this.drv.setupBlob();
  }

  async restoreSetup(blob: Uint8Array): Promise<{ errors: { code: number; message: string }[] }> {
    this.need();
    await this.drv.restoreSetup(blob);
    await sleep(1000);
    await this.scpi.query("*OPC?", 15000).catch(() => "");
    const errors = await this.drainErrors();
    await this.readKeys(this.primaryKeys());
    await this.readKeys(this.triggerTypeKeys());
    this.frameDirty = true;
    return { errors };
  }

  /** The console: anything typed, sent as is. */
  async console(cmd: string): Promise<{ reply: string | null; block: { bytes: number; text: string | null; hex: string } | null; errors: { code: number; message: string }[] }> {
    this.need();
    const c = cmd.trim();
    if (!c) throw new HttpError(400, "empty command");
    let reply: string | null = null;
    let block: { bytes: number; text: string | null; hex: string } | null = null;
    if (c.includes("?")) {
      // Long only for commands that return data blocks; a mistyped query should come back quickly.
      const slow = this.drv.slowQuery(c);
      const r = await this.scpi.queryAny(c, slow ? C.instrument.block_timeout_ms : C.instrument.console_timeout_ms).catch((e) => {
        if (e instanceof ScpiError && e.code === "ENOREPLY") return null;
        throw e;
      });
      if (r === null) {
        const errors = await this.drainErrors();
        return { reply: null, block: null, errors: [{ code: 0, message: "no reply within the timeout — the instrument does not answer this query" }, ...errors] };
      }
      if (r.kind === "line") reply = r.text;
      else {
        const printable = r.data.length > 0 && r.data.filter((b) => b === 9 || b === 10 || b === 13 || (b >= 32 && b < 127)).length / r.data.length > 0.95;
        block = {
          bytes: r.data.length,
          text: printable ? new TextDecoder().decode(r.data.subarray(0, 20000)) : null,
          hex: Array.from(r.data.subarray(0, 64), (b) => b.toString(16).padStart(2, "0")).join(" "),
        };
      }
    } else {
      await this.scpi.write(c);
    }
    const errors = await this.drainErrors();
    this.frameDirty = true;
    setTimeout(() => void this.watch().catch(() => {}), 50);
    return { reply, block, errors };
  }

  async syncClock(): Promise<{ date: string; time: string }> {
    this.need();
    this.offered("clock", "Setting the clock");
    const d = new Date();
    const date = `${d.getFullYear()},${d.getMonth() + 1},${d.getDate()}`;
    const time = `${d.getHours()},${d.getMinutes()},${d.getSeconds()}`;
    await this.scpi.write(`:SYSTem:DATE ${date}`);
    await this.scpi.write(`:SYSTem:TIME ${time}`);
    await this.drainErrors();
    return { date, time };
  }

  /** A multi-argument setting the generic panels cannot express (logic channel on/off and labels). */
  async digital(ch: number, patch: { enable?: boolean; label?: string }): Promise<{ enable: boolean | null; label: string | null }> {
    this.need();
    this.offered("decode", "Logic channels");
    if (!(ch >= 0 && ch < C.instrument.digital_channels)) throw new HttpError(400, "digital channel 0–15");
    if (patch.enable !== undefined) await this.scpi.write(`:LA:DIGital:ENABle D${ch},${patch.enable ? 1 : 0}`);
    if (patch.label !== undefined) await this.scpi.write(`:LA:DIGital:LABel D${ch},${encode(patch.label.slice(0, 16), "string")}`);
    const enable = parseBool(await this.scpi.query(`:LA:DIGital:ENABle? D${ch}`));
    const label = (await this.scpi.query(`:LA:DIGital:LABel? D${ch}`)).trim();
    await this.drainErrors();
    return { enable, label };
  }

  async busTable(n: number): Promise<{ protocol: string; header: string[]; rows: string[][] }> {
    this.need();
    this.offered("decode", "Bus decoding");
    const data = await this.scpi.queryBlock(`:BUS${n}:DATA?`);
    return parseBusTable(new TextDecoder().decode(data));
  }

  /** Refuse a feature the instrument on the line does not have. */
  offered(f: keyof Registry["features"], what: string): void {
    if (!this.reg.features[f]) throw new HttpError(400, `${what} is not offered for ${this.link.idn?.model ?? "this instrument"}`);
  }

  /** Pause the live loop for a long job; the lock makes a second job fail fast instead of queueing. */
  async withBusy<T>(what: string, fn: () => Promise<T>): Promise<T> {
    this.need();
    if (this.busy) throw new HttpError(409, `busy: ${this.busy} is running`);
    this.busy = what;
    this.broadcast("busy", this.busy);
    try {
      return await fn();
    } finally {
      this.busy = null;
      this.frameDirty = true;
      this.broadcast("busy", null);
    }
  }

  noViewers(): void {
    /* the loop idles by itself when viewers is 0 */
  }

  async stop(): Promise<void> {
    await this.disconnect().catch(() => {});
  }

  broadcastRaw(type: string, data: unknown): void {
    this.broadcast(type, data);
  }
}

/** "#9…RS232\nTime,TX,\n1.0E-3,4D,\n" (block header already removed) → rows. */
export function parseBusTable(text: string): { protocol: string; header: string[]; rows: string[][] } {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  const protocol = lines.shift()?.trim() ?? "";
  const header = (lines.shift() ?? "").split(",").filter(Boolean);
  const rows = lines.map((l) => l.split(",").filter((_, i, a) => i < a.length - 1 || a[i] !== ""));
  return { protocol, header, rows };
}

export function same(a: Value, b: Value): boolean {
  if (typeof a === "number" && typeof b === "number") return Math.abs(a - b) <= Math.max(Math.abs(a), Math.abs(b)) * 1e-6 + 1e-15;
  return a === b;
}
