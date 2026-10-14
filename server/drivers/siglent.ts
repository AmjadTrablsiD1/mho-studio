// Siglent-made oscilloscopes — the Teledyne T3DSO1000 series (T3DSO1204) and
// Siglent's SDS1000X-E — over raw TCP port 5025 or USB-TMC.
//
// What the first session with a T3DSO1204 (fw 8.3.6.1.37R8, over USB,
// 2026-10-14) showed, and how the driver follows it:
//  • It answers *IDN? as "Lecroy,T3DSO1204 ,…" but speaks Siglent's SCPI: no
//    VBS, no VICP, no CFMT. The family is chosen by model, not vendor.
//  • Headers go off with CHDR OFF; numbers then come without units.
//  • Waveforms: "DAT2,#9…" + signed 8-bit codes + "\n\n". The link is told
//    to drop the text before the block and both newlines.
//  • Volts and times come from the settings, not the descriptor (its time
//    origin was 0 and its gain did not match V/div): volts = code × VDIV / 25
//    − OFST; the first point is at −TRDL − 7 × TDIV (14 divisions).
//  • Screenshots are a raw RGB565 BMP (no block header): read by the BMP's own
//    length and turned into PNG.
//  • Compound queries do not work ("A?;B?" answers only A): one at a time.
//  • Over USB it follows a block with an empty transfer (handled in usbtmc.ts).
// Still to check on a live signal (TODO → Next): the sign of TRDL; whether WFSU
// SP (every Nth point) is honoured on a long record — if not, the driver
// thins the record itself and says so in the log.

import { C } from "../../core/src/constants.ts";
import { key, type Control } from "../../core/src/registry/controls.ts";
import { channelOf, registryFor } from "../../core/src/registry/families.ts";
import { SIGLENT_ACTIONS } from "../../core/src/registry/siglent.ts";
import type { Slot } from "../../core/src/registry/measurements.ts";
import { after, field } from "../../core/src/scpi/lecroy.ts";
import { esrErrors, parseSiglentPava, siglentCodes, siglentNumber, siglentT0, siglentValue, siglentVolts, type SiglentScale } from "../../core/src/scpi/siglent.ts";
import { makeBlock } from "../../core/src/scpi/block.ts";
import { encode, type Value } from "../../core/src/scpi/values.ts";
import type { Preamble } from "../../core/src/wave/decode.ts";
import { decodeBmp } from "../../core/src/img/bmp.ts";
import { Raster } from "../../sim/png.ts";
import type { ScopeService } from "../scope.ts";
import { HttpError } from "../errors.ts";
import { log } from "../log.ts";
import type { DeepChunk, Driver, InstrumentError, Record1 } from "./types.ts";

const S = C.siglent;

/** "CHANnel2" → 2, or a 400 for anything that is not an analog channel. */
function chOf(src: string): number {
  const n = channelOf(src);
  if (n === null) throw new HttpError(400, `${src} is not an analog channel of this oscilloscope`);
  return n;
}

/** The scale of a channel's codes, as a preamble: volts = (code − yorigin − yref) × yinc. */
function preambleFor(sc: SiglentScale, points: number, xinc: number, xorigin: number, yref: number): Preamble {
  const yinc = sc.vdiv / S.codes_per_div;
  return { format: "BYTE", mode: "RAW", points, count: 1, xinc, xorigin, xref: 0, yinc, yorigin: yinc ? sc.ofst / yinc : 0, yref };
}

export class SiglentDriver implements Driver {
  readonly reg = registryFor("siglent");
  private s: ScopeService;
  /** The trigger mode Run goes back to (Stop and Single leave it). */
  private runMode: string = S.run_mode_default;
  /** The WAVEFORM_SETUP last sent: not sent again while unchanged. */
  private wfsuSent: string | null = null;
  /** The settings that scale the records, with the settings generation and time they were read. */
  private scales: { t: Omit<SiglentScale, "vdiv" | "ofst">; ch: Map<number, { vdiv: number; ofst: number }>; gen: number; at: number } | null = null;
  /** Said once per connection when the instrument ignores WFSU SP. */
  private sparseIgnored = false;

  constructor(s: ScopeService) {
    this.s = s;
  }

  async init(idnRaw: string): Promise<string> {
    const q = this.s.scpi;
    q.setFraming({ blockPrefix: true, blockTrailer: 2 });
    await q.write("CHDR OFF");
    await q.write("*CLS");
    return (await q.query("*IDN?")).trim() || idnRaw.trim();
  }

  private fill(t: string, n: number | null, v?: string): string {
    const src = String(this.s.values.get("trigger.edge.source") ?? "C1") || "C1";
    const type = String(this.s.values.get("trigger.mode") ?? "EDGE") || "EDGE";
    let out = t.replaceAll("<n>", String(n ?? 1)).replaceAll("{src}", src).replaceAll("{type}", type);
    if (v !== undefined) out = out.replaceAll("{v}", v);
    return out;
  }

  queryOf(c: Control, n: number | null): string {
    if (!c.q) throw new HttpError(400, `${c.label} cannot be read on this instrument`);
    return this.fill(c.q, n);
  }

  setOf(c: Control, n: number | null, v: Value): string {
    if (!c.w) throw new HttpError(400, `${c.label} cannot be set on this instrument`);
    let text: string;
    if (c.kind === "bool") text = v ? "ON" : "OFF";
    else if (c.kind === "number") text = encode(v, "number");
    else text = String(v).replace(/[\r\n;]/g, " ");
    return this.fill(c.w, n, text);
  }

  parse(c: Control, n: number | null, reply: string): Value {
    let r = reply.trim();
    if (typeof c.pick === "number") r = field(r, c.pick);
    else if (typeof c.pick === "string") r = after(r, this.fill(c.pick, n));
    return siglentValue(c.kind, r, c.options?.map((o) => o.value));
  }

  /** *ESR? (cleared by reading): command, execution, device and query errors since the last read. */
  async errors(): Promise<InstrumentError[]> {
    const esr = siglentNumber(await this.s.scpi.query("*ESR?")) ?? 0;
    return esrErrors(esr);
  }

  /** TRMD? for the mode; INR? bit 0 ("new signal acquired", cleared by reading) for whether it triggered. */
  async status(): Promise<string> {
    const q = this.s.scpi;
    const mode = (await q.query("TRMD?")).trim().toUpperCase();
    if (mode.startsWith("STOP")) return "STOP";
    if (mode.startsWith("AUTO") || mode.startsWith("NORM")) this.runMode = mode.startsWith("AUTO") ? "AUTO" : "NORM";
    const inr = siglentNumber(await q.query("INR?")) ?? 0;
    if (inr & 1) return "TD";
    return mode.startsWith("AUTO") ? "AUTO" : "WAIT";
  }

  async action(c: Control, _n: number | null): Promise<void> {
    const q = this.s.scpi;
    if (c.id === "root.run") return q.write(`TRMD ${this.runMode}`);
    if (c.id === "root.stop" || c.id === "root.single") {
      const m = (await q.query("TRMD?")).trim().toUpperCase();
      if (m.startsWith("AUTO") || m.startsWith("NORM")) this.runMode = m.startsWith("AUTO") ? "AUTO" : "NORM";
    }
    const cmd = SIGLENT_ACTIONS[c.id];
    if (!cmd) throw new HttpError(400, `${c.label} is not offered on this instrument`);
    await q.write(cmd);
  }

  visibleSources(): string[] {
    const out: string[] = [];
    for (let n = 1; n <= 4; n++) if (this.s.values.get(key("channel.display", n)) === true) out.push(`CHANnel${n}`);
    return out;
  }

  invalidate(): void {
    this.wfsuSent = null;
    this.scales = null;
  }

  /** WFSU (it applies to every trace) unless it is what was last sent. */
  private async wfsu(args: string): Promise<void> {
    if (this.wfsuSent === args) return;
    await this.s.scpi.write(`WFSU ${args}`);
    this.wfsuSent = args;
  }

  private async num(cmd: string): Promise<number> {
    const v = siglentNumber(await this.s.scpi.query(cmd));
    if (v === null) throw new HttpError(502, `the instrument's answer to ${cmd} is not a number`);
    return v;
  }

  /**
   * Timebase, delay, sample rate and each channel's V/div and offset. Read
   * again after any setting changed (written here, seen by the watch, typed in
   * the console) or after C.loops.preamble_max_age_ms, so a knob turned at the
   * instrument shows within that time.
   */
  private async scaleOf(chs: number[], force = false): Promise<{ t: Omit<SiglentScale, "vdiv" | "ofst">; ch: Map<number, { vdiv: number; ofst: number }> }> {
    const c = this.scales;
    const fresh = !force && c && c.gen === this.s.settingsGen && Date.now() - c.at < C.loops.preamble_max_age_ms && chs.every((n) => c.ch.has(n));
    if (fresh) return c;
    const t = { tdiv: await this.num("TDIV?"), trdl: await this.num("TRDL?"), sara: await this.num("SARA?") };
    const ch = new Map<number, { vdiv: number; ofst: number }>();
    for (const n of chs) ch.set(n, { vdiv: await this.num(`C${n}:VDIV?`), ofst: await this.num(`C${n}:OFST?`) });
    this.scales = { t, ch, gen: this.s.settingsGen, at: Date.now() };
    return this.scales;
  }

  /** Points in the whole record: sample rate × the 14 divisions. */
  private static total(t: { tdiv: number; sara: number }): number {
    return Math.max(1, Math.round(t.sara * t.tdiv * S.divisions_x));
  }

  /** A screen record of channel n: every Nth point, about C.siglent.screen_points of them. */
  private async record(n: number, t: Omit<SiglentScale, "vdiv" | "ofst">, sc: { vdiv: number; ofst: number }): Promise<Record1> {
    const total = SiglentDriver.total(t);
    const sp = Math.max(1, Math.ceil(total / S.screen_points));
    await this.wfsu(`SP,${sp},NP,0,FP,0`);
    let codes = siglentCodes(await this.s.scpi.queryBlock(`C${n}:WF? DAT2`, C.instrument.block_timeout_ms));
    // Honoured: about total / sp points, sp apart. Ignored: every point; thin it here.
    let step = codes.length <= Math.ceil(total / sp) + 1 ? sp : 1;
    if (step === 1 && sp > 1 && codes.length > 2 * S.screen_points) {
      if (!this.sparseIgnored) log(`siglent: WFSU SP,${sp} ignored (${codes.length} points came for ${Math.ceil(total / sp)}); thinning on this side`);
      this.sparseIgnored = true;
      const k = Math.ceil(codes.length / S.screen_points);
      codes = Int8Array.from({ length: Math.floor(codes.length / k) }, (_, i) => codes[i * k]);
      step = k;
    }
    const full = { ...t, ...sc };
    const pre = { ...preambleFor(full, codes.length, step / t.sara, siglentT0(t, S.divisions_x), 0), mode: step > 1 ? ("NORM" as const) : ("RAW" as const) };
    return { volts: siglentVolts(codes, sc, S.codes_per_div), pre };
  }

  async frame(srcs: string[]): Promise<Map<string, Record1>> {
    const out = new Map<string, Record1>();
    const chs = srcs.map(chOf);
    const { t, ch } = await this.scaleOf(chs);
    for (const [i, src] of srcs.entries()) out.set(src, await this.record(chs[i], t, ch.get(chs[i])!));
    // The screen centre is not a setting here: it is minus the trigger delay.
    const centre = -t.trdl;
    const was = this.s.values.get("timebase.offset");
    if (typeof was !== "number" || Math.abs(was - centre) > t.tdiv * 1e-3) this.s.setComputed("timebase.offset", centre);
    return out;
  }

  async readTrace(src: string): Promise<Record1> {
    const n = chOf(src);
    const { t, ch } = await this.scaleOf([n], true);
    return this.record(n, t, ch.get(n)!);
  }

  /** SCDP: a raw BMP of the screen, turned into PNG (smaller, and every browser shows it). */
  async screenshot(): Promise<Uint8Array> {
    const bmp = await this.s.scpi.queryBmp("SCDP", C.instrument.block_timeout_ms);
    try {
      const img = decodeBmp(bmp);
      const r = new Raster(img.w, img.h, [0, 0, 0]);
      r.px.set(img.rgb);
      return r.png();
    } catch {
      return bmp;
    }
  }

  /** PNSU?: the instrument's setup as an XML file in a block. */
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
    chOf(slot.src1);
    // PARAMETER_VALUE? measures on demand: nothing to set up on the instrument.
  }

  async measurementsChanged(): Promise<void> {
    /* nothing is set up on the instrument */
  }

  async readMeasurement(slot: Slot): Promise<number | null> {
    return parseSiglentPava(await this.s.scpi.query(`C${chOf(slot.src1)}:PAVA? ${slot.item}`)).value;
  }

  /** Deep-memory scale: read once at the start, for every chunk. */
  private deep: { t: Omit<SiglentScale, "vdiv" | "ofst">; ch: Map<number, { vdiv: number; ofst: number }> } | null = null;

  async deepBegin(): Promise<{ total: number }> {
    const q = this.s.scpi;
    await q.write("STOP");
    await q.query("*OPC?", 10000).catch(() => "");
    const chs = this.visibleSources().map(chOf);
    this.deep = await this.scaleOf(chs.length ? chs : [1], true);
    return { total: SiglentDriver.total(this.deep.t) };
  }

  async deepChunk(src: string, start: number, count: number): Promise<DeepChunk> {
    const n = chOf(src);
    if (!this.deep || !this.deep.ch.has(n)) this.deep = await this.scaleOf([...(this.deep?.ch.keys() ?? []), n], true);
    await this.wfsu(`SP,0,NP,${count},FP,${start}`);
    const block = await this.s.scpi.queryBlock(`C${n}:WF? DAT2`, C.instrument.block_timeout_ms);
    if (!block.length) throw new HttpError(502, `the scope returned no data for CH${n} points ${start}–${start + count - 1}`);
    const codes = siglentCodes(block);
    const u = new Uint16Array(codes.length);
    for (let i = 0; i < codes.length; i++) u[i] = codes[i] + 32768;
    const { t, ch } = this.deep;
    // The deep store keeps the first chunk's preamble (start 0): its origin is the record's first point.
    return { pre: preambleFor({ ...t, ...ch.get(n)! }, codes.length, 1 / t.sara, siglentT0(t, S.divisions_x, start), 32768), codes: u, bytes: block.length };
  }

  async deepEnd(resume: boolean, wasRunning: boolean): Promise<void> {
    this.deep = null;
    await this.wfsu("SP,0,NP,0,FP,0").catch(() => {});
    if (resume && wasRunning) await this.s.scpi.write(`TRMD ${this.runMode}`).catch(() => {});
  }

  bmpCommand(cmd: string): boolean {
    return /^(SCDP|SCREEN_DUMP)$/i.test(cmd.trim());
  }

  slowQuery(cmd: string): boolean {
    return /WF\?|SCDP|PNSU\?/i.test(cmd);
  }
}
