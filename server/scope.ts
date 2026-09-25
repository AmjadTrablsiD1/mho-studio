// The oscilloscope as the app sees it: the link, a mirror of every value read
// back from the instrument, the live waveform loop, measurements, readings.
//
// Rule: the instrument is the truth. After every write the value is read back
// and the error queue drained; the UI shows what the scope actually set, and
// says so when that differs from what was asked for.

import { C } from "../core/src/constants.ts";
import { BY_ID, CONTROLS, key, keysOf, parseKey, relevant, type Control } from "../core/src/registry/controls.ts";
import { render } from "../core/src/scpi/header.ts";
import { encode, matchOption, parseBool, parseError, parseIdn, parseNumber, type Identity, type Value } from "../core/src/scpi/values.ts";
import { codes, detectWordOrder, parsePreamble, toVolts, type ByteOrder, type Preamble } from "../core/src/wave/decode.ts";
import { delay, measureAll, Stats } from "../core/src/dsp/measure.ts";
import { MEASUREMENT_BY_ITEM, type Slot } from "../core/src/registry/measurements.ts";
import { ScpiClient, ScpiError, type Traffic } from "./scpi.ts";
import { transportStatus } from "./transport.ts";
import { loadSettings, saveSettings } from "./store.ts";
import { startSim, type SimHandle } from "../sim/server.ts";

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export type LinkState = "idle" | "connecting" | "connected" | "lost";
export type Link = {
  state: LinkState;
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
  link: Link = { state: "idle", host: "", port: C.instrument.scpi_port, sim: false, idn: null, error: null, transport: null, rttMs: null, wordOrder: C.wire.word_order_default as ByteOrder, wordOrderLocked: false, modelWarning: null };
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
  private sim: SimHandle | null = null;
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

  async connect(opts: { host?: string; port?: number; sim?: boolean }): Promise<Link> {
    this.wantConnected = true;
    this.loopToken++;
    this.scpi.close("reopen");
    let host = (opts.host ?? "").trim();
    let port = Number(opts.port ?? C.instrument.scpi_port);
    if (opts.sim) {
      if (!this.sim) this.sim = await startSim(0);
      host = "127.0.0.1";
      port = this.sim.port;
    } else if (!host) {
      throw new HttpError(400, "enter the oscilloscope's IP address (Utility → I/O → LAN on the MHO984)");
    }
    if (!/^[\w.:-]+$/.test(host)) throw new HttpError(400, "host must be a hostname or an IP address");
    if (!(port > 0 && port < 65536)) throw new HttpError(400, "port must be 1–65535");
    this.values.clear();
    this.latest.clear();
    this.setLink({ state: "connecting", host, port, sim: !!opts.sim, error: null, idn: null, modelWarning: null, wordOrderLocked: false });
    try {
      await this.scpi.open(host, port);
      await this.handshake();
    } catch (e) {
      this.scpi.close("closed");
      this.setLink({ state: "idle", error: this.explain(e as Error, host, port) });
      throw new HttpError(502, this.link.error!);
    }
    if (!opts.sim) {
      const s = loadSettings();
      saveSettings({ ...s, host, port, lastWasSim: false, recent: [host, ...s.recent.filter((h) => h !== host)].slice(0, 8) });
    } else {
      saveSettings({ ...loadSettings(), lastWasSim: true });
    }
    this.startLoop();
    return this.link;
  }

  private explain(e: Error, host: string, port: number): string {
    const code = (e as NodeJS.ErrnoException).code ?? (e as ScpiError).code ?? "";
    if (code === "ECONNREFUSED") return `${host} refused port ${port}. Is it the oscilloscope, and is LAN enabled (Utility → I/O)?`;
    if (code === "ETIMEDOUT" || /within/.test(e.message)) return `No answer from ${host}:${port}. Check the cable, the IP address and that the PC is on the same network.`;
    if (code === "EHOSTUNREACH" || code === "ENETUNREACH") return `${host} is unreachable from this computer (${code}). On macOS, check System Settings → Privacy & Security → Local Network.`;
    return e.message;
  }

  private async handshake(): Promise<void> {
    const idn = parseIdn(await this.scpi.query("*IDN?"));
    const warn = /MHO9/i.test(idn.model) ? null : `This app is built for the MHO984; "${idn.model || idn.raw}" answered. Commands follow the MHO900 guide and may differ on it.`;
    this.setLink({ state: "connected", idn, transport: transportStatus().active, modelWarning: warn, error: null });
    await this.scpi.write("*CLS");
    this.options = {};
    for (const o of C.instrument.options) {
      const r = await this.scpi.query(`:SYSTem:OPTion:STATus? ${o}`).catch(() => "0");
      this.options[o] = parseBool(r) === true;
    }
    await this.drainErrors();
    this.broadcast("options", this.options);
    await this.readKeys(this.primaryKeys());
    await this.readKeys(this.triggerTypeKeys());
    this.status = (await this.scpi.query(":TRIGger:STATus?")).trim();
    this.broadcast("status", this.status);
    this.frameDirty = true;
  }

  async disconnect(): Promise<Link> {
    this.wantConnected = false;
    this.loopToken++;
    this.scpi.close("closed");
    if (this.sim) {
      await this.sim.close();
      this.sim = null;
    }
    this.setLink({ state: "idle", error: null });
    return this.link;
  }

  private async lost(why: string): Promise<void> {
    if (!this.wantConnected) return;
    this.loopToken++;
    this.setLink({ state: "lost", error: `Connection lost (${why}). Reconnecting…` });
    for (let attempt = 1; this.wantConnected && this.link.state === "lost"; attempt++) {
      await sleep(C.instrument.reconnect_backoff_ms * Math.min(attempt, 5));
      if (!this.wantConnected || this.link.state !== "lost") return;
      try {
        await this.scpi.open(this.link.host, this.link.port);
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
    return CONTROLS.filter((c) => c.primary && c.query && this.has(c.needs)).flatMap(keysOf);
  }

  triggerTypeKeys(): string[] {
    const mode = String(this.values.get("trigger.mode") ?? "EDGE");
    return this.groupKeys("trigger", null).filter((k) => {
      const c = BY_ID.get(parseKey(k).id)!;
      return c.sub && c.when && relevant(c, null, () => mode);
    });
  }

  /** Every readable key in a group (optionally one sub-group and one suffix). */
  groupKeys(group: string, sub: string | null | undefined, n?: number): string[] {
    return CONTROLS.filter((c) => c.group === group && (sub === undefined || c.sub === sub) && c.query && !c.hidden && this.has(c.needs))
      .flatMap((c) => (c.suffix ? (n ? [key(c.id, n)] : keysOf(c)) : [c.id]));
  }

  parse(c: Control, reply: string): Value {
    const r = reply.trim();
    switch (c.kind) {
      case "number":
        return parseNumber(r);
      case "bool":
        return parseBool(r);
      case "enum":
        return matchOption(r, c.options?.map((o) => o.value) ?? []) ?? r;
      case "readonly":
        return c.unit && Number.isFinite(Number(r)) ? parseNumber(r) : r;
      default:
        return r;
    }
  }

  async readKey(k: string): Promise<Value> {
    const { id, n } = parseKey(k);
    const c = BY_ID.get(id);
    if (!c) throw new HttpError(404, `no control ${id}`);
    if (!c.query) throw new HttpError(400, `${c.header} cannot be read`);
    const reply = await this.scpi.query(`${render(c.header, c.suffix ? { [c.suffix.name]: n ?? 1 } : {})}?`);
    const v = this.parse(c, reply);
    this.values.set(k, v);
    return v;
  }

  async readKeys(keys: string[]): Promise<Record<string, Value>> {
    const read: string[] = [];
    for (const k of keys) {
      try {
        await this.readKey(k);
        read.push(k);
      } catch (e) {
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

  /** Read and clear the instrument's error queue. */
  async drainErrors(): Promise<{ code: number; message: string }[]> {
    const errs: { code: number; message: string }[] = [];
    for (let i = 0; i < 8; i++) {
      const e = parseError(await this.scpi.query(":SYSTem:ERRor?"));
      if (e.code === 0) break;
      errs.push(e);
    }
    return errs;
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
    const c = BY_ID.get(id);
    if (!c) throw new HttpError(404, `no control ${id}`);
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
    const sfx = c.suffix ? { [c.suffix.name]: n ?? 1 } : {};
    const result = await this.scpi.exclusive(async () => {
      await this.scpi.write(`${render(c.header, sfx)} ${encode(v, c.kind as "number" | "enum" | "bool" | "string")}`);
      await sleep(C.loops.after_write_settle_ms);
      const readback = c.query ? await this.readKey(k) : v;
      const also = (c.after ?? []).flatMap((a) => {
        const ac = BY_ID.get(a);
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
    const c = BY_ID.get(id);
    if (!c || c.kind !== "action") throw new HttpError(404, `no action ${id}`);
    if (c.confirm && !confirmed) throw new HttpError(409, c.confirm);
    await this.scpi.write(render(c.header, c.suffix ? { [c.suffix.name]: n ?? 1 } : {}));
    if (id === "root.autoset" || id === "common.rst" || id === "system.reset") {
      await sleep(id === "root.autoset" ? 1500 : 800);
      await this.scpi.query("*OPC?", 15000).catch(() => "");
      await this.readKeys(this.primaryKeys());
      await this.readKeys(this.triggerTypeKeys());
    }
    const errors = await this.drainErrors();
    this.status = (await this.scpi.query(":TRIGger:STATus?")).trim();
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
          const st = (await this.scpi.query(":TRIGger:STATus?")).trim();
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
        this.broadcast("problem", { message: (e as Error).message });
        await sleep(C.loops.idle_backoff_ms);
      }
      const spent = Date.now() - t0;
      const wait = (this.status === "STOP" ? C.loops.idle_backoff_ms : C.loops.live_period_ms) - spent;
      if (wait > 0) await sleep(wait);
    }
  }

  /** Which sources are on screen: displayed channels and math. */
  visibleSources(): string[] {
    const out: string[] = [];
    for (let n = 1; n <= C.instrument.analog_channels; n++) if (this.values.get(key("channel.display", n)) === true) out.push(`CHANnel${n}`);
    for (let n = 1; n <= C.instrument.math_channels; n++) if (this.values.get(key("math.display", n)) === true) out.push(`MATH${n}`);
    return out;
  }

  /** One screen of every visible source (NORMal mode, 1000 points). */
  async frame(): Promise<void> {
    const srcs = this.visibleSources();
    const word = C.wire.prefer_word_format;
    const traces: Trace[] = [];
    await this.scpi.exclusive(async () => {
      await this.scpi.write(`:WAVeform:MODE NORMal`);
      await this.scpi.write(`:WAVeform:FORMat ${word ? "WORD" : "BYTE"}`);
      for (const src of srcs) {
        await this.scpi.write(`:WAVeform:SOURce ${src}`);
        const pre = parsePreamble(await this.scpi.query(":WAVeform:PREamble?"));
        const data = await this.scpi.queryBlock(":WAVeform:DATA?", C.instrument.query_timeout_ms * 2);
        const volts = this.decode(data, pre);
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
      await this.scpi.write(`:WAVeform:SOURce ${src}`);
      await this.scpi.write(`:WAVeform:MODE NORMal`);
      await this.scpi.write(`:WAVeform:FORMat ${C.wire.prefer_word_format ? "WORD" : "BYTE"}`);
      const pre = parsePreamble(await this.scpi.query(":WAVeform:PREamble?"));
      const volts = this.decode(await this.scpi.queryBlock(":WAVeform:DATA?"), pre);
      const l = { volts, pre, t: Date.now() };
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
    const keys = CONTROLS.filter((c) => c.watch && c.query && this.has(c.needs)).flatMap(keysOf);
    const changed: Record<string, Value> = {};
    for (const k of keys) {
      const before = this.values.get(k);
      const v = await this.readKey(k);
      if (!same(before ?? null, v)) changed[k] = v;
    }
    if (Object.keys(changed).length) {
      if ("trigger.mode" in changed) for (const t of this.triggerTypeKeys()) changed[t] = await this.readKey(t);
      this.broadcast("values", this.current(Object.keys(changed)));
      this.frameDirty = true;
    }
  }

  // ---------------------------------------------------------- measurements

  async addMeasurement(item: string, src1: string, src2?: string): Promise<MeasureRow[]> {
    this.need();
    const m = MEASUREMENT_BY_ITEM.get(item);
    if (!m) throw new HttpError(400, `unknown measurement ${item}`);
    if (m.dual && !src2) throw new HttpError(400, `${m.label} needs two sources`);
    if (this.slots.length >= C.measure.max_items) throw new HttpError(400, `at most ${C.measure.max_items} measurements`);
    if (!/^(CHANnel[1-4]|MATH[1-4]|D\d{1,2})$/.test(src1) || (src2 && !/^(CHANnel[1-4]|MATH[1-4]|D\d{1,2})$/.test(src2))) throw new HttpError(400, "bad source");
    const slot: Slot = { id: `m${++this.slotSeq}`, item, src1, src2: m.dual ? src2 : undefined };
    await this.scpi.write(`:MEASure:ITEM ${item},${src1}${slot.src2 ? `,${slot.src2}` : ""}`);
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
      // The guide only offers "delete all"; put the rest back.
      await this.scpi.write(":MEASure:DELete");
      for (const s of this.slots) await this.scpi.write(`:MEASure:ITEM ${s.item},${s.src1}${s.src2 ? `,${s.src2}` : ""}`);
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
      const r = await this.scpi.query(`:MEASure:ITEM? ${s.item},${s.src1}${s.src2 ? `,${s.src2}` : ""}`);
      this.stats.get(s.id)?.add(parseNumber(r));
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
    const v = m[s.item] ?? null;
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
    return this.scpi.queryBlock(":DISPlay:DATA? PNG");
  }

  async setupBlob(): Promise<Uint8Array> {
    this.need();
    return this.scpi.queryBlock(":SYSTem:SETup?");
  }

  async restoreSetup(blob: Uint8Array): Promise<{ errors: { code: number; message: string }[] }> {
    this.need();
    const head = new TextEncoder().encode(`:SYSTem:SETup #9${String(blob.length).padStart(9, "0")}`);
    const msg = new Uint8Array(head.length + blob.length + 1);
    msg.set(head, 0);
    msg.set(blob, head.length);
    msg[msg.length - 1] = 0x0a;
    await this.scpi.writeBytes(msg, `:SYSTem:SETup #9… (${blob.length} bytes)`);
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
      const r = await this.scpi.queryAny(c);
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
    const data = await this.scpi.queryBlock(`:BUS${n}:DATA?`);
    return parseBusTable(new TextDecoder().decode(data));
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
