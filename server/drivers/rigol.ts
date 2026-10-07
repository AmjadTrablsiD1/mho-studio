// RIGOL MHO900 (the MHO984): SCPI as the MHO900 programming guide writes it,
// raw over TCP port 5555 or over USB-TMC. This is the app's original
// behaviour, moved here unchanged when LeCroy support arrived.

import { C } from "../../core/src/constants.ts";
import { key, type Control } from "../../core/src/registry/controls.ts";
import { registryFor } from "../../core/src/registry/families.ts";
import type { Slot } from "../../core/src/registry/measurements.ts";
import { render } from "../../core/src/scpi/header.ts";
import { encode, matchOption, parseBool, parseError, parseNumber, type Value } from "../../core/src/scpi/values.ts";
import { codes, detectWordOrder, parsePreamble, type Preamble } from "../../core/src/wave/decode.ts";
import type { ScopeService } from "../scope.ts";
import { HttpError } from "../errors.ts";
import type { DeepChunk, Driver, InstrumentError, Record1 } from "./types.ts";

const itemArgs = (s: Slot) => `${s.item},${s.src1}${s.src2 ? `,${s.src2}` : ""}`;

export class RigolDriver implements Driver {
  readonly reg = registryFor("rigol");
  private s: ScopeService;
  private deepSrc: string | null = null;
  private deepPre: Preamble | null = null;

  constructor(s: ScopeService) {
    this.s = s;
  }

  async init(idnRaw: string): Promise<string> {
    const q = this.s.scpi;
    await q.write("*CLS");
    this.s.options = {};
    for (const o of C.instrument.options) {
      const r = await q.query(`:SYSTem:OPTion:STATus? ${o}`).catch(() => "0");
      this.s.options[o] = parseBool(r) === true;
    }
    return idnRaw.trim();
  }

  private sfx(c: Control, n: number | null) {
    return c.suffix ? { [c.suffix.name]: n ?? 1 } : {};
  }

  queryOf(c: Control, n: number | null): string {
    return `${render(c.header, this.sfx(c, n))}?`;
  }

  setOf(c: Control, n: number | null, v: Value): string {
    return `${render(c.header, this.sfx(c, n))} ${encode(v, c.kind as "number" | "enum" | "bool" | "string")}`;
  }

  parse(c: Control, _n: number | null, reply: string): Value {
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

  async errors(): Promise<InstrumentError[]> {
    const errs: InstrumentError[] = [];
    for (let i = 0; i < 8; i++) {
      const e = parseError(await this.s.scpi.query(":SYSTem:ERRor?"));
      if (e.code === 0) break;
      errs.push(e);
    }
    return errs;
  }

  async status(): Promise<string> {
    return (await this.s.scpi.query(":TRIGger:STATus?")).trim();
  }

  async action(c: Control, n: number | null): Promise<void> {
    await this.s.scpi.write(render(c.header, this.sfx(c, n)));
  }

  visibleSources(): string[] {
    const v = this.s.values;
    const out: string[] = [];
    for (let n = 1; n <= C.instrument.analog_channels; n++) if (v.get(key("channel.display", n)) === true) out.push(`CHANnel${n}`);
    for (let n = 1; n <= C.instrument.math_channels; n++) if (v.get(key("math.display", n)) === true) out.push(`MATH${n}`);
    return out;
  }

  /** One screen of every visible source (NORMal mode, 1000 points). */
  async frame(srcs: string[]): Promise<Map<string, Record1>> {
    const q = this.s.scpi;
    const out = new Map<string, Record1>();
    await q.write(`:WAVeform:MODE NORMal`);
    await q.write(`:WAVeform:FORMat ${C.wire.prefer_word_format ? "WORD" : "BYTE"}`);
    for (const src of srcs) {
      await q.write(`:WAVeform:SOURce ${src}`);
      const pre = parsePreamble(await q.query(":WAVeform:PREamble?"));
      const data = await q.queryBlock(":WAVeform:DATA?", C.instrument.query_timeout_ms * 2);
      out.set(src, { volts: this.s.decode(data, pre), pre });
    }
    return out;
  }

  async readTrace(src: string): Promise<Record1> {
    const q = this.s.scpi;
    await q.write(`:WAVeform:SOURce ${src}`);
    await q.write(`:WAVeform:MODE NORMal`);
    await q.write(`:WAVeform:FORMat ${C.wire.prefer_word_format ? "WORD" : "BYTE"}`);
    const pre = parsePreamble(await q.query(":WAVeform:PREamble?"));
    return { volts: this.s.decode(await q.queryBlock(":WAVeform:DATA?"), pre), pre };
  }

  screenshot(): Promise<Uint8Array> {
    return this.s.scpi.queryBlock(":DISPlay:DATA? PNG");
  }

  setupBlob(): Promise<Uint8Array> {
    return this.s.scpi.queryBlock(":SYSTem:SETup?");
  }

  async restoreSetup(blob: Uint8Array): Promise<void> {
    const head = new TextEncoder().encode(`:SYSTem:SETup #9${String(blob.length).padStart(9, "0")}`);
    const msg = new Uint8Array(head.length + blob.length + 1);
    msg.set(head, 0);
    msg.set(blob, head.length);
    msg[msg.length - 1] = 0x0a;
    await this.s.scpi.writeBytes(msg, `:SYSTem:SETup #9… (${blob.length} bytes)`);
  }

  async addMeasurement(slot: Slot): Promise<void> {
    await this.s.scpi.write(`:MEASure:ITEM ${itemArgs(slot)}`);
  }

  async measurementsChanged(remaining: Slot[]): Promise<void> {
    // The guide only offers "delete all"; put the rest back.
    await this.s.scpi.write(":MEASure:DELete");
    for (const s of remaining) await this.s.scpi.write(`:MEASure:ITEM ${itemArgs(s)}`);
  }

  async readMeasurement(slot: Slot): Promise<number | null> {
    return parseNumber(await this.s.scpi.query(`:MEASure:ITEM? ${itemArgs(slot)}`));
  }

  /** Deep memory: stop and read the whole acquisition memory in RAW mode (guide §3.28). */
  async deepBegin(): Promise<{ total: number }> {
    const q = this.s.scpi;
    this.deepSrc = null;
    this.deepPre = null;
    await q.write(":STOP");
    await q.query("*OPC?", 10000).catch(() => "");
    const srate = parseNumber(await q.query(":ACQuire:SRATe?")) ?? 0;
    const scale = parseNumber(await q.query(":TIMebase:MAIN:SCALe?")) ?? 0;
    const md = parseNumber((await q.query(":ACQuire:MDEPth?")).trim());
    // The depth setting can exceed what the record holds: when the sample rate is at its
    // maximum, the screen's time span fills fewer points. Points past the record are not data.
    const filled = srate > 0 && scale > 0 ? Math.round(srate * scale * C.instrument.divisions_x) : null;
    const total = md !== null && filled !== null ? Math.min(md, filled) : (md ?? filled ?? 0);
    return { total };
  }

  async deepChunk(src: string, start: number, count: number): Promise<DeepChunk> {
    const q = this.s.scpi;
    if (src !== this.deepSrc) {
      await q.write(`:WAVeform:SOURce ${src}`);
      await q.write(":WAVeform:MODE RAW");
      await q.write(":WAVeform:FORMat WORD");
      this.deepSrc = src;
      this.deepPre = null;
    }
    await q.write(`:WAVeform:STARt ${start + 1}`);
    await q.write(`:WAVeform:STOP ${start + count}`);
    if (!this.deepPre) this.deepPre = parsePreamble(await q.query(":WAVeform:PREamble?"));
    const d = await q.queryBlock(":WAVeform:DATA?");
    if (!d.length) {
      const e = await this.errors();
      throw new HttpError(502, `the scope returned no data for ${src} points ${start + 1}–${start + count}${e.length ? `: ${e.map((x) => x.message).join("; ")}` : ""}`);
    }
    const link = this.s.link;
    const order = link.wordOrderLocked ? link.wordOrder : detectWordOrder(d).order;
    return { pre: this.deepPre, codes: codes(d, "WORD", order), bytes: d.length };
  }

  async deepEnd(resume: boolean, wasRunning: boolean): Promise<void> {
    const q = this.s.scpi;
    await q.write(":WAVeform:MODE NORMal").catch(() => {});
    await q.write(":WAVeform:STARt 1").catch(() => {});
    if (resume && wasRunning) await q.write(":RUN").catch(() => {});
    this.deepSrc = null;
  }

  slowQuery(cmd: string): boolean {
    return /DATA\?|SETup\?|IMAGe|EEXPort/i.test(cmd);
  }
}
