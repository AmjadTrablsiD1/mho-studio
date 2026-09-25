// A simulated MHO984: the command set comes from the same registry the app
// uses (every one of the guide's settable values can be set and read back),
// and the acquisition, waveform transfer, measurements, counter, voltmeter,
// generator, bus table and screenshot are modelled on the bench in bench.ts.
//
// What it does NOT model is listed in sim/README.md and in the app's
// Instrument view; it exists so the app can be built and tested with no scope.

import { C } from "../core/src/constants.ts";
import { CONTROLS, key, type Control } from "../core/src/registry/controls.ts";
import { compile, match, shortForm, splitMessage, type Compiled } from "../core/src/scpi/header.ts";
import { matchOption, numericOption, parseBool } from "../core/src/scpi/values.ts";
import { parseBlockArg } from "../core/src/scpi/block.ts";
import { formatPreamble, type Preamble } from "../core/src/wave/decode.ts";
import { offsetLimit, scaleLimits, snap125, channelMode } from "../core/src/wave/steps.ts";
import { measureAll, delay, Stats } from "../core/src/dsp/measure.ts";
import { spectrum, dbv } from "../core/src/dsp/spectrum.ts";
import { awgSource, clockSource, gauss, sampleSource, throughDut, uartFrames, uartSource, type Awg, type Source } from "./bench.ts";
import { Raster, hex } from "./png.ts";
import themes from "../shared/themes.json" with { type: "json" };

type V = number | string | boolean;
export type Out = string | Uint8Array;

const enc = new TextEncoder();
const sci = (x: number) => {
  const s = x.toExponential(6).toUpperCase();
  return s.replace(/E([+-])(\d)$/, "E$10$2");
};

export class SimScope {
  private values = new Map<string, V>();
  private multi = new Map<string, string>();
  private errors: { code: number; message: string }[] = [];
  private generic: { c: Control; m: Compiled }[] = CONTROLS.map((c) => ({ c, m: compile(c.header) }));
  running = true;
  private singleArmed = false;
  private acq = { seed: 1, t0: 0, triggered: false, readSince: new Set<string>(), at: 0 };
  private stats = new Map<string, Stats>();
  private srcCache: { key: string; ch: Source[] } | null = null;
  private clock = clockSource();
  private uart = uartSource();
  /** Every command received, for tests that want to know what the app sent. */
  log: string[] = [];

  constructor() {
    this.reset();
  }

  // ----------------------------------------------------------------- state

  reset(): void {
    this.values.clear();
    this.multi.clear();
    for (const c of CONTROLS) {
      if (c.kind === "action" || c.kind === "readonly") continue;
      const d = c.def ?? (c.kind === "bool" ? false : c.kind === "number" ? 0 : c.kind === "enum" ? c.options?.[0]?.value ?? "" : "");
      const dv = c.kind === "enum" ? (matchOption(String(d), c.options?.map((o) => o.value) ?? []) ?? c.options?.[0]?.value ?? String(d)) : d;
      for (const k of c.suffix ? c.suffix.values.map((n) => key(c.id, n)) : [c.id]) this.values.set(k, dv as V);
    }
    // The bench's power-on state: generator 1 into CH1 and through the filter into CH2.
    const bench: Record<string, V> = {
      "channel.display@1": true, "channel.display@2": true, "channel.display@3": false, "channel.display@4": false,
      "channel.scale@1": 0.5, "channel.scale@2": 0.5, "channel.scale@3": 1, "channel.scale@4": 1,
      "channel.offset@1": 1, "channel.offset@2": -1, "channel.offset@3": -1.6, "channel.offset@4": -1.6,
      "timebase.scale": 1e-4, "timebase.offset": 0, "acquire.mdepth": "AUTO",
      "source.output.state@1": true, "source.function@1": "SINusoid", "source.frequency@1": 5000,
      "source.voltage.amplitude@1": 2, "source.voltage.offset@1": 0, "source.frequency@2": 1000, "source.voltage.amplitude@2": 1,
      "trigger.mode": "EDGE", "trigger.sweep": "AUTO", "trigger.edge.source": "CHANnel1", "trigger.edge.slope": "POSitive", "trigger.edge.level": 0,
      "system.language": "ENGLish",
      "measure.setup.max": 90, "measure.setup.mid": 50, "measure.setup.min": 10, "measure.threshold.type": "PERCent",
      "waveform.source": "CHANnel1", "waveform.mode": "NORMal", "waveform.format": "BYTE", "waveform.start": 1, "waveform.stop": 1000, "waveform.points": 1000,
    };
    for (const [k, v] of Object.entries(bench)) this.values.set(k, v);
    for (let n = 1; n <= 4; n++) this.values.set(key("math.scale", n), 1);
    this.running = true;
    this.singleArmed = false;
    this.stats.clear();
    this.errors = [];
    this.srcCache = null;
  }

  private g(k: string): V {
    return this.values.get(k) ?? 0;
  }
  private num(k: string): number {
    return Number(this.g(k));
  }
  private on(k: string): boolean {
    return this.g(k) === true;
  }
  private err(code: number, message: string): void {
    if (this.errors.length < 32) this.errors.push({ code, message });
  }

  // ------------------------------------------------------------ the bench

  /** The bench's sources, rebuilt only after a generator setting changes (see write()). */
  private sources(): Source[] {
    if (this.srcCache) return this.srcCache.ch;
    const awg = (n: number): Awg => ({
      on: this.on(key("source.output.state", n)),
      fn: String(this.g(key("source.function", n))),
      freq: this.num(key("source.frequency", n)) || 1000,
      amp: this.num(key("source.voltage.amplitude", n)),
      offset: this.num(key("source.voltage.offset", n)),
      duty: this.num(key("source.function.square.duty", n)) || 50,
      symmetry: this.num(key("source.function.ramp.symmetry", n)) || 50,
    });
    const a = awgSource(awg(1));
    this.srcCache = { key: "", ch: [a, throughDut(a), this.clock, this.uart] };
    return this.srcCache.ch;
  }

  /** The signal at the probe tip of CH n at absolute time t, before noise and coupling. */
  private raw(n: number, t: number): number {
    return sampleSource(this.sources()[n - 1], t);
  }

  /** What the channel shows: coupling and inversion applied. */
  private shown(n: number, t: number): number {
    const coup = String(this.g(key("channel.coupling", n))).toUpperCase();
    if (coup.startsWith("GND")) return 0;
    let v = this.raw(n, t);
    if (coup.startsWith("AC")) v -= this.sources()[n - 1].mean;
    return this.on(key("channel.invert", n)) ? -v : v;
  }

  private noiseSigma(n: number): number {
    const type = String(this.g("acquire.type")).toUpperCase();
    let s = C.sim.noise_vrms * Math.max(1, this.num(key("channel.scale", n)) / 0.1) ** 0.5;
    if (type.startsWith("AVER")) s /= Math.sqrt(this.num("acquire.averages") || 2);
    if (type.startsWith("HRES")) s /= 4;
    if (String(this.g(key("channel.bwlimit", n))).toUpperCase() === "20M") s /= 5;
    const fn = String(this.g(key("source.function", 1))).toUpperCase();
    if (fn.startsWith("NOIS") && n <= 2 && this.on(key("source.output.state", 1))) s += this.num(key("source.voltage.amplitude", 1)) / 6;
    return s;
  }

  // ---------------------------------------------------------- acquisition

  private enabledChannels(): number {
    let k = 0;
    for (let n = 1; n <= 4; n++) if (this.on(key("channel.display", n))) k++;
    return Math.max(1, k);
  }

  /** Sample rate and memory the instrument would choose (datasheet p. 11). */
  timing(): { fs: number; points: number } {
    const mode = channelMode(this.enabledChannels());
    const maxRate = C.instrument.max_sample_rate[mode];
    const opt = C.sim.options.includes("RLU-05");
    const maxMem = (opt ? C.instrument.max_memory_pts_option : C.instrument.max_memory_pts)[mode];
    const window = 10 * this.num("timebase.scale");
    const md = String(this.g("acquire.mdepth"));
    const want = md.toUpperCase() === "AUTO" ? Math.min(maxMem, 1e6) : Math.min(maxMem, numericOption(md) ?? 1e4);
    const fs = Math.min(maxRate, want / window);
    // The rate steps like a real one: a 1-2-5 value no higher than the ideal.
    const e = Math.floor(Math.log10(fs));
    const m = fs / 10 ** e;
    const fsq = (m >= 5 ? 5 : m >= 2 ? 2 : m >= 1 ? 1 : 1) * 10 ** e;
    return { fs: fsq, points: Math.max(1000, Math.round(fsq * window)) };
  }

  private triggerSource(): { n: number; level: number; slope: string } | null {
    const mode = String(this.g("trigger.mode")).toUpperCase();
    const sub = ({ PULS: "pulse", SLOP: "slope", RUNT: "runt", WIND: "windows", TIM: "timeout", NEDG: "nedge", DUR: "duration" } as Record<string, string>)[shortForm(mode)] ?? "edge";
    const src = String(this.g(`trigger.${sub}.source`) || this.g("trigger.edge.source"));
    const m = /^CHAN(?:nel)?(\d)$/i.exec(src);
    if (!m) return null;
    const level = this.values.has(`trigger.${sub}.level`) ? this.num(`trigger.${sub}.level`) : this.num("trigger.edge.level");
    const slope = String(this.g("trigger.edge.slope")).toUpperCase();
    return { n: Number(m[1]), level, slope: sub === "edge" ? slope : "POSITIVE" };
  }

  /** Phases (0..1) within one period where the shown signal crosses the level in the right direction. */
  private crossingPhases(n: number, level: number, slope: string): number[] {
    const src = this.sources()[n - 1];
    const P = src.period;
    const steps = 4096;
    const out: number[] = [];
    let prev = this.shown(n, 0);
    for (let i = 1; i <= steps; i++) {
      const v = this.shown(n, (i / steps) * P);
      const up = prev < level && v >= level;
      const down = prev > level && v <= level;
      if ((up && !slope.startsWith("NEG")) || (down && (slope.startsWith("NEG") || slope.startsWith("RFAL")))) {
        const f = v === prev ? 0 : (level - prev) / (v - prev);
        out.push((i - 1 + f) / steps);
      }
      prev = v;
    }
    return out;
  }

  /** A new acquisition: a new trigger instant (or none), a new noise seed. */
  private newAcquisition(): void {
    this.acq.seed = (this.acq.seed * 1103515245 + 12345) & 0x7fffffff;
    this.acq.readSince.clear();
    this.acq.at = Date.now();
    const trig = this.triggerSource();
    const T = Math.random() * 1000;
    let t0: number | null = null;
    if (trig) {
      const P = this.sources()[trig.n - 1].period;
      const ph = this.crossingPhases(trig.n, trig.level, trig.slope);
      if (ph.length) {
        const k = Math.floor(T / P) + 1;
        t0 = (k + ph[Math.floor(Math.random() * ph.length)]) * P;
      }
    }
    const sweep = String(this.g("trigger.sweep")).toUpperCase();
    if (t0 === null) {
      this.acq.triggered = false;
      if (sweep.startsWith("AUTO")) this.acq.t0 = T; // free-running: the picture rolls
      // NORMal / SINGle: nothing new to show; keep the last record
    } else {
      this.acq.triggered = true;
      this.acq.t0 = t0;
      if (this.singleArmed || sweep.startsWith("SING")) {
        this.singleArmed = false;
        this.running = false;
      }
    }
  }

  /** Called when a source is about to be read: a new acquisition once every source of the last one has been read. */
  private maybeAcquire(source: string): void {
    if (!this.running) return;
    if (this.acq.readSince.has(source) || Date.now() - this.acq.at > 200) this.newAcquisition();
    this.acq.readSince.add(source);
  }

  triggerStatus(): string {
    if (!this.running) return "STOP";
    if (this.acq.triggered) return "TD";
    return String(this.g("trigger.sweep")).toUpperCase().startsWith("AUTO") ? "AUTO" : "WAIT";
  }

  /** Volts for CH n (1-4) or MATH n (5-8), at trigger-relative times tRel + i·dt. */
  private record(src: string, tRel: number, dt: number, count: number, first = 0, stream = 0): Float32Array {
    const ch = /^CHAN(?:nel)?(\d)$/i.exec(src);
    const out = new Float32Array(count);
    if (ch) {
      const n = Number(ch[1]);
      const sigma = this.noiseSigma(n);
      for (let i = 0; i < count; i++) {
        out[i] = this.shown(n, this.acq.t0 + tRel + (first + i) * dt) + sigma * gauss(this.acq.seed, n + stream, first + i);
      }
      return out;
    }
    const m = /^MATH(\d)$/i.exec(src);
    if (m) return this.math(Number(m[1]), tRel, dt, count, first, stream);
    return out;
  }

  private math(n: number, tRel: number, dt: number, count: number, first: number, stream: number): Float32Array {
    const op = shortForm(String(this.g(key("math.operator", n))));
    const s1 = String(this.g(key("math.source1", n)));
    const s2 = String(this.g(key("math.source2", n)));
    const a = /^MATH/i.test(s1) ? new Float32Array(count) : this.record(s1, tRel, dt, count, first, stream);
    const b = /^MATH/i.test(s2) ? new Float32Array(count) : this.record(s2, tRel, dt, count, first, stream);
    const out = new Float32Array(count);
    let acc = 0;
    for (let i = 0; i < count; i++) {
      const x = a[i];
      const y = b[i];
      switch (op) {
        case "ADD": out[i] = x + y; break;
        case "SUBT": out[i] = x - y; break;
        case "MULT": out[i] = x * y; break;
        case "DIV": out[i] = Math.abs(y) < 1e-6 ? 0 : x / y; break;
        case "ABS": out[i] = Math.abs(x); break;
        case "SQRT": out[i] = Math.sqrt(Math.max(0, x)); break;
        case "LG": out[i] = Math.log10(Math.max(1e-9, Math.abs(x))); break;
        case "LN": out[i] = Math.log(Math.max(1e-9, Math.abs(x))); break;
        case "EXP": out[i] = Math.exp(Math.min(20, x)); break;
        case "INTG": acc += x * dt; out[i] = acc; break;
        case "DIFF": out[i] = i ? (x - a[i - 1]) / dt : 0; break;
        default: out[i] = x; // logic, filters and aX+b are not modelled: they pass source A through
      }
    }
    return out;
  }

  // ------------------------------------------------------------- waveform

  private preamble(): { p: Preamble; count: number; first: number } {
    const src = String(this.g("waveform.source"));
    const mode = shortForm(String(this.g("waveform.mode")));
    const fmt = shortForm(String(this.g("waveform.format")));
    const scale = this.num("timebase.scale");
    const toff = this.num("timebase.offset");
    const isMath = /^MATH/i.test(src);
    const raw = !isMath && (mode === "RAW" || (mode === "MAX" && !this.running));
    const { fs, points } = this.timing();
    const total = raw ? points : C.instrument.normal_points;
    const start = Math.max(1, Math.min(total, Math.round(this.num("waveform.start")) || 1));
    const stop = Math.max(start, Math.min(total, Math.round(this.num("waveform.stop")) || total));
    const xinc = raw ? 1 / fs : (10 * scale) / C.instrument.normal_points;
    const chn = /(\d)$/.exec(src)?.[1] ?? "1";
    const vscale = isMath ? this.num(key("math.scale", Number(chn))) || 1 : this.num(key("channel.scale", Number(chn)));
    const voff = isMath ? this.num(key("math.offset", Number(chn))) : this.num(key("channel.offset", Number(chn)));
    const word = fmt === "WORD";
    const yinc = word ? vscale / 7500 : vscale / 25;
    const p: Preamble = {
      format: word ? "WORD" : fmt === "ASC" ? "ASC" : "BYTE",
      mode: raw ? "RAW" : mode === "MAX" ? "MAX" : "NORM",
      points: stop - start + 1,
      count: shortForm(String(this.g("acquire.type"))) === "AVER" ? this.num("acquire.averages") : 1,
      xinc,
      xorigin: toff - 5 * scale + (start - 1) * xinc,
      xref: 0,
      yinc,
      yorigin: Math.round(voff / yinc),
      yref: word ? 32768 : 128,
    };
    return { p, count: stop - start + 1, first: start - 1 };
  }

  private waveformData(): Uint8Array {
    const src = String(this.g("waveform.source"));
    const { p, count, first } = this.preamble();
    if (p.mode === "RAW" && this.running) {
      this.err(-221, "Settings conflict; RAW data can only be read in STOP");
      return new Uint8Array(0);
    }
    if (count > 10_000_000) {
      this.err(-222, "Data out of range; read deep memory in chunks");
      return new Uint8Array(0);
    }
    this.maybeAcquire(src);
    const isMath = /^MATH/i.test(src);
    const ch = Number(/(\d)$/.exec(src)?.[1] ?? 1);
    const isFft = isMath && shortForm(String(this.g(key("math.operator", ch)))) === "FFT";
    const x0 = this.num("timebase.offset") - 5 * this.num("timebase.scale");
    const v = isFft ? this.fftTrace(ch) : this.record(src, x0, p.xinc, count, first, p.mode === "RAW" ? 0 : 10);
    // quantise like a 12-bit converter across 10 divisions, then clip to the converter's range
    const vscale = p.yinc * (p.format === "WORD" ? 7500 : 25);
    const lsb = (10 * vscale) / 4096;
    if (p.format === "ASC") return enc.encode(Array.from(v, (x) => sci(Math.round(x / lsb) * lsb)).join(","));
    const k = p.yorigin + p.yref;
    if (p.format === "WORD") {
      const out = new Uint8Array(count * 2);
      for (let i = 0; i < count; i++) {
        const q = Math.round(v[i] / lsb) * lsb;
        const c = Math.max(0, Math.min(65535, Math.round(q / p.yinc + k)));
        out[2 * i] = c & 0xff;
        out[2 * i + 1] = c >> 8;
      }
      return out;
    }
    const out = new Uint8Array(count);
    for (let i = 0; i < count; i++) out[i] = Math.max(0, Math.min(255, Math.round(v[i] / p.yinc + k)));
    return out;
  }

  /** Math FFT: dBV across the configured span, drawn as 1000 display points. */
  private fftTrace(n: number): Float32Array {
    const scale = this.num("timebase.scale");
    const N = 16384;
    const dt = (10 * scale) / N;
    const src = String(this.g(key("math.fft.source", n)) || "CHANnel1");
    const rec = this.record(src, this.num("timebase.offset") - 5 * scale, dt, N, 0, 30);
    const s = spectrum(rec, dt, "hann");
    const f0 = this.num(key("math.fft.frequency.start", n));
    const f1 = this.num(key("math.fft.frequency.end", n)) || 1 / (2 * dt);
    const out = new Float32Array(1000);
    for (let i = 0; i < 1000; i++) {
      const hz = f0 + ((f1 - f0) * i) / 999;
      const b = Math.min(s.vrms.length - 1, Math.round(hz / s.df));
      out[i] = dbv(s.vrms[b]);
    }
    return out;
  }

  // ---------------------------------------------------------- measurements

  private measureRecord(src: string): { v: Float32Array; dt: number } {
    const scale = this.num("timebase.scale");
    const n = 10000;
    const dt = (10 * scale) / n;
    this.maybeAcquire(`measure:${src}`);
    return { v: this.record(src, this.num("timebase.offset") - 5 * scale, dt, n, 0, 20), dt };
  }

  private measure(item: string, s1: string, s2?: string): number | null {
    const it = item.toUpperCase();
    const dual = /^(RR|RF|FR|FF)(DEL|PH)/.exec(it);
    if (dual) {
      const a = this.measureRecord(s1);
      const b = this.measureRecord(s2 || "CHANnel2");
      const d = delay(a.v, b.v, a.dt, dual[1][0] as "R" | "F", dual[1][1] as "R" | "F");
      if (d === null) return null;
      if (dual[2] === "DEL") return d;
      const per = measureAll(a.v, a.dt).PERiod;
      return per ? (d / per) * 360 : null;
    }
    const { v, dt } = this.measureRecord(s1);
    const all = measureAll(v, dt);
    const name = Object.keys(all).find((k) => k.toUpperCase() === it || shortForm(k) === it);
    if (!name) return it === "MPAREA" || it === "MPAR" ? (all.PVRMs ?? null) : null;
    const x = all[name];
    if (name === "TVMAX" || name === "TVMIN") return x === null ? null : x + this.num("timebase.offset") - 5 * this.num("timebase.scale");
    return x;
  }

  private itemArgs(args: string): { item: string; s1: string; s2?: string } {
    const [item, s1, s2] = args.split(",").map((s) => s.trim());
    return { item, s1: s1 || String(this.g("measure.source")) || "CHANnel1", s2 };
  }

  // ---------------------------------------------------------- screenshot

  screenshot(): Uint8Array {
    const t = themes.midnight;
    const W = 1024;
    const H = 600;
    const r = new Raster(W, H, hex(t.screen));
    const x0 = 12;
    const y0 = 40;
    const gw = 1000;
    const gh = 520;
    const grid = hex(t["grid-major"]);
    for (let i = 0; i <= 10; i++) r.vline(x0 + (i * gw) / 10, y0, y0 + gh, grid, i % 5 === 0 ? 0.9 : 0.5);
    for (let j = 0; j <= 8; j++) r.hline(y0 + (j * gh) / 8, x0, x0 + gw, grid, j % 4 === 0 ? 0.9 : 0.5);
    r.hline(20, 0, W - 1, hex(t.line));
    const colors = [t.ch1, t.ch2, t.ch3, t.ch4];
    const scale = this.num("timebase.scale");
    for (let n = 1; n <= 4; n++) {
      if (!this.on(key("channel.display", n))) continue;
      const v = this.record(`CHANnel${n}`, this.num("timebase.offset") - 5 * scale, (10 * scale) / 1000, 1000, 0, 40);
      const vs = this.num(key("channel.scale", n));
      const off = this.num(key("channel.offset", n));
      const ys = Array.from(v, (x) => y0 + gh / 2 - ((x + off) / vs) * (gh / 8));
      r.trace(ys.map((y) => Math.max(y0, Math.min(y0 + gh, y))), x0, gw, hex(colors[n - 1]));
    }
    return r.png();
  }

  // --------------------------------------------------------- bus decoding

  private busTable(n: number): string {
    const mode = shortForm(String(this.g(key("bus.mode", n))));
    const fmt = shortForm(String(this.g(key("bus.format", n))));
    if (mode !== "RS232") return `${mode}\nTime,Data,\n`;
    const scale = this.num("timebase.scale");
    const x0 = this.num("timebase.offset") - 5 * scale;
    const rows = uartFrames(this.acq.t0 + x0, this.acq.t0 + x0 + 10 * scale).map(({ t, byte }) => {
      const rel = t - this.acq.t0;
      const val = fmt === "ASC" ? (byte >= 32 && byte < 127 ? String.fromCharCode(byte) : `\\x${byte.toString(16).padStart(2, "0")}`) : fmt === "DEC" ? String(byte) : fmt === "BIN" ? byte.toString(2).padStart(8, "0") : byte.toString(16).toUpperCase().padStart(2, "0");
      return `${sci(rel)},${val},`;
    });
    return `RS232\nTime,TX,\n${rows.join("\n")}\n`;
  }

  // --------------------------------------------------------------- dispatch

  /** Handle one program message; return the replies to queries, in order. */
  exec(message: string): Out[] {
    this.log.push(message.length > 200 ? `${message.slice(0, 200)}…` : message);
    if (this.log.length > 2000) this.log.splice(0, 1000);
    const out: Out[] = [];
    for (const u of splitMessage(message)) {
      try {
        const r = this.unit(u.header, u.args, u.query);
        if (u.query) out.push(r ?? "");
      } catch (e) {
        this.err(-200, (e as Error).message);
        if (u.query) out.push("");
      }
    }
    return out;
  }

  private special(h: string, args: string, q: boolean): Out | undefined | null {
    const H = h.toUpperCase();
    const is = (re: RegExp) => re.test(H);
    // --- common
    if (H === "*IDN") return `${C.instrument.vendor},${C.instrument.model},${C.sim.idn_serial},${C.sim.idn_firmware}`;
    if (H === "*OPC") return q ? "1" : null;
    if (H === "*RST") return this.reset(), null;
    if (H === "*CLS") return (this.errors = []), null;
    if (H === "*ESR" || H === "*STB" || H === "*TST") return q ? "0" : null;
    if (H === "*WAI" || H === "*ESE" || H === "*SRE") return q ? "0" : null;
    // --- run control
    if (is(/^:RUN$/)) return (this.running = true), (this.singleArmed = false), null;
    if (is(/^:STOP$/)) return (this.running = false), null;
    if (is(/^:SING(LE)?$/)) return (this.running = true), (this.singleArmed = true), this.newAcquisition(), null;
    if (is(/^:TFOR(CE)?$/)) {
      if (this.running) {
        this.acq.triggered = true;
        if (this.singleArmed) (this.singleArmed = false), (this.running = false);
      }
      return null;
    }
    if (is(/^:CLE(AR)?$/)) return null;
    if (is(/^:AUT(OSET)?$/)) return this.autoset(), null;
    // --- status and readings
    if (is(/^:TRIG(GER)?:STAT(US)?$/)) return this.triggerStatus();
    if (is(/^:TRIG(GER)?:POS(ITION)?$/)) return sci(0);
    if (is(/^:ACQ(UIRE)?:SRAT(E)?$/)) return sci(this.timing().fs);
    if (is(/^:SYST(EM)?:ERR(OR)?(:NEXT)?$/)) {
      const e = this.errors.shift();
      return e ? `${e.code},"${e.message}"` : '0,"No error"';
    }
    if (is(/^:SYST(EM)?:VERS(ION)?$/)) return "1999.0";
    if (is(/^:SYST(EM)?:RAM(OUNT)?$/)) return "4";
    if (is(/^:SYST(EM)?:GAM(OUNT)?$/)) return "10";
    if (is(/^:SYST(EM)?:MOD(ULES)?$/)) return "0,1,0,0,0";
    if (is(/^:SYST(EM)?:DGST(ATUS)?$/)) return C.sim.options.some((o) => o.startsWith("AFG")) ? "1" : "0";
    if (is(/^:SYST(EM)?:OPT(ION)?:(STAT(US)?|VAL(ID)?)$/)) {
      const want = args.trim().toUpperCase();
      return C.sim.options.some((o) => o.toUpperCase() === want) ? "1" : "0";
    }
    if (is(/^:SYST(EM)?:DATE$/)) return q ? this.multi.get("date") ?? "2026,9,25" : (this.multi.set("date", args), null);
    if (is(/^:SYST(EM)?:TIME$/)) return q ? this.multi.get("time") ?? "12,0,0" : (this.multi.set("time", args), null);
    if (is(/^:SYST(EM)?:SET(UP)?$/)) {
      if (q) return enc.encode(JSON.stringify(Object.fromEntries(this.values)));
      const b = parseBlockArg(args);
      if (b) {
        const o = JSON.parse(new TextDecoder().decode(b)) as Record<string, V>;
        for (const [k, v] of Object.entries(o)) this.values.set(k, v);
        this.srcCache = null;
      }
      return null;
    }
    if (is(/^:LAN:/)) {
      if (is(/MAC/)) return "00:19:AF:00:00:01";
      if (is(/STAT/)) return "CONFIGURED";
      if (is(/VISA/)) return "TCPIP::127.0.0.1::INSTR";
      if (is(/IPAD/)) return "127.0.0.1";
      if (is(/SMAS/)) return "255.0.0.0";
      if (is(/GAT/)) return "0.0.0.0";
      return q ? "0" : null;
    }
    if (is(/^:COUN(TER)?:CURR(ENT)?$/)) {
      if (!this.on("counter.enable")) return sci(9.9e37);
      const src = String(this.g("counter.source"));
      const { v, dt } = this.measureRecord(src);
      const f = measureAll(v, dt).FREQuency;
      const mode = shortForm(String(this.g("counter.mode")));
      const x = f === null || f === undefined ? 9.9e37 : mode === "PER" ? 1 / f : f;
      return sci(x);
    }
    if (is(/^:DVM:CURR(ENT)?$/)) {
      if (!this.on("dvm.enable")) return sci(9.9e37);
      const { v, dt } = this.measureRecord(String(this.g("dvm.source")));
      const m = measureAll(v, dt);
      const mode = shortForm(String(this.g("dvm.mode")));
      return sci((mode === "DC" ? m.VAVG : mode === "DCRM" ? m.VRMS : m.ACRMs) ?? 9.9e37);
    }
    // --- measurements
    if (is(/^:MEAS(URE)?:ITEM$/)) {
      const a = this.itemArgs(args);
      if (!q) return this.multi.set(`meas:${a.item}:${a.s1}:${a.s2 ?? ""}`.toUpperCase(), "1"), null;
      const x = this.measure(a.item, a.s1, a.s2);
      const k = `${a.item},${a.s1},${a.s2 ?? ""}`.toUpperCase();
      if (!this.stats.has(k)) this.stats.set(k, new Stats());
      this.stats.get(k)!.add(x);
      return sci(x ?? 9.9e37);
    }
    if (is(/^:MEAS(URE)?:STAT(ISTIC)?:ITEM$/)) {
      if (!q) return null;
      const [type, item, s1, s2] = args.split(",").map((s) => s.trim());
      const k = `${item},${s1 || "CHANNEL1"},${s2 ?? ""}`.toUpperCase();
      const s = this.stats.get(k)?.snapshot();
      if (!s) return sci(9.9e37);
      const T = type.toUpperCase();
      const x = T.startsWith("MAX") ? s.max : T.startsWith("MIN") ? s.min : T.startsWith("AVER") ? s.mean : T.startsWith("DEV") ? s.std : T === "CNT" ? s.n : s.last;
      return sci(x ?? 9.9e37);
    }
    if (is(/^:MEAS(URE)?:STAT(ISTIC)?:RES(ET)?$/)) return this.stats.clear(), null;
    if (is(/^:MEAS(URE)?:DEL(ETE)?$/)) {
      for (const k of [...this.multi.keys()]) if (k.startsWith("MEAS:")) this.multi.delete(k);
      return null;
    }
    // --- waveform transfer
    if (is(/^:WAV(EFORM)?:DATA$/)) return this.waveformData();
    if (is(/^:WAV(EFORM)?:PRE(AMBLE)?$/)) {
      this.maybeAcquireIfFresh();
      return formatPreamble(this.preamble().p);
    }
    const pre = /^:WAV(?:EFORM)?:(XINC|XOR|XREF|YINC|YOR|YREF)/.exec(H);
    if (pre) {
      const p = this.preamble().p;
      const m: Record<string, number> = { XINC: p.xinc, XOR: p.xorigin, XREF: p.xref, YINC: p.yinc, YOR: p.yorigin, YREF: p.yref };
      return pre[1].startsWith("Y") && pre[1] !== "YINC" ? String(m[pre[1]]) : sci(m[pre[1]]);
    }
    // --- images and tables
    if (is(/^:DISP(LAY)?:DATA$/) || is(/^:SAVE:IMAG(E)?:DATA$/)) return this.screenshot();
    const bus = /^:BUS(\d?):DATA$/.exec(H);
    if (bus) return enc.encode(this.busTable(Number(bus[1] || 1)));
    // --- multi-argument settings kept verbatim
    const la = /^:LA:DIG(?:ITAL)?:(ENAB(?:LE)?|LAB(?:EL)?)$/.exec(H);
    if (la) {
      const [d, v] = args.split(",").map((s) => s.trim());
      const k = `la:${la[1].slice(0, 3)}:${d.toUpperCase()}`;
      if (q) return this.multi.get(k) ?? (la[1].startsWith("ENAB") ? "0" : d.toUpperCase());
      this.multi.set(k, la[1].startsWith("ENAB") ? (parseBool(v) ? "1" : "0") : v);
      return null;
    }
    if (is(/^:REF(ERENCE)?:/) && args.includes(",")) {
      const [ref, ...rest] = args.split(",");
      if (q) return this.multi.get(`${H}:${ref}`) ?? "0";
      this.multi.set(`${H}:${ref}`, rest.join(","));
      return null;
    }
    if (is(/^:MASK:(FAIL|PASS|TOT)/)) return "0";
    if (is(/^:SEAR(CH)?:COUN(T)?$/)) return "0";
    return undefined;
  }

  private maybeAcquireIfFresh(): void {
    const src = String(this.g("waveform.source"));
    if (this.running && (this.acq.readSince.has(src) || Date.now() - this.acq.at > 200)) {
      this.newAcquisition();
    }
  }

  private unit(header: string, args: string, q: boolean): Out | null {
    const s = this.special(header, args, q);
    if (s !== undefined) return s;
    for (const { c, m } of this.generic) {
      const sfx = match(m, header);
      if (!sfx) continue;
      const n = c.suffix ? sfx[c.suffix.name] ?? 1 : null;
      if (c.suffix && n !== null && !c.suffix.values.includes(n)) {
        this.err(-114, "Header suffix out of range");
        return q ? "" : null;
      }
      const k = key(c.id, n);
      if (q) {
        if (!c.query) {
          this.err(-113, "Undefined header; this command has no query form");
          return "";
        }
        return this.reply(c, this.values.get(k));
      }
      if (!c.set) {
        this.err(-113, "Undefined header; this command is query-only");
        return null;
      }
      if (c.kind === "action") return null;
      this.write(c, n, k, args);
      return null;
    }
    this.err(-113, `Undefined header; command cannot be found (${header})`);
    return q ? "" : null;
  }

  private reply(c: Control, v: V | undefined): string {
    if (v === undefined) return c.kind === "number" ? sci(0) : "0";
    if (c.kind === "bool") return v ? "1" : "0";
    if (c.kind === "number") return sci(Number(v));
    if (c.kind === "enum") {
      if (c.id === "acquire.mdepth") return String(v).toUpperCase() === "AUTO" ? "AUTO" : sci(numericOption(String(v)) ?? 0);
      if (c.id === "acquire.averages") return String(v);
      return shortForm(String(v));
    }
    return String(v);
  }

  private write(c: Control, n: number | null, k: string, args: string): void {
    const a = args.trim();
    if (c.group === "source") this.srcCache = null;
    if (c.kind === "bool") {
      const b = parseBool(a);
      if (b === null) return this.err(-224, "Illegal parameter value");
      this.values.set(k, b);
      return;
    }
    if (c.kind === "enum") {
      const o = matchOption(a, c.options?.map((x) => x.value) ?? []);
      if (o === null) {
        // Averages accept any integer and round down to a power of two.
        if (c.id === "acquire.averages" && Number(a) >= 2) {
          const p = 2 ** Math.floor(Math.log2(Math.min(65536, Number(a))));
          this.values.set(k, String(p));
          return;
        }
        return this.err(-224, "Illegal parameter value");
      }
      this.values.set(k, o);
      return;
    }
    if (c.kind === "number") {
      let x = Number(a);
      if (!Number.isFinite(x)) x = numericOption(a) ?? NaN;
      if (!Number.isFinite(x)) return this.err(-224, "Illegal parameter value");
      x = this.coerce(c, n, x);
      this.values.set(k, x);
      if (c.id === "channel.scale" || c.id === "channel.impedance") this.clampOffset(n ?? 1);
      return;
    }
    this.values.set(k, a);
  }

  /** The instrument's own limits and snapping, so the app's read-back logic is exercised. */
  private coerce(c: Control, n: number | null, x: number): number {
    let lo = c.min ?? -Infinity;
    let hi = c.max ?? Infinity;
    if (c.id === "channel.scale") {
      const [a, b] = scaleLimits(String(this.g(key("channel.impedance", n ?? 1))), this.num(key("channel.probe", n ?? 1)) || 1);
      lo = a;
      hi = b;
    }
    if (c.id === "channel.offset" || c.id === "channel.position") {
      const lim = offsetLimit(this.num(key("channel.scale", n ?? 1)), String(this.g(key("channel.impedance", n ?? 1))), this.num(key("channel.probe", n ?? 1)) || 1);
      lo = -lim;
      hi = lim;
    }
    if (c.id === "trigger.edge.level") {
      const src = /(\d)$/.exec(String(this.g("trigger.edge.source")))?.[1];
      if (src) {
        const s = this.num(key("channel.scale", Number(src)));
        const off = this.num(key("channel.offset", Number(src)));
        lo = -5 * s - off;
        hi = 5 * s - off;
      }
    }
    if (x < lo || x > hi) {
      this.err(-222, "Data out of range");
      x = Math.min(hi, Math.max(lo, x));
    }
    if (c.id === "channel.scale" && !this.on(key("channel.vernier", n ?? 1))) x = snap125(x);
    if (c.id === "timebase.scale" && !this.on("timebase.vernier")) x = snap125(x);
    return x;
  }

  private clampOffset(n: number): void {
    const k = key("channel.offset", n);
    const lim = offsetLimit(this.num(key("channel.scale", n)), String(this.g(key("channel.impedance", n))), this.num(key("channel.probe", n)) || 1);
    const v = this.num(k);
    if (Math.abs(v) > lim) this.values.set(k, Math.sign(v) * lim);
  }

  /** Autoset on the bench: fit each displayed channel to ~6 divisions and show ~3 periods of the trigger source. */
  private autoset(): void {
    for (let n = 1; n <= 4; n++) {
      const src = this.sources()[n - 1];
      let lo = Infinity;
      let hi = -Infinity;
      for (const x of src.table) {
        lo = Math.min(lo, x);
        hi = Math.max(hi, x);
      }
      const vpp = hi - lo;
      if (vpp < 1e-3) continue;
      this.values.set(key("channel.display", n), true);
      const s = snap125(vpp / 6);
      this.values.set(key("channel.scale", n), s);
      this.values.set(key("channel.offset", n), -(hi + lo) / 2);
    }
    const trig = this.triggerSource();
    if (trig) {
      const src = this.sources()[trig.n - 1];
      this.values.set("timebase.scale", snap125((3 * src.period) / 10));
      this.values.set("timebase.offset", 0);
      let lo = Infinity;
      let hi = -Infinity;
      for (const x of src.table) {
        lo = Math.min(lo, x);
        hi = Math.max(hi, x);
      }
      this.values.set("trigger.edge.level", (hi + lo) / 2);
    }
    this.running = true;
  }
}
