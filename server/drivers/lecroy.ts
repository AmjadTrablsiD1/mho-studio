// Teledyne LeCroy X-Stream oscilloscopes over VICP (TCP port 1861).
//
// At connect the driver turns response headers off (CHDR OFF) and asks for
// waveforms as 16-bit little-endian words (CFMT DEF9,WORD,BIN; CORD LO), so
// an 8-bit ADC's codes arrive with room for averaging and ERES.
//
// Screen records: the acquisition can be millions of points (40 GS/s × 10
// divisions), so the live view asks for every Nth point (WFSU SP,N), about
// C.lecroy.screen_points per channel. Sparsing is decimation without a filter:
// a signal above the sparsed Nyquist frequency aliases on the screen trace and
// in a screen spectrum. Deep memory reads every point, in chunks (WFSU NP/FP).
//
// What is not certain without the instrument, and how the code copes:
//  • whether a sparsed descriptor's HORIZ_INTERVAL already includes the
//    sparsing factor — the record's span is compared with 10 × TDIV;
//  • which optional queries a given model and firmware answer — unanswered
//    ones are learned and not asked again (the service does this).

import { C } from "../../core/src/constants.ts";
import { key, type Control } from "../../core/src/registry/controls.ts";
import { channelOf, registryFor } from "../../core/src/registry/families.ts";
import { LECROY_ACTIONS } from "../../core/src/registry/lecroy.ts";
import type { Slot } from "../../core/src/registry/measurements.ts";
import { CMR, after, decodeLecroyWave, field, lecroyIdn, lecroyNumber, lecroyValue, parsePava, parseWavedesc, preambleOf, type Wavedesc } from "../../core/src/scpi/lecroy.ts";
import { makeBlock } from "../../core/src/scpi/block.ts";
import { encode, type Value } from "../../core/src/scpi/values.ts";
import type { ScopeService } from "../scope.ts";
import { HttpError } from "../errors.ts";
import type { DeepChunk, Driver, InstrumentError, Record1 } from "./types.ts";

/** "CHANnel2" → "C2". */
function lc(src: string): string {
  const n = channelOf(src);
  if (n === null) throw new HttpError(400, `${src} is not an analog channel of this LeCroy`);
  return `C${n}`;
}

/**
 * Seconds between the points of a record. When the record is sparsed, take
 * whichever reading of HORIZ_INTERVAL (as is, or × SPARSING_FACTOR) makes the
 * record span closest to what TDIV says the screen spans.
 */
export function pointInterval(d: Wavedesc, count: number, tdiv: number | null): number {
  if (d.sparsing <= 1 || !tdiv) return d.interval;
  const want = 10 * tdiv;
  const a = Math.abs(count * d.interval - want);
  const b = Math.abs(count * d.interval * d.sparsing - want);
  return b < a ? d.interval * d.sparsing : d.interval;
}

export class LecroyDriver implements Driver {
  readonly reg = registryFor("lecroy");
  private s: ScopeService;
  /** The trigger mode Run goes back to (Stop and Single leave it). */
  private runMode: string = C.lecroy.run_mode_default;
  /** Points in a full record, per channel, and when that was learned; and the bits per point its descriptor states. */
  private totals = new Map<string, { total: number; bits: number; key: string; at: number }>();
  /** Deep memory read as bytes (8-bit data), half the transfer of words. */
  byteDeep = false;

  constructor(s: ScopeService) {
    this.s = s;
  }

  async init(): Promise<string> {
    const q = this.s.scpi;
    await q.write("CHDR OFF");
    await q.write("CFMT DEF9,WORD,BIN");
    await q.write("CORD LO");
    // With headers off, *IDN? answers without its "*IDN " prefix: that is the reply the resync waits for.
    return lecroyIdn(await q.query("*IDN?")).raw;
  }

  private fill(t: string, n: number | null, v?: string): string {
    // {src}: the trigger source as automation names it (C1, Ext, ExtDivide10, Line); {lsrc}: as the legacy commands do (C1, EX, EX10, LINE).
    const src = String(this.s.values.get("trigger.edge.source") ?? "C1") || "C1";
    const lsrc = ({ EXT: "EX", EXTDIVIDE10: "EX10", LINE: "LINE" } as Record<string, string>)[src.toUpperCase()] ?? src;
    let out = t.replaceAll("<n>", String(n ?? 1)).replaceAll("{src}", src).replaceAll("{lsrc}", lsrc);
    if (v !== undefined) out = out.replaceAll("{v}", v);
    return out;
  }

  queryOf(c: Control, n: number | null): string {
    if (!c.q) throw new HttpError(400, `${c.label} cannot be read on this instrument`);
    return this.fill(c.q, n);
  }

  setOf(c: Control, n: number | null, v: Value): string {
    if (!c.w) throw new HttpError(400, `${c.label} cannot be set on this instrument`);
    const vbs = c.w.startsWith("VBS");
    let text: string;
    if (c.kind === "bool") text = vbs ? (v ? "True" : "False") : v ? "ON" : "OFF";
    else if (c.kind === "number") text = encode(v, "number");
    // Inside VBS '…' a quote of either kind would end the script early.
    else text = vbs ? `"${String(v).replace(/["'\r\n]/g, "")}"` : String(v).replace(/[\r\n;]/g, " ");
    return this.fill(c.w, n, text);
  }

  parse(c: Control, n: number | null, reply: string): Value {
    let r = reply.trim();
    if (typeof c.pick === "number") r = field(r, c.pick);
    else if (typeof c.pick === "string") r = after(r, this.fill(c.pick, n));
    return lecroyValue(c.kind, r, c.options?.map((o) => o.value));
  }

  /** The automation property behind a control, if it has one: its `b`, or the property its VBS query reads. */
  private propOf(c: Control, n: number | null): string | null {
    const t = c.b ?? /^VBS\? 'return=app\.(.+)'$/.exec(c.q ?? "")?.[1];
    return t ? this.fill(t, n) : null;
  }

  batchable(c: Control): boolean {
    return this.propOf(c, 1) !== null;
  }

  /**
   * One VBS line for many values: return=app.A & "|" & app.B … The reply is
   * split on "|". VBScript turns numbers into text with the instrument's
   * Windows locale, so a decimal comma ("0,05") is accepted too.
   */
  async readMany(items: { c: Control; n: number | null }[]): Promise<Value[] | null> {
    const props = items.map((it) => this.propOf(it.c, it.n));
    if (!items.length || props.some((p) => !p)) return null;
    const sep = C.lecroy.batch_separator;
    const expr = props.map((p) => `app.${p}`).join(` & "${sep}" & `);
    const reply = await this.s.scpi.query(`VBS? 'return=${expr}'`, C.instrument.value_timeout_ms * 2);
    const parts = reply.trim().split(sep);
    if (parts.length !== items.length) return null;
    return items.map(({ c }, i) => {
      let r = parts[i].trim();
      if (c.bmap) r = c.bmap[r] ?? r;
      if ((c.kind === "number" || c.kind === "readonly") && /^[+-]?\d+,\d+(E[+-]?\d+)?$/i.test(r)) r = r.replace(",", ".");
      return lecroyValue(c.kind, r, c.options?.map((o) => o.value));
    });
  }

  async errors(): Promise<InstrumentError[]> {
    const q = this.s.scpi;
    const out: InstrumentError[] = [];
    const cmr = lecroyNumber(await q.query("CMR?")) ?? 0;
    if (cmr) out.push({ code: cmr, message: `command error: ${CMR[cmr] ?? "see the CMR table of the remote control manual"}` });
    const exr = lecroyNumber(await q.query("EXR?")) ?? 0;
    if (exr) out.push({ code: exr, message: `execution error ${exr} (EXR table of the remote control manual)` });
    return out;
  }

  /** TRMD? for the mode; INR? bit 0 ("new signal acquired", cleared by reading) for whether it triggered. */
  async status(): Promise<string> {
    const q = this.s.scpi;
    const mode = (await q.query("TRMD?")).trim().toUpperCase();
    if (mode.startsWith("STOP")) return "STOP";
    if (mode.startsWith("AUTO") || mode.startsWith("NORM")) this.runMode = mode.startsWith("AUTO") ? "AUTO" : "NORM";
    const inr = lecroyNumber(await q.query("INR?")) ?? 0;
    if (inr & 1) return "TD";
    return mode.startsWith("AUTO") ? "AUTO" : "WAIT";
  }

  async action(c: Control, _n: number | null): Promise<void> {
    if (c.id === "root.run") return this.s.scpi.write(`TRMD ${this.runMode}`);
    if (c.id === "root.stop" || c.id === "root.single") {
      // Remember the running mode now (it may have been changed at the instrument since the last poll).
      const m = (await this.s.scpi.query("TRMD?")).trim().toUpperCase();
      if (m.startsWith("AUTO") || m.startsWith("NORM")) this.runMode = m.startsWith("AUTO") ? "AUTO" : "NORM";
    }
    const cmd = LECROY_ACTIONS[c.id];
    if (!cmd) throw new HttpError(400, `${c.label} is not offered on this instrument`);
    await this.s.scpi.write(cmd);
  }

  visibleSources(): string[] {
    const out: string[] = [];
    for (let n = 1; n <= C.lecroy.analog_channels; n++) if (this.s.values.get(key("channel.display", n)) === true) out.push(`CHANnel${n}`);
    return out;
  }

  /** Points in the whole record of channel `name` ("C1"), learned from a descriptor and kept while the timebase and memory stay. */
  private async total(name: string): Promise<number> {
    const k = `${this.s.values.get("timebase.scale")}|${this.s.values.get("acquire.mdepth")}`;
    const t = this.totals.get(name);
    if (t && t.key === k && Date.now() - t.at < 3000) return t.total;
    const q = this.s.scpi;
    await q.write("WFSU SP,0,NP,0,FP,0,SN,0");
    const d = parseWavedesc(await q.queryBlock(`${name}:WF? DESC`, C.instrument.query_timeout_ms * 2));
    const total = Math.max(d.count, d.lastValid - d.firstValid + 1, 0);
    this.totals.set(name, { total, bits: d.nominalBits, key: k, at: Date.now() });
    return total;
  }

  private async record(src: string, sparse: boolean): Promise<Record1> {
    const q = this.s.scpi;
    const name = lc(src);
    const total = sparse ? await this.total(name) : 0;
    const sp = sparse ? Math.max(1, Math.ceil(total / C.lecroy.screen_points)) : 1;
    await q.write(`WFSU SP,${sp},NP,0,FP,0,SN,0`);
    const block = await q.queryBlock(`${name}:WF? ALL`, C.instrument.query_timeout_ms * 4);
    const { desc, volts } = decodeLecroyWave(block);
    const tdiv = this.s.values.get("timebase.scale");
    const xinc = pointInterval(desc, volts.length, typeof tdiv === "number" ? tdiv : null);
    const pre = { ...preambleOf(desc, volts.length), xinc, mode: sp > 1 ? ("NORM" as const) : ("RAW" as const) };
    return { volts, pre };
  }

  async frame(srcs: string[]): Promise<Map<string, Record1>> {
    const out = new Map<string, Record1>();
    for (const src of srcs) out.set(src, await this.record(src, true));
    // The screen centre is not a setting on LeCroy: take it from the record (time of first point + half the span).
    const first = out.values().next().value as Record1 | undefined;
    if (first && first.volts.length) {
      const centre = first.pre.xorigin + (first.volts.length * first.pre.xinc) / 2;
      const was = this.s.values.get("timebase.offset");
      if (typeof was !== "number" || Math.abs(was - centre) > first.pre.xinc) this.s.setComputed("timebase.offset", centre);
    }
    return out;
  }

  readTrace(src: string): Promise<Record1> {
    return this.record(src, true);
  }

  async screenshot(): Promise<Uint8Array> {
    const q = this.s.scpi;
    await q.write(C.lecroy.screenshot_setup);
    return q.queryBlock("SCDP", C.instrument.block_timeout_ms);
  }

  setupBlob(): Promise<Uint8Array> {
    return this.s.scpi.queryBlock("PNSU?", C.instrument.block_timeout_ms);
  }

  async restoreSetup(blob: Uint8Array): Promise<void> {
    const block = makeBlock(blob);
    const head = new TextEncoder().encode("PNSU ");
    const msg = new Uint8Array(head.length + block.length);
    msg.set(head, 0);
    msg.set(block, head.length);
    await this.s.scpi.writeBytes(msg, `PNSU #9… (${blob.length} bytes)`);
  }

  async addMeasurement(slot: Slot): Promise<void> {
    lc(slot.src1);
    // PARAMETER_VALUE? computes on demand: nothing to set up on the instrument.
  }

  async measurementsChanged(): Promise<void> {
    /* nothing is set up on the instrument */
  }

  async readMeasurement(slot: Slot): Promise<number | null> {
    return parsePava(await this.s.scpi.query(`${lc(slot.src1)}:PAVA? ${slot.item}`)).value;
  }

  async deepBegin(): Promise<{ total: number }> {
    const q = this.s.scpi;
    await q.write("STOP");
    await q.query("*OPC?", 10000).catch(() => "");
    this.totals.clear();
    // Every displayed channel holds the same number of points; the first one tells.
    const srcs = this.visibleSources().length ? this.visibleSources() : ["CHANnel1"];
    const total = await this.total(lc(srcs[0]));
    for (const s of srcs.slice(1)) await this.total(lc(s));
    // 8-bit data loses nothing as bytes: half the transfer. Averaged (or ERES) data has more bits: keep words.
    this.byteDeep = srcs.every((s) => {
      const n = Number(/(\d)$/.exec(s)?.[1]);
      const avg = this.s.values.get(key("channel.averages", n));
      const bits = this.totals.get(lc(s))?.bits ?? 16;
      return bits > 0 && bits <= 8 && (avg === null || avg === undefined || Number(avg) <= 1);
    });
    if (this.byteDeep) await q.write("CFMT DEF9,BYTE,BIN");
    return { total };
  }

  async deepChunk(src: string, start: number, count: number): Promise<DeepChunk> {
    const q = this.s.scpi;
    const name = lc(src);
    await q.write(`WFSU SP,0,NP,${count},FP,${start},SN,0`);
    const block = await q.queryBlock(`${name}:WF? ALL`, C.instrument.block_timeout_ms);
    const { desc, codes } = decodeLecroyWave(block);
    if (!codes.length) throw new HttpError(502, `the scope returned no data for ${name} points ${start}–${start + count - 1}`);
    const u = new Uint16Array(codes.length);
    for (let i = 0; i < codes.length; i++) u[i] = codes[i] + 32768;
    // The deep store keeps the preamble of the first chunk (start 0), whose HORIZ_OFFSET is the time of point 0.
    return { pre: preambleOf(desc, codes.length), codes: u, bytes: block.length };
  }

  async deepEnd(resume: boolean, wasRunning: boolean): Promise<void> {
    const q = this.s.scpi;
    await q.write("WFSU SP,0,NP,0,FP,0,SN,0").catch(() => {});
    if (this.byteDeep) await q.write("CFMT DEF9,WORD,BIN").catch(() => {});
    this.byteDeep = false;
    if (resume && wasRunning) await q.write(`TRMD ${this.runMode}`).catch(() => {});
  }

  /** The math slot set up for the FFT ("src|window"), so it is configured once, not every read. */
  private fftKey: string | null = null;

  /**
   * F8 = FFT(source) on the instrument: computed on the whole record at the
   * full sample rate, so it does not alias like the sparsed screen record; only
   * the spectrum crosses the link. Property names from the automation manual
   * (app.Math.Fx.Operator1Setup: Window, Type).
   */
  async scopeFft(src: string, window: string): Promise<{ df: number; f0: number; mag: Float32Array; unit: string; points: number }> {
    const q = this.s.scpi;
    const F = C.lecroy.fft_slot;
    const name = lc(src);
    const key = `${name}|${window}`;
    if (this.fftKey !== key) {
      const win = (C.lecroy.fft_windows as Record<string, string>)[window] ?? "VonHann";
      for (const line of [`Source1 = "${name}"`, `MathMode = "OneOperator"`, `Operator1 = "FFT"`, `Operator1Setup.Window = "${win}"`, `Operator1Setup.Type = "Magnitude"`, `View = True`]) {
        await q.write(`VBS 'app.Math.${F}.${line}'`);
      }
      this.fftKey = key;
    }
    await q.write("WFSU SP,0,NP,0,FP,0,SN,0");
    const { desc, volts } = decodeLecroyWave(await q.queryBlock(`${F}:WF? ALL`, C.instrument.block_timeout_ms));
    return { df: desc.interval, f0: desc.horizOffset, mag: volts, unit: desc.vertUnit, points: volts.length };
  }

  async scopeFftStop(): Promise<void> {
    if (!this.fftKey) return;
    this.fftKey = null;
    await this.s.scpi.write(`VBS 'app.Math.${C.lecroy.fft_slot}.View = False'`);
  }

  slowQuery(cmd: string): boolean {
    return /WF\?|SCDP|PNSU\?|HCSU/i.test(cmd);
  }
}
