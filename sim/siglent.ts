// A simulated Teledyne T3DSO1204 (Siglent SDS1000X-E inside), answering the
// way the real one did on 2026-10-14 (see core/src/scpi/siglent.ts):
//   *IDN? "Lecroy,T3DSO1204 ,…"; CHDR OFF drops headers and units;
//   C<n>:WF? DAT2 → "DAT2,#9…" + signed bytes (25 per division) + "\n\n";
//   SCDP → a raw 800×480 RGB565 BMP; PNSU? → an XML file in a block;
//   PAVA → "PKPK,4.000000E-02" or "FREQ,****"; *ESR? for errors;
//   a query it does not know: no reply, command-error bit in *ESR.
// 14 horizontal divisions. Channels pair up (CH1/CH2, CH3/CH4): with both of a
// pair on, 500 MSa/s and 7 Mpts; with one, 1 GSa/s and 14 Mpts.
//
// The bench (numbers in shared/constants.json → siglent.sim):
//   CH1  1 MHz sine, 1 Vpp            CH2  the 1 MHz 3.3 V clock with ringing
//   CH3  100 kHz square, 1 Vpp        CH4  the UART burst

import { C } from "../core/src/constants.ts";
import { makeBlock, parseBlockArg } from "../core/src/scpi/block.ts";
import { buildLecroyWave } from "../core/src/scpi/lecroy.ts";
import { measureAll } from "../core/src/dsp/measure.ts";
import { encodeBmp565 } from "../core/src/img/bmp.ts";
import { awgSource, clockSource, gauss, sampleSource, uartSource, type Source } from "./bench.ts";
import { Raster } from "./png.ts";

const S = C.siglent.sim;
const DIV = C.siglent.divisions_x;
const CPD = C.siglent.codes_per_div;
const enc = new TextEncoder();

/** Siglent's number format: 3 significant digits, two-digit exponent ("5.00E-08"). */
export function sigE(x: number, digits = 2): string {
  if (!Number.isFinite(x)) return "****";
  const [m, e] = x.toExponential(digits).split("e");
  const n = Number(e);
  return `${m}E${n < 0 ? "-" : "+"}${String(Math.abs(n)).padStart(2, "0")}`;
}

/** Memory depths offered, smallest first: 7K… with both channels of a pair on, 14K… with one. */
const MEM = { pair: [7e3, 7e4, 7e5, 7e6], single: [14e3, 14e4, 14e5, 14e6] };
const memName = (n: number) => (n >= 1e6 ? `${Number((n / 1e6).toPrecision(3))}M` : `${Number((n / 1e3).toPrecision(3))}K`);

type Ch = { tra: boolean; vdiv: number; ofst: number; cpl: string; attn: number; bwl: boolean; invs: boolean; unit: string; skew: number };

export class SiglentSim {
  private ch: Ch[] = [];
  private tdiv = 2e-7;
  private trdl = 0;
  /** Memory depth as an index into the list for the current channel mode (0 = smallest). */
  private mem = 3;
  private trmd = "AUTO";
  private trtype = "EDGE";
  private trsrc = "C1";
  private trlv = new Map<string, number>();
  private trsl = new Map<string, string>();
  private trcp = new Map<string, string>();
  private chdr = "SHORT";
  private acqw = "SAMPLING";
  private avga = 16;
  private wfsu = { sp: 0, np: 0, fp: 0 };
  private esr = 0;
  private inr = 0;
  private acq = { seed: 1, t0: 0, at: 0, read: new Set<number>() };
  private running = true;
  private sources: Source[];
  /** Every message received, for tests. */
  log: string[] = [];
  /** Ignore WFSU SP (every point always comes), to test the driver's own thinning. */
  ignoreSparse: boolean;

  constructor(opts: { ignoreSparse?: boolean } = {}) {
    this.ignoreSparse = opts.ignoreSparse ?? false;
    this.sources = [
      awgSource({ on: true, fn: "SIN", freq: S.ch1_sine_hz, amp: S.ch1_vpp, offset: 0, duty: 50, symmetry: 50 }),
      clockSource(),
      awgSource({ on: true, fn: "SQU", freq: S.ch3_square_hz, amp: S.ch3_vpp, offset: 0, duty: 50, symmetry: 50 }),
      uartSource(),
    ];
    this.reset();
  }

  reset(): void {
    this.ch = [1, 2, 3, 4].map((n) => ({
      tra: n <= 2, vdiv: n === 2 || n === 4 ? 1 : 0.2, ofst: n === 2 || n === 4 ? -1.65 : 0, cpl: "D1M", attn: 10, bwl: false, invs: false, unit: "V", skew: 0,
    }));
    this.tdiv = 2e-7;
    this.trdl = 0;
    this.mem = 3;
    this.trmd = "AUTO";
    this.trtype = "EDGE";
    this.trsrc = "C1";
    this.trlv = new Map([["C1", 0], ["C2", 1.65], ["C3", 0], ["C4", 1.65]]);
    this.trsl = new Map([["C1", "POS"], ["C2", "POS"], ["C3", "POS"], ["C4", "NEG"]]);
    this.trcp = new Map([["C1", "DC"], ["C2", "DC"], ["C3", "DC"], ["C4", "DC"]]);
    this.acqw = "SAMPLING";
    this.running = true;
  }

  // -------------------------------------------------------------- acquisition

  /** Both channels of some pair on: the interleaved (halved) rate and memory. */
  private paired(): boolean {
    return (this.ch[0].tra && this.ch[1].tra) || (this.ch[2].tra && this.ch[3].tra);
  }

  private memory(): number {
    return (this.paired() ? MEM.pair : MEM.single)[this.mem];
  }

  /** Sample rate and points: as fast as memory allows over the 14 divisions, up to the maximum rate. */
  timing(): { fs: number; points: number; dt: number } {
    const span = DIV * this.tdiv;
    const fs = Math.min(S.max_sample_rate / (this.paired() ? 2 : 1), this.memory() / span);
    const points = Math.max(2, Math.round(fs * span));
    return { fs, points, dt: 1 / fs };
  }

  private shown(n: number, t: number): number {
    const c = this.ch[n - 1];
    if (c.cpl === "GND") return 0;
    const src = this.sources[n - 1];
    let v = sampleSource(src, t);
    if (c.cpl.startsWith("A")) v -= src.mean;
    return c.invs ? -v : v;
  }

  /** The first crossing of the trigger source in the trigger direction within one of its periods after `from`. */
  private findTrigger(from: number): number | null {
    const m = /^C(\d)$/.exec(this.trsrc);
    if (!m) return null;
    const n = Number(m[1]);
    const P = this.sources[n - 1].period;
    const level = this.trlv.get(this.trsrc) ?? 0;
    const slope = this.trsl.get(this.trsrc) ?? "POS";
    const steps = 4096;
    let prev = this.shown(n, from);
    for (let i = 1; i <= steps; i++) {
      const t = from + (i / steps) * P;
      const v = this.shown(n, t);
      const up = prev < level && v >= level;
      const down = prev > level && v <= level;
      if ((slope === "POS" && up) || (slope === "NEG" && down) || (slope === "WINDOW" && (up || down))) return t;
      prev = v;
    }
    return null;
  }

  /** A new acquisition when the trigger condition is met (Auto free-runs; force always acquires). */
  private newAcquisition(force = false): void {
    const T = Math.random() * 1000;
    const found = this.findTrigger(T);
    if (found === null && !force && this.trmd !== "AUTO") return;
    this.acq.seed = (this.acq.seed * 1103515245 + 12345) & 0x7fffffff;
    this.acq.at = Date.now();
    this.acq.read.clear();
    this.acq.t0 = found ?? T;
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

  /** Signed 8-bit codes of points [first, first + count·sp) step sp of channel n. */
  private codes(n: number, first: number, count: number, sp: number): Int8Array {
    const { dt } = this.timing();
    const c = this.ch[n - 1];
    const left = -this.trdl - (this.tdiv * DIV) / 2;
    const out = new Int8Array(count);
    for (let k = 0; k < count; k++) {
      const i = first + k * sp;
      const v = this.shown(n, this.acq.t0 + left + i * dt) + S.noise_vrms * gauss(this.acq.seed, n, i);
      out[k] = Math.max(-128, Math.min(127, Math.round(((v + c.ofst) / c.vdiv) * CPD)));
    }
    return out;
  }

  private dat2(n: number): Int8Array {
    this.maybeAcquire(n);
    const { points } = this.timing();
    const sp = this.ignoreSparse ? 1 : Math.max(1, this.wfsu.sp);
    const fp = Math.min(points - 1, Math.max(0, this.wfsu.fp));
    let count = Math.floor((points - 1 - fp) / sp) + 1;
    if (this.wfsu.np > 0) count = Math.min(count, this.wfsu.np);
    return this.codes(n, fp, count, sp);
  }

  private measure(n: number, item: string): string {
    this.maybeAcquire(n);
    const { points, dt } = this.timing();
    const step = Math.max(1, Math.floor(points / 20000));
    const c = this.ch[n - 1];
    const v = Float32Array.from(this.codes(n, 0, Math.floor(points / step), step), (x) => (x * c.vdiv) / CPD - c.ofst);
    const m = measureAll(v, dt * step);
    const map: Record<string, [string, string]> = {
      PKPK: ["VPP", "V"], MAX: ["VMAX", "V"], MIN: ["VMIN", "V"], AMPL: ["VAMP", "V"], TOP: ["VTOP", "V"], BASE: ["VBASe", "V"], MEAN: ["VAVG", "V"], CMEAN: ["VAVG", "V"],
      RMS: ["VRMS", "V"], CRMS: ["VRMS", "V"], STDEV: ["ACRMs", "V"], OVSP: ["OVERshoot", "%"], RPRE: ["PREShoot", "%"], PER: ["PERiod", "S"], FREQ: ["FREQuency", "Hz"],
      PWID: ["PWIDth", "S"], NWID: ["NWIDth", "S"], RISE: ["RTIMe", "S"], FALL: ["FTIMe", "S"], DUTY: ["PDUTy", "%"], NDUTY: ["NDUTy", "%"],
    };
    const k = map[item];
    const x = k ? m[k[0]] : null;
    if (x === null || x === undefined || !Number.isFinite(x)) return `${item},****`;
    return `${item},${sigE(x, 6)}${this.chdr === "OFF" ? "" : k[1]}`;
  }

  private screenshot(): Uint8Array {
    const W = 800;
    const H = 480;
    const r = new Raster(W, H, [0, 0, 0]);
    const x0 = 10, y0 = 40, gw = 700, gh = 400;
    for (let i = 0; i <= DIV; i++) r.vline(x0 + (i * gw) / DIV, y0, y0 + gh, [70, 70, 70]);
    for (let j = 0; j <= 8; j++) r.hline(y0 + (j * gh) / 8, x0, x0 + gw, [70, 70, 70]);
    const colors = [[240, 230, 40], [240, 60, 200], [40, 200, 250], [60, 220, 60]] as [number, number, number][];
    for (let n = 1; n <= 4; n++) {
      if (!this.ch[n - 1].tra) continue;
      const { points } = this.timing();
      const sp = Math.max(1, Math.floor(points / 700));
      const codes = this.codes(n, 0, Math.min(700, Math.floor(points / sp)), sp);
      r.trace(Array.from(codes, (x) => Math.max(y0, Math.min(y0 + gh, y0 + gh / 2 - (x / CPD) * (gh / 8)))), x0, gw, colors[n - 1]);
    }
    return encodeBmp565({ w: W, h: H, rgb: r.px });
  }

  /** PNSU?: the setup as XML, in the spirit of the real one (which is far longer). */
  private panel(): string {
    const chs = this.ch.map((c, i) => `    <CH${i + 1}><act>${c.tra ? 1 : 0}</act><vdiv>${c.vdiv}</vdiv><ofst>${c.ofst}</ofst><cpl>${c.cpl}</cpl><attn>${c.attn}</attn></CH${i + 1}>`);
    return `<?xml version="1.0" encoding="UTF-8"?>\n<nsp_config>\n  <ch_setup>\n${chs.join("\n")}\n  </ch_setup>\n  <time_setup><tdiv>${this.tdiv}</tdiv><trdl>${this.trdl}</trdl><mem>${this.mem}</mem></time_setup>\n  <trig_setup><src>${this.trsrc}</src><mode>${this.trmd}</mode></trig_setup>\n</nsp_config>\n`;
  }

  private restorePanel(xml: string): boolean {
    if (!/<nsp_config>/.test(xml)) return false;
    for (let n = 1; n <= 4; n++) {
      const m = new RegExp(`<CH${n}><act>(\\d)</act><vdiv>([^<]+)</vdiv><ofst>([^<]+)</ofst><cpl>([^<]+)</cpl><attn>([^<]+)</attn></CH${n}>`).exec(xml);
      if (!m) continue;
      Object.assign(this.ch[n - 1], { tra: m[1] === "1", vdiv: Number(m[2]), ofst: Number(m[3]), cpl: m[4], attn: Number(m[5]) });
    }
    const t = /<tdiv>([^<]+)<\/tdiv><trdl>([^<]+)<\/trdl><mem>(\d)<\/mem>/.exec(xml);
    if (t) [this.tdiv, this.trdl, this.mem] = [Number(t[1]), Number(t[2]), Number(t[3])];
    const g = /<src>([^<]+)<\/src><mode>([^<]+)<\/mode>/.exec(xml);
    if (g) [this.trsrc, this.trmd] = [g[1], g[2]];
    this.running = this.trmd !== "STOP";
    return true;
  }

  // ---------------------------------------------------------------- commands

  /** One program message: the bytes to send back, each complete with its terminator(s). */
  exec(message: string): Uint8Array[] {
    this.log.push(message.length > 200 ? `${message.slice(0, 200)}…` : message);
    if (this.log.length > 2000) this.log.splice(0, 1000);
    const m = message.trim();
    if (/^(PNSU|PANEL_SETUP)\s+#/i.test(m)) {
      const block = parseBlockArg(m.slice(m.indexOf("#")));
      if (!block || !this.restorePanel(new TextDecoder("latin1").decode(block))) this.esr |= 16;
      return [];
    }
    const out: Uint8Array[] = [];
    const texts: string[] = [];
    for (const part of m.split(";")) {
      const r = this.one(part.trim());
      if (typeof r === "string") texts.push(r);
      else if (r) out.push(r);
    }
    // Several queries in one message: the real one answers only part of them; here they are joined.
    if (texts.length) out.unshift(enc.encode(`${texts.join(";")}\n`));
    return out;
  }

  private head(h: string, v: string, unit = ""): string {
    return this.chdr === "OFF" ? v : `${h} ${v}${unit}`;
  }

  /** A block reply with its text header, framed as the real one: "DAT2,#9…" + data + newline(s). */
  private block(h: string, what: string, data: Uint8Array, newlines: number): Uint8Array {
    const prefix = enc.encode(this.chdr === "OFF" ? `${what},` : `${h} ${what},`);
    const b = makeBlock(data);
    const out = new Uint8Array(prefix.length + b.length - 1 + newlines);
    out.set(prefix, 0);
    out.set(b.subarray(0, b.length - 1), prefix.length);
    out.fill(0x0a, prefix.length + b.length - 1);
    return out;
  }

  /** One command: a string or bytes for a query, undefined for a command or an unanswered query. */
  private one(cmd: string): string | Uint8Array | undefined {
    if (!cmd) return undefined;
    const q = /^[^\s]*\?/.test(cmd);
    const sp = cmd.search(/\s/);
    const header = (sp < 0 ? cmd : cmd.slice(0, sp)).replace("?", "").toUpperCase();
    const args = sp < 0 ? "" : cmd.slice(sp + 1).trim();
    const chm = /^C([1-4]):(.+)$/.exec(header);
    const n = chm ? Number(chm[1]) : 0;
    const h = chm ? chm[2] : header;
    const c = n ? this.ch[n - 1] : null;
    const num = () => Number.parseFloat(args);
    const unknown = () => {
      this.esr |= 32;
      return undefined;
    };
    const bad = () => {
      this.esr |= 16;
      return undefined;
    };
    const onoff = (b: boolean) => (b ? "ON" : "OFF");
    if (c) {
      const H = `C${n}:${h}`;
      switch (h) {
        case "TRA": case "TRACE":
          if (q) return this.head(H, onoff(c.tra));
          c.tra = /^ON/i.test(args);
          return undefined;
        case "VDIV": case "VOLT_DIV":
          if (q) return this.head(H, sigE(c.vdiv), "V");
          if (!Number.isFinite(num())) return bad();
          c.vdiv = Math.min(10 * c.attn, Math.max(0.0005 * c.attn, num()));
          return undefined;
        case "OFST": case "OFFSET":
          if (q) return this.head(H, sigE(c.ofst), "V");
          if (!Number.isFinite(num())) return bad();
          c.ofst = Math.max(-c.vdiv * 50, Math.min(c.vdiv * 50, num()));
          return undefined;
        case "CPL": case "COUPLING":
          if (q) return this.head(H, c.cpl);
          if (!/^(A1M|A50|D1M|D50|GND)$/i.test(args)) return bad();
          c.cpl = args.toUpperCase();
          return undefined;
        case "ATTN": case "ATTENUATION": {
          if (q) return this.head(H, String(c.attn));
          const a = num();
          if (!(a > 0)) return bad();
          c.vdiv = (c.vdiv / c.attn) * a;
          c.ofst = (c.ofst / c.attn) * a;
          c.attn = a;
          return undefined;
        }
        case "BWL": case "BANDWIDTH_LIMIT":
          if (q) return this.head(H, onoff(c.bwl));
          c.bwl = /^ON/i.test(args);
          return undefined;
        case "INVS": case "INVERT_SET":
          if (q) return this.head(H, onoff(c.invs));
          c.invs = /^ON/i.test(args);
          return undefined;
        case "UNIT":
          if (q) return this.head(H, c.unit);
          if (!/^(V|A)$/i.test(args)) return bad();
          c.unit = args.toUpperCase();
          return undefined;
        case "SKEW":
          if (q) return this.head(H, sigE(c.skew), "S");
          c.skew = num();
          return undefined;
        case "TRLV": case "TRIG_LEVEL":
          if (q) return this.head(H, sigE(this.trlv.get(`C${n}`) ?? 0), "V");
          if (!Number.isFinite(num())) return bad();
          this.trlv.set(`C${n}`, num());
          return undefined;
        case "TRSL": case "TRIG_SLOPE":
          if (q) return this.head(H, this.trsl.get(`C${n}`) ?? "POS");
          if (!/^(POS|NEG|WINDOW)$/i.test(args)) return bad();
          this.trsl.set(`C${n}`, args.toUpperCase());
          return undefined;
        case "TRCP": case "TRIG_COUPLING":
          if (q) return this.head(H, this.trcp.get(`C${n}`) ?? "DC");
          if (!/^(AC|DC|HFREJ|LFREJ)$/i.test(args)) return bad();
          this.trcp.set(`C${n}`, args.toUpperCase());
          return undefined;
        case "WF": case "WAVEFORM": {
          if (!q) return unknown();
          const what = (args.split(",")[0] || "DAT2").toUpperCase();
          if (what === "DAT2") return this.block(`C${n}:WF`, "DAT2", new Uint8Array(this.dat2(n).buffer), 2);
          if (what === "DESC") {
            const { points, dt } = this.timing();
            const d = buildLecroyWave({ codes: new Int8Array(0), gain: c.vdiv / CPD, offset: c.ofst, interval: dt, horizOffset: 0, source: n - 1, instrument: "Siglent SDS", nominalBits: 8 });
            new DataView(d.buffer).setInt32(116, points, true);
            return this.block(`C${n}:WF`, "DESC", d.subarray(0, 346), 1);
          }
          return unknown();
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
        return q ? S.idn : unknown();
      case "*OPC":
        return q ? "1" : undefined;
      case "*RST":
        this.reset();
        return undefined;
      case "*CLS":
        this.esr = 0;
        this.inr = 0;
        return undefined;
      case "*ESR": {
        const r = this.esr;
        this.esr = 0;
        return q ? String(r) : unknown();
      }
      case "CMR": case "EXR":
        return q ? this.head(h, "0") : unknown();
      case "INR": {
        const r = this.inr;
        this.inr = 0;
        return q ? this.head("INR", String(r)) : unknown();
      }
      case "CHDR": case "COMM_HEADER":
        if (q) return this.chdr;
        this.chdr = /^OFF/i.test(args) ? "OFF" : /^LONG/i.test(args) ? "LONG" : "SHORT";
        return undefined;
      case "TDIV": case "TIME_DIV":
        if (q) return this.head("TDIV", sigE(this.tdiv), "S");
        if (!Number.isFinite(num())) return bad();
        this.tdiv = Math.min(100, Math.max(1e-9, num()));
        return undefined;
      case "TRDL": case "TRIG_DELAY":
        if (q) return this.head("TRDL", sigE(this.trdl), "S");
        if (!Number.isFinite(num())) return bad();
        this.trdl = num();
        return undefined;
      case "MSIZ": case "MEMORY_SIZE": {
        if (q) return this.head("MSIZ", memName(this.memory()));
        const want = /M$/i.test(args) ? num() * 1e6 : /K$/i.test(args) ? num() * 1e3 : num();
        const list = this.paired() ? MEM.pair : MEM.single;
        const i = list.findIndex((x) => Math.abs(x - want) < x * 0.01);
        if (i < 0) {
          // A depth of the other channel mode: the nearest of this one.
          const j = (this.paired() ? MEM.single : MEM.pair).findIndex((x) => Math.abs(x - want) < x * 0.01);
          if (j < 0) return bad();
          this.mem = j;
        } else this.mem = i;
        return undefined;
      }
      case "SARA": case "SAMPLE_RATE":
        return q ? this.head("SARA", sigE(this.timing().fs), "Sa/s") : unknown();
      case "SANU": case "SAMPLE_NUM":
        return q ? this.head("SANU", sigE(this.timing().points), "pts") : unknown();
      case "ACQW": case "ACQUIRE_WAY": {
        if (q) return this.head("ACQW", this.acqw === "AVERAGE" ? `AVERAGE,${this.avga}` : this.acqw);
        const p = args.split(",").map((x) => x.trim().toUpperCase());
        if (!["SAMPLING", "PEAK_DETECT", "AVERAGE", "HIGH_RES"].includes(p[0])) return bad();
        this.acqw = p[0];
        if (p[0] === "AVERAGE" && p[1]) this.avga = Number(p[1]);
        return undefined;
      }
      case "AVGA": case "AVERAGE_ACQUIRE":
        if (q) return this.head("AVGA", String(this.avga));
        if (![4, 16, 32, 64, 128, 256, 512, 1024].includes(num())) return bad();
        this.avga = num();
        return undefined;
      case "SAST":
        return q ? this.head("SAST", this.trmd === "STOP" ? "Stop" : this.inr & 1 ? "Trig'd" : this.trmd === "AUTO" ? "Auto" : "Ready") : unknown();
      case "TRMD": case "TRIG_MODE":
        if (q) {
          // Armed for one acquisition: a trigger arrives (the simulated signal is always there).
          if (this.trmd === "SINGLE" && this.running) this.newAcquisition();
          return this.head("TRMD", this.trmd);
        }
        if (!/^(AUTO|NORM|SINGLE|STOP)$/i.test(args)) return bad();
        this.trmd = args.toUpperCase();
        this.running = this.trmd !== "STOP";
        return undefined;
      case "TRSE": case "TRIG_SELECT": {
        if (q) return this.head("TRSE", `${this.trtype},SR,${this.trsrc},HT,OFF`);
        const p = args.split(",").map((x) => x.trim().toUpperCase());
        if (!["EDGE", "SLEW", "GLIT", "INTV", "RUNT", "DROP"].includes(p[0])) return bad();
        this.trtype = p[0];
        const i = p.indexOf("SR");
        if (i >= 0 && p[i + 1]) {
          if (!/^(C[1-4]|EX|EX5|LINE)$/.test(p[i + 1])) return bad();
          this.trsrc = p[i + 1];
        }
        return undefined;
      }
      case "WFSU": case "WAVEFORM_SETUP": {
        if (q) return this.head("WFSU", `SP,${this.wfsu.sp},NP,${this.wfsu.np},FP,${this.wfsu.fp}`);
        const p = args.split(",").map((x) => x.trim().toUpperCase());
        for (let i = 0; i + 1 < p.length; i += 2) {
          const v = Number(p[i + 1]);
          if (p[i] === "SP") this.wfsu.sp = v;
          else if (p[i] === "NP") this.wfsu.np = v;
          else if (p[i] === "FP") this.wfsu.fp = v;
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
        this.newAcquisition(true);
        return undefined;
      case "ASET": case "AUTO_SETUP":
        for (const c of this.ch) c.ofst = 0;
        this.tdiv = 2e-7;
        return undefined;
      case "SCDP": case "SCREEN_DUMP": {
        const bmp = this.screenshot();
        const out = new Uint8Array(bmp.length + 1);
        out.set(bmp, 0);
        out[bmp.length] = 0x0a;
        return out;
      }
      case "PNSU": case "PANEL_SETUP":
        if (!q) return unknown();
      {
        // "PNSU #9000088530<?xml …>…</nsp_config>\n" + "\n", as the real one sends it (the file ends in a newline of its own).
        const b = makeBlock(enc.encode(this.panel()));
        const prefix = enc.encode(this.chdr === "OFF" ? "" : "PNSU ");
        const out = new Uint8Array(prefix.length + b.length);
        out.set(prefix, 0);
        out.set(b, prefix.length);
        return out;
      }
      default:
        return unknown();
    }
  }

  get state() {
    return { running: this.running, trmd: this.trmd, tdiv: this.tdiv, trdl: this.trdl, ch: this.ch.map((c) => ({ ...c })), wfsu: { ...this.wfsu } };
  }
}
