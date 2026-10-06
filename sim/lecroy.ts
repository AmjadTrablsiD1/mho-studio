// A simulated Teledyne LeCroy X-Stream oscilloscope: enough of the remote
// control manual's command set for the app's LeCroy driver to be built and
// tested without the instrument. It answers like the manual describes (header
// on by default, numbers with units, "MA" for mega, WAVEDESC waveforms,
// command-error register, no reply to a query it does not know).
//
// The bench behind it (numbers in shared/constants.json → lecroy.sim):
//   CH1  10 MHz sine, 0.8 Vpp          CH2  1 MHz 3.3 V clock with ringing
//   CH3  100 kHz square, 1 Vpp         CH4  UART burst, as on the RIGOL bench
// It stands in for an unknown 40 GS/s model; see sim/README.md for what it
// does not model.

import { C } from "../core/src/constants.ts";
import { buildLecroyWave } from "../core/src/scpi/lecroy.ts";
import { makeBlock, parseBlockArg } from "../core/src/scpi/block.ts";
import { measureAll } from "../core/src/dsp/measure.ts";
import { LECROY_CONTROLS } from "../core/src/registry/lecroy.ts";
import { awgSource, clockSource, gauss, sampleSource, uartSource, type Source } from "./bench.ts";
import { Raster, hex } from "./png.ts";
import themes from "../shared/themes.json" with { type: "json" };

export type Out = string | Uint8Array;
const S = C.lecroy.sim;
const enc = new TextEncoder();

/** LeCroy-style number with a unit: 0.05 → "50.0E-3 V". */
export function lnum(x: number, unit = ""): string {
  if (x === 0) return `0${unit ? ` ${unit}` : ""}`;
  const e = Math.floor(Math.log10(Math.abs(x)) / 3) * 3;
  const m = x / 10 ** e;
  return `${Number(m.toPrecision(4))}E${e}${unit ? ` ${unit}` : ""}`;
}

/** Memory sizes the way MSIZ? answers: 2500 → "2.5K", 1e7 → "10MA". */
export function lsize(n: number): string {
  if (n >= 1e6) return `${Number((n / 1e6).toPrecision(4))}MA`;
  if (n >= 1e3) return `${Number((n / 1e3).toPrecision(4))}K`;
  return String(n);
}

type V = string | number | boolean;
type Ch = { tra: boolean; vdiv: number; ofst: number; cpl: string; attn: number; bwl: string; invert: boolean; avg: number };

export class LecroySim {
  private ch: Ch[] = [];
  private tdiv = 1e-7;
  private trdl = 0;
  private msiz: number = S.default_memory_pts;
  private trmd = "AUTO";
  private trsrc = "C1";
  private trlv = new Map<string, number>();
  private trsl = new Map<string, string>();
  private trcp = new Map<string, string>();
  private chdr = "SHORT";
  private cord = "HI";
  private wfsu = { sp: 0, np: 0, fp: 0, sn: 0 };
  private cmr = 0;
  private exr = 0;
  private inr = 0;
  private acq = { seed: 1, t0: 0, at: 0, read: new Set<number>() };
  private running = true;
  private sources: Source[];
  /** Every message received, for tests. */
  log: string[] = [];

  constructor() {
    this.sources = [
      awgSource({ on: true, fn: "SIN", freq: S.ch1_sine_hz, amp: S.ch1_vpp, offset: 0, duty: 50, symmetry: 50 }),
      clockSource(),
      awgSource({ on: true, fn: "SQU", freq: S.ch3_square_hz, amp: S.ch3_vpp, offset: 0, duty: 50, symmetry: 50 }),
      uartSource(),
    ];
    this.reset();
  }

  reset(): void {
    this.ch = [1, 2, 3, 4].map((n) => ({ tra: n <= 2, vdiv: n === 2 ? 1 : 0.1, ofst: n === 2 ? -1.65 : 0, cpl: "D1M", attn: 1, bwl: "OFF", invert: false, avg: 1 }));
    this.tdiv = 1e-7;
    this.trdl = 0;
    this.msiz = S.default_memory_pts;
    this.trmd = "AUTO";
    this.trsrc = "C1";
    this.trlv = new Map([["C1", 0], ["C2", 1.65], ["C3", 0], ["C4", 1.65]]);
    this.trsl = new Map([["C1", "POS"], ["C2", "POS"], ["C3", "POS"], ["C4", "NEG"]]);
    this.trcp = new Map([["C1", "DC"], ["C2", "DC"], ["C3", "DC"], ["C4", "DC"]]);
    this.running = true;
    this.resetProps();
  }

  // -------------------------------------------------------------- acquisition

  /** Sample rate and points: as fast as memory allows, up to the maximum rate. */
  timing(): { fs: number; points: number; dt: number } {
    const span = 10 * this.tdiv;
    const fs = Math.min(S.max_sample_rate, this.msiz / span);
    const points = Math.max(2, Math.round(fs * span));
    return { fs, points, dt: span / points };
  }

  private shown(n: number, t: number): number {
    const c = this.ch[n - 1];
    if (c.cpl === "GND") return 0;
    const src = this.sources[n - 1];
    let v = sampleSource(src, t);
    if (c.cpl === "A1M") v -= src.mean;
    return c.invert ? -v : v;
  }

  private newAcquisition(): void {
    this.acq.seed = (this.acq.seed * 1103515245 + 12345) & 0x7fffffff;
    this.acq.at = Date.now();
    this.acq.read.clear();
    const T = Math.random() * 1000;
    const m = /^C(\d)$/.exec(this.trsrc);
    let t0 = T;
    if (m) {
      const n = Number(m[1]);
      const P = this.sources[n - 1].period;
      const level = this.trlv.get(this.trsrc) ?? 0;
      const neg = this.trsl.get(this.trsrc) === "NEG";
      // Search one period after T for a crossing in the right direction.
      const steps = 4096;
      let prev = this.shown(n, T);
      for (let i = 1; i <= steps; i++) {
        const t = T + (i / steps) * P;
        const v = this.shown(n, t);
        if (neg ? prev > level && v <= level : prev < level && v >= level) {
          t0 = t;
          break;
        }
        prev = v;
      }
    }
    this.acq.t0 = t0;
    this.inr |= 1;
    if (this.trmd === "SINGLE") {
      this.trmd = "STOP";
      this.running = false;
    }
  }

  private maybeAcquire(n: number): void {
    if (!this.running) return;
    if (this.acq.read.has(n) || Date.now() - this.acq.at > 200) this.newAcquisition();
    this.acq.read.add(n);
  }

  /** Points [first, first + count·sp) step sp of channel n, as 16-bit codes (8-bit ADC × 256). */
  private codes(n: number, first: number, count: number, sp: number): Int16Array {
    const { dt } = this.timing();
    const c = this.ch[n - 1];
    const left = -5 * this.tdiv - this.trdl;
    const out = new Int16Array(count);
    const perDiv = S.codes_per_div / 256;
    for (let k = 0; k < count; k++) {
      const i = first + k * sp;
      const t = left + i * dt;
      const v = this.shown(n, this.acq.t0 + t) + S.noise_vrms * gauss(this.acq.seed, n, i);
      const code8 = Math.max(-127, Math.min(127, Math.round(((v + c.ofst) / c.vdiv) * perDiv)));
      out[k] = code8 * 256;
    }
    return out;
  }

  /** WF? for C n: the descriptor and (unless DESC) the data, as WFSU says. */
  private waveform(n: number, what: string): Uint8Array {
    this.maybeAcquire(n);
    const { points, dt } = this.timing();
    const sp = Math.max(1, this.wfsu.sp);
    const fp = Math.min(points - 1, Math.max(0, this.wfsu.fp));
    let count = Math.floor((points - 1 - fp) / sp) + 1;
    if (this.wfsu.np > 0) count = Math.min(count, this.wfsu.np);
    const c = this.ch[n - 1];
    const gain = c.vdiv / S.codes_per_div;
    const left = -5 * this.tdiv - this.trdl;
    const order = this.cord === "LO" ? "little" : "big";
    const codes = this.codes(n, fp, what === "DESC" ? 0 : count, sp);
    const wave = buildLecroyWave({ codes, gain, offset: c.ofst, interval: dt * sp, horizOffset: left + fp * dt, source: n - 1, instrument: "LECROYWM8ZI-A", order, firstPoint: fp, sparsing: sp });
    if (what === "DESC") {
      // A descriptor alone still states how many points a full read would bring.
      const dv = new DataView(wave.buffer);
      dv.setInt32(116, count, order === "little");
      dv.setInt32(60, 0, order === "little");
      return wave.subarray(0, 346);
    }
    return wave;
  }

  private measure(n: number, item: string): string {
    this.maybeAcquire(n);
    const { points, dt } = this.timing();
    const step = Math.max(1, Math.floor(points / 20000));
    const codes = this.codes(n, 0, Math.floor(points / step), step);
    const c = this.ch[n - 1];
    const gain = c.vdiv / S.codes_per_div;
    const v = Float32Array.from(codes, (x) => gain * x - c.ofst);
    const m = measureAll(v, dt * step);
    const map: Record<string, [string, string]> = {
      MAX: ["VMAX", "V"], MIN: ["VMIN", "V"], PKPK: ["VPP", "V"], TOP: ["VTOP", "V"], BASE: ["VBASe", "V"], AMPL: ["VAMP", "V"],
      MEAN: ["VAVG", "V"], RMS: ["VRMS", "V"], SDEV: ["ACRMs", "V"], OVSP: ["OVERshoot", "%"], OVSN: ["PREShoot", "%"], AREA: ["MARea", "V.S"],
      PER: ["PERiod", "S"], FREQ: ["FREQuency", "HZ"], RISE: ["RTIMe", "S"], FALL: ["FTIMe", "S"], PWID: ["PWIDth", "S"], NWID: ["NWIDth", "S"], DUTY: ["PDUTy", "%"],
    };
    const k = map[item];
    if (!k) return `${item},UNDEF,IV`;
    const x = m[k[0]];
    return x === null || x === undefined || !Number.isFinite(x) ? `${item},UNDEF,NP` : `${item},${lnum(x, k[1])},OK`;
  }

  private screenshot(): Uint8Array {
    const t = themes.midnight;
    const W = 1024;
    const H = 640;
    const r = new Raster(W, H, [0, 0, 0]);
    const x0 = 12, y0 = 60, gw = 1000, gh = 520;
    const grid = hex(t["grid-major"]);
    for (let i = 0; i <= 10; i++) r.vline(x0 + (i * gw) / 10, y0, y0 + gh, grid, i % 5 === 0 ? 0.9 : 0.4);
    for (let j = 0; j <= 8; j++) r.hline(y0 + (j * gh) / 8, x0, x0 + gw, grid, j % 4 === 0 ? 0.9 : 0.4);
    const colors = [[255, 230, 0], [255, 60, 180], [0, 200, 255], [60, 220, 60]] as [number, number, number][];
    for (let n = 1; n <= 4; n++) {
      const c = this.ch[n - 1];
      if (!c.tra) continue;
      const { points } = this.timing();
      const sp = Math.max(1, Math.floor(points / 1000));
      const codes = this.codes(n, 0, Math.min(1000, Math.floor(points / sp)), sp);
      const ys = Array.from(codes, (x) => y0 + gh / 2 - (x / S.codes_per_div) * (gh / 8));
      r.trace(ys.map((y) => Math.max(y0, Math.min(y0 + gh, y))), x0, gw, colors[n - 1]);
    }
    return r.png();
  }

  private panel(): string {
    const lines = ["' simulated LeCroy panel setup"];
    this.ch.forEach((c, i) => lines.push(`C${i + 1}:TRA ${c.tra ? "ON" : "OFF"};C${i + 1}:VDIV ${c.vdiv};C${i + 1}:OFST ${c.ofst};C${i + 1}:CPL ${c.cpl};C${i + 1}:ATTN ${c.attn}`));
    lines.push(`TDIV ${this.tdiv};TRDL ${this.trdl};MSIZ ${this.msiz};TRSE EDGE,SR,${this.trsrc}`);
    for (const [k, v] of this.props) lines.push(`VBS 'app.${this.propSpec.get(k)?.path ?? k} = ${typeof v === "string" ? `"${v}"` : typeof v === "boolean" ? (v ? "True" : "False") : v}'`);
    return lines.join("\n");
  }

  // ---------------------------------------------------------------- commands

  /** One program message (may hold several commands separated by ';'). Returns the replies; null where a query got none. */
  exec(message: string): Out[] {
    this.log.push(message.length > 200 ? `${message.slice(0, 200)}…` : message);
    if (this.log.length > 2000) this.log.splice(0, 1000);
    const m = message.trim();
    if (/^(PNSU|PANEL_SETUP)\s+#/i.test(m)) {
      const block = parseBlockArg(m.slice(m.indexOf("#")));
      if (block) this.restorePanel(new TextDecoder("latin1").decode(block));
      else this.cmr = 10;
      return [];
    }
    const out: Out[] = [];
    for (const part of splitCommands(m)) {
      const r = this.one(part.trim());
      if (r !== undefined && r !== null) out.push(r);
    }
    return out;
  }

  private restorePanel(text: string): void {
    for (const line of text.split("\n")) if (!line.startsWith("'")) for (const p of splitCommands(line)) this.one(p.trim());
  }

  private head(h: string, v: string): string {
    return this.chdr === "OFF" ? v : `${h} ${v}`;
  }

  /** One command: undefined for a command, a reply for a query, null for a query with no answer. */
  private one(cmd: string): Out | null | undefined {
    if (!cmd) return undefined;
    const q = /^[^\s]*\?/.test(cmd) || /^VBS\?/i.test(cmd);
    const sp = cmd.search(/\s/);
    const header = (sp < 0 ? cmd : cmd.slice(0, sp)).replace("?", "").toUpperCase();
    const args = sp < 0 ? "" : cmd.slice(sp + 1).trim();
    const chm = /^C([1-4]):(.+)$/.exec(header);
    const n = chm ? Number(chm[1]) : 0;
    const h = chm ? chm[2] : header;
    const c = n ? this.ch[n - 1] : null;
    const num = () => Number.parseFloat(args);
    const unknown = () => {
      this.cmr = 1;
      return q ? null : undefined;
    };

    if (c) {
      switch (h) {
        case "TRA": case "TRACE":
          if (q) return this.head(`C${n}:TRA`, c.tra ? "ON" : "OFF");
          c.tra = /^ON/i.test(args);
          return undefined;
        case "VDIV": case "VOLT_DIV":
          if (q) return this.head(`C${n}:VDIV`, lnum(c.vdiv, "V"));
          if (!Number.isFinite(num())) return void (this.cmr = 3);
          c.vdiv = Math.min(10, Math.max(0.002, num()));
          return undefined;
        case "OFST": case "OFFSET":
          if (q) return this.head(`C${n}:OFST`, lnum(c.ofst, "V"));
          c.ofst = Math.max(-c.vdiv * 50, Math.min(c.vdiv * 50, num()));
          return undefined;
        case "CPL": case "COUPLING":
          if (q) return this.head(`C${n}:CPL`, c.cpl);
          if (!/^(A1M|D1M|D50|GND)$/i.test(args)) return void (this.cmr = 5);
          c.cpl = args.toUpperCase();
          return undefined;
        case "ATTN": case "ATTENUATION":
          if (q) return this.head(`C${n}:ATTN`, String(c.attn));
          c.attn = num();
          return undefined;
        case "TRLV": case "TRIG_LEVEL":
          if (q) return this.head(`C${n}:TRLV`, lnum(this.trlv.get(`C${n}`) ?? 0, "V"));
          this.trlv.set(`C${n}`, num());
          return undefined;
        case "TRSL": case "TRIG_SLOPE":
          if (q) return this.head(`C${n}:TRSL`, this.trsl.get(`C${n}`) ?? "POS");
          if (!/^(POS|NEG)$/i.test(args)) return void (this.cmr = 5);
          this.trsl.set(`C${n}`, args.toUpperCase());
          return undefined;
        case "TRCP": case "TRIG_COUPLING":
          if (q) return this.head(`C${n}:TRCP`, this.trcp.get(`C${n}`) ?? "DC");
          this.trcp.set(`C${n}`, args.toUpperCase());
          return undefined;
        case "WF": case "WAVEFORM": {
          if (!q) return unknown();
          const what = (args.split(",")[0] || "ALL").toUpperCase();
          const data = this.waveform(n, what);
          const prefix = this.chdr === "OFF" ? `${what},` : `C${n}:WF ${what},`;
          const block = makeBlock(data);
          const outb = new Uint8Array(prefix.length + block.length);
          outb.set(enc.encode(prefix), 0);
          outb.set(block, prefix.length);
          return outb;
        }
        case "PAVA": case "PARAMETER_VALUE":
          if (!q) return unknown();
          return this.head(`C${n}:PAVA`, this.measure(n, args.split(",")[0].trim().toUpperCase()));
        default:
          return unknown();
      }
    }

    switch (h) {
      case "*IDN":
        return q ? this.head("*IDN", S.idn) : unknown();
      case "*OPC":
        return q ? this.head("*OPC", "1") : undefined;
      case "*RST":
        this.reset();
        return undefined;
      case "*CLS":
        this.cmr = this.exr = this.inr = 0;
        return undefined;
      case "CHDR": case "COMM_HEADER":
        if (q) return this.head("CHDR", this.chdr);
        this.chdr = args.toUpperCase().startsWith("OFF") ? "OFF" : "SHORT";
        return undefined;
      case "CFMT": case "COMM_FORMAT":
        return q ? this.head("CFMT", "DEF9,WORD,BIN") : undefined;
      case "CORD": case "COMM_ORDER":
        if (q) return this.head("CORD", this.cord);
        this.cord = args.toUpperCase().startsWith("LO") ? "LO" : "HI";
        return undefined;
      case "CMR": {
        const r = this.cmr;
        this.cmr = 0;
        return q ? this.head("CMR", String(r)) : unknown();
      }
      case "EXR": {
        const r = this.exr;
        this.exr = 0;
        return q ? this.head("EXR", String(r)) : unknown();
      }
      case "INR": {
        const r = this.inr;
        this.inr = 0;
        return q ? this.head("INR", String(r)) : unknown();
      }
      case "TDIV": case "TIME_DIV":
        if (q) return this.head("TDIV", lnum(this.tdiv, "S"));
        this.tdiv = Math.min(1000, Math.max(2e-11, num()));
        return undefined;
      case "TRDL": case "TRIG_DELAY":
        if (q) return this.head("TRDL", lnum(this.trdl, "S"));
        this.trdl = num();
        return undefined;
      case "MSIZ": case "MEMORY_SIZE": {
        if (q) return this.head("MSIZ", lsize(this.msiz));
        const want = /MA$/i.test(args) ? num() * 1e6 : /K$/i.test(args) ? num() * 1e3 : num();
        this.msiz = S.memory_pts.reduce((best, x) => (Math.abs(x - want) < Math.abs(best - want) ? x : best), S.memory_pts[0]);
        return undefined;
      }
      case "TRMD": case "TRIG_MODE":
        if (q) return this.head("TRMD", this.trmd);
        if (!/^(AUTO|NORM|SINGLE|STOP)$/i.test(args)) return void (this.cmr = 5);
        this.trmd = args.toUpperCase();
        this.running = this.trmd !== "STOP";
        return undefined;
      case "TRSE": case "TRIG_SELECT": {
        if (q) return this.head("TRSE", `EDGE,SR,${this.trsrc},HT,OFF`);
        const p = args.split(",").map((x) => x.trim().toUpperCase());
        const i = p.indexOf("SR");
        if (i >= 0 && p[i + 1]) this.trsrc = p[i + 1];
        return undefined;
      }
      case "BWL": case "BANDWIDTH_LIMIT": {
        if (q) return this.head("BWL", this.ch.map((c, i) => `C${i + 1},${c.bwl}`).join(","));
        const p = args.split(",").map((x) => x.trim().toUpperCase());
        for (let i = 0; i + 1 < p.length; i += 2) {
          const k = /^C(\d)$/.exec(p[i]);
          if (k) this.ch[Number(k[1]) - 1].bwl = p[i + 1];
        }
        return undefined;
      }
      case "WFSU": case "WAVEFORM_SETUP": {
        if (q) return this.head("WFSU", `SP,${this.wfsu.sp},NP,${this.wfsu.np},FP,${this.wfsu.fp},SN,${this.wfsu.sn}`);
        const p = args.split(",").map((x) => x.trim().toUpperCase());
        for (let i = 0; i + 1 < p.length; i += 2) {
          const v = Number(p[i + 1]);
          if (p[i] === "SP") this.wfsu.sp = v;
          else if (p[i] === "NP") this.wfsu.np = v;
          else if (p[i] === "FP") this.wfsu.fp = v;
          else if (p[i] === "SN") this.wfsu.sn = v;
        }
        return undefined;
      }
      case "ARM": case "ARM_ACQUISITION":
        this.trmd = "SINGLE";
        this.running = true;
        return undefined;
      case "STOP":
        this.trmd = "STOP";
        this.running = false;
        return undefined;
      case "FRTR": case "FORCE_TRIGGER":
        this.newAcquisition();
        return undefined;
      case "ASET": case "AUTO_SETUP":
        for (const c of this.ch) c.ofst = 0;
        this.tdiv = 1e-7;
        return undefined;
      case "WAIT":
        return undefined;
      case "HCSU": case "HARDCOPY_SETUP":
        return q ? this.head("HCSU", "DEV,PNG,PORT,NET") : undefined;
      case "SCDP": case "SCREEN_DUMP":
        return this.screenshot();
      case "PNSU": case "PANEL_SETUP":
        if (!q) return unknown();
        return makeBlock(enc.encode(this.panel()));
      case "VBS":
        return this.vbs(args, q);
      default:
        return unknown();
    }
  }

  // ------------------------------------------------------------ automation

  /** Automation properties the app's registry uses: stored values, keyed by lower-case path ("acquisition.c1.labelstext"). */
  private props = new Map<string, V>();
  private propSpec = vbsSpecs();

  private resetProps(): void {
    this.props.clear();
    for (const [k, sp] of this.propSpec) if (sp.def !== undefined) this.props.set(k, sp.def);
  }

  /** Properties that are the simulator's own state rather than stored values. */
  private linked(path: string): { get: () => V; set?: (v: V) => boolean } | null {
    const p = path.toLowerCase();
    const ch = /^acquisition\.c(\d)\.(invert|averagesweeps|bandwidthlimit|verscale|veroffset)$/.exec(p);
    if (ch) {
      const c = this.ch[Number(ch[1]) - 1];
      if (!c) return null;
      switch (ch[2]) {
        case "invert": return { get: () => c.invert, set: (v) => ((c.invert = v === true), true) };
        case "averagesweeps": return { get: () => c.avg, set: (v) => ((c.avg = Math.max(1, Math.round(Number(v)))), true) };
        case "bandwidthlimit": return { get: () => (c.bwl === "OFF" ? "Full" : c.bwl.replace("HZ", "Hz")), set: (v) => ((c.bwl = String(v) === "Full" ? "OFF" : String(v).toUpperCase()), true) };
        case "verscale": return { get: () => c.vdiv, set: (v) => ((c.vdiv = Number(v)), true) };
        case "veroffset": return { get: () => c.ofst, set: (v) => ((c.ofst = Number(v)), true) };
      }
    }
    if (p === "acquisition.horizontal.samplingrate") return { get: () => this.timing().fs };
    if (p === "acquisition.horizontal.horoffset") return { get: () => this.trdl, set: (v) => ((this.trdl = Number(v)), true) };
    if (p === "acquisition.trigger.source") return { get: () => toAuto(this.trsrc), set: (v) => ((this.trsrc = toLegacy(String(v))), true) };
    const tc = /^acquisition\.trigger\.(c\d|ext|extdivide10)\.(level|slope)$/.exec(p);
    if (tc) {
      const src = toLegacy(tc[1].toUpperCase().replace("EXTDIVIDE10", "ExtDivide10").replace(/^EXT$/, "Ext"));
      if (tc[2] === "level") return { get: () => this.trlv.get(src) ?? 0, set: (v) => (this.trlv.set(src, Number(v)), true) };
      return { get: () => (this.trsl.get(src) === "NEG" ? "Negative" : "Positive"), set: (v) => (this.trsl.set(src, String(v) === "Negative" ? "NEG" : "POS"), true) };
    }
    return null;
  }

  /** VBS 'app.X = v' and VBS? 'return=app.X'. An unknown property or a bad value: no change, EXR set, and no reply to a query. */
  private vbs(args: string, q: boolean): Out | null | undefined {
    const s = args.trim().replace(/^'|'$/g, "");
    const get = /^return\s*=\s*app\.(.+)$/i.exec(s);
    const set = /^app\.(.+?)\s*=\s*(.+)$/i.exec(s);
    const action = /^app\.([\w.]+)$/i.exec(s);
    if (!q && action && !set) {
      const a = action[1].toLowerCase();
      if (a === "acquisition.trigger.zerolevel") this.trlv.set(this.trsrc, 0);
      else if (a === "acquisition.clearsweeps") this.acq.at = 0;
      else this.exr = 21;
      return undefined;
    }
    const path = (get?.[1] ?? set?.[1] ?? "").trim();
    const key = path.toLowerCase();
    const link = this.linked(path);
    const spec = this.propSpec.get(key);
    if (q && get) {
      if (link) return this.head("VBS", fmtV(link.get()));
      if (spec) return this.head("VBS", fmtV(this.props.get(key) ?? ""));
      this.exr = 21;
      return null;
    }
    if (!q && set && (link || spec)) {
      const raw = set[2].trim();
      const kind = spec?.kind ?? "string";
      let v: V;
      if (kind === "bool") v = /^(true|-1|1)$/i.test(raw);
      else if (kind === "number" || (!spec && /^[-+\d.]/.test(raw))) v = Number(raw);
      else v = raw.replace(/^"|"$/g, "");
      if (typeof v === "number" && !Number.isFinite(v)) return void (this.exr = 21);
      if (spec?.options && !spec.options.some((o) => o.toLowerCase() === String(v).toLowerCase())) return void (this.exr = 21);
      if (spec?.options) v = spec.options.find((o) => o.toLowerCase() === String(v).toLowerCase())!;
      if (link?.set) link.set(v);
      else if (!link) this.props.set(key, v);
      return undefined;
    }
    this.exr = 21;
    return q ? null : undefined;
  }

  get state() {
    return { running: this.running, trmd: this.trmd, tdiv: this.tdiv, ch: this.ch.map((c) => ({ ...c })), wfsu: { ...this.wfsu } };
  }
}

/** Split on ';' outside quotes (VBS strings may hold one). */
function splitCommands(m: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: string | null = null;
  for (const ch of m) {
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === "'" || ch === '"') quote = ch;
    else if (ch === ";") {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out;
}

const AUTO: Record<string, string> = { EX: "Ext", EX10: "ExtDivide10", LINE: "Line" };
const toAuto = (legacy: string) => AUTO[legacy.toUpperCase()] ?? legacy.toUpperCase();
const toLegacy = (auto: string) => Object.entries(AUTO).find(([, a]) => a.toLowerCase() === auto.toLowerCase())?.[0] ?? auto.toUpperCase();

/** How VBS hands values back: booleans as -1 / 0 (VBScript's True is -1). */
function fmtV(v: V): string {
  if (typeof v === "boolean") return v ? "-1" : "0";
  return String(v);
}

type PropSpec = { path: string; kind: string; options?: string[]; def?: V };

/** Defaults the simulated instrument starts with, for automation properties that are not its own state. */
const DEFAULTS: Record<string, V> = {
  labelstext: "", viewlabels: false, labelsposition: "0", deskew: 0, interpolatetype: "Linear",
  samplemode: "RealTime", numsegments: 10, activechannels: "Auto", smartmemory: "SetMaximumMemory",
  type: "Edge", holdofftype: "Off", holdofftime: 1e-6, holdoffevents: 1,
  width: "GreaterThan", widthrange: "Limits", widthnominal: 1e-8, widthdelta: 1e-9, glitchlow: 1e-9, glitchhigh: 1e-8, glitch: "LessThan",
  interval: "GreaterThan", intervalrange: "Limits", intervalnominal: 1e-6, intervaldelta: 1e-8, intervallow: 1e-7, intervalhigh: 1e-6,
  dropouttime: 1e-6, patterntype: "And", patternstate: "DontCare", validatesource: "C2", qualstate: "Above", qualwait: "Off", qualtime: 1e-6, qualevents: 1, qualfirst: false,
};

/** Every automation property the app's LeCroy registry reads or sets, expanded per channel. */
function vbsSpecs(): Map<string, PropSpec> {
  const out = new Map<string, PropSpec>();
  for (const c of LECROY_CONTROLS) {
    const m = /^VBS\? 'return=app\.(.+)'$/.exec(c.q ?? "");
    if (!m || m[1].includes("{src}")) continue;
    const paths = m[1].includes("<n>") ? [1, 2, 3, 4].map((n) => m[1].replace("<n>", String(n))) : [m[1]];
    for (const path of paths) {
      const leaf = path.split(".").pop()!.toLowerCase();
      out.set(path.toLowerCase(), { path, kind: c.kind, options: c.options?.map((o) => o.value), def: DEFAULTS[leaf] });
    }
  }
  return out;
}
