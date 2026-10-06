// Deep memory: stop the scope, read the whole acquisition memory of the chosen
// channels in chunks (the driver knows how: RAW mode on a RIGOL, WFSU NP/FP on
// a LeCroy), keep it here as 16-bit codes, and serve zoomed min/max views,
// spectra and CSV from it.

import { C } from "../core/src/constants.ts";
import type { Preamble } from "../core/src/wave/decode.ts";
import { spectrum, peaks, harmonics } from "../core/src/dsp/spectrum.ts";
import { measureAll } from "../core/src/dsp/measure.ts";
import type { WindowName } from "../core/src/dsp/window.ts";
import { HttpError, type ScopeService } from "./scope.ts";

export type DeepChannel = { src: string; pre: Preamble; points: number };
export type DeepMeta = { channels: DeepChannel[]; capturedAt: string; points: number; xinc: number; xorigin: number; seconds: number };
export type DeepProgress = { src: string; done: number; total: number; channel: number; channels: number; bytesPerSec: number };

export class DeepStore {
  meta: DeepMeta | null = null;
  private data = new Map<string, Uint16Array>();
  private cancelled = false;

  cancel(): void {
    this.cancelled = true;
  }

  async capture(scope: ScopeService, srcs: string[], maxPoints: number, resume: boolean, progress: (p: DeepProgress) => void): Promise<DeepMeta> {
    if (!srcs.length) throw new HttpError(400, "choose at least one channel");
    for (const s of srcs) if (!/^CHANnel[1-4]$/.test(s)) throw new HttpError(400, `deep memory reads analog channels only (${s})`);
    const limit = Math.max(1000, Math.min(Math.round(maxPoints) || C.deep.max_points_per_channel, C.deep.max_points_per_channel));
    this.cancelled = false;
    return scope.withBusy("deep capture", async () => {
      const wasRunning = scope.status !== "STOP";
      const drv = scope.drv;
      const next = new Map<string, Uint16Array>();
      const channels: DeepChannel[] = [];
      const t0 = Date.now();
      let bytes = 0;
      let total = 0;
      try {
        const plan = await drv.deepBegin();
        total = Math.max(1, Math.min(limit, plan.total));
        const chunk = scope.reg.family === "lecroy" ? C.lecroy.deep_chunk_points : C.instrument.raw_chunk_points;
        for (let ci = 0; ci < srcs.length; ci++) {
          const src = srcs[ci];
          const buf = new Uint16Array(total);
          let pre: Preamble | null = null;
          for (let start = 0; start < total; start += chunk) {
            if (this.cancelled) throw new HttpError(499, "cancelled");
            const count = Math.min(chunk, total - start);
            const got = await drv.deepChunk(src, start, count);
            if (!pre) pre = got.pre;
            bytes += got.bytes;
            const n = Math.min(got.codes.length, total - start);
            for (let i = 0; i < n; i++) buf[start + i] = got.codes[i];
            progress({ src, done: start + count, total, channel: ci + 1, channels: srcs.length, bytesPerSec: bytes / Math.max(0.001, (Date.now() - t0) / 1000) });
          }
          next.set(src, buf);
          channels.push({ src, pre: { ...pre!, points: total }, points: total });
        }
      } finally {
        await drv.deepEnd(resume, wasRunning).catch(() => {});
        await scope.drainErrors().catch(() => []);
      }
      this.data = next;
      const p0 = channels[0].pre;
      this.meta = { channels, capturedAt: new Date().toISOString(), points: total, xinc: p0.xinc, xorigin: p0.xorigin, seconds: (Date.now() - t0) / 1000 };
      return this.meta;
    });
  }

  private channel(src: string): { c: Uint16Array; pre: Preamble } {
    const c = this.data.get(src);
    const ch = this.meta?.channels.find((x) => x.src === src);
    if (!c || !ch) throw new HttpError(404, `no deep capture of ${src}`);
    return { c, pre: ch.pre };
  }

  /** Min/max envelope of [from, to) in `cols` columns, in volts. */
  view(src: string, from: number, to: number, cols: number) {
    const { c, pre } = this.channel(src);
    const a = Math.max(0, Math.floor(from));
    const b = Math.min(c.length, Math.ceil(to));
    const n = Math.max(1, b - a);
    const k = Math.max(1, Math.min(cols, n));
    const min = new Array<number>(k);
    const max = new Array<number>(k);
    const off = pre.yorigin + pre.yref;
    for (let col = 0; col < k; col++) {
      const i0 = a + Math.floor((col * n) / k);
      const i1 = Math.max(i0 + 1, a + Math.floor(((col + 1) * n) / k));
      let lo = 65535;
      let hi = 0;
      for (let i = i0; i < i1 && i < b; i++) {
        const x = c[i];
        if (x < lo) lo = x;
        if (x > hi) hi = x;
      }
      const vlo = (lo - off) * pre.yinc;
      const vhi = (hi - off) * pre.yinc;
      min[col] = Math.min(vlo, vhi);
      max[col] = Math.max(vlo, vhi);
    }
    return { src, from: a, to: b, cols: k, min, max, xinc: pre.xinc, xorigin: pre.xorigin };
  }

  volts(src: string, from: number, count: number): Float32Array {
    const { c, pre } = this.channel(src);
    const a = Math.max(0, Math.floor(from));
    const n = Math.max(0, Math.min(count, c.length - a));
    const out = new Float32Array(n);
    const off = pre.yorigin + pre.yref;
    for (let i = 0; i < n; i++) out[i] = (c[a + i] - off) * pre.yinc;
    return out;
  }

  /** Spectrum of up to 2^20 contiguous points from `from`. */
  analyse(src: string, from: number, to: number, window: WindowName) {
    const { pre } = this.channel(src);
    const count = Math.min(1 << 20, Math.max(16, Math.floor(to - from)));
    const v = this.volts(src, from, count);
    const s = spectrum(v, pre.xinc, window, false);
    // Send at most 4096 points: the max of each group of bins, so peaks survive.
    const stride = Math.max(1, Math.ceil(s.vrms.length / 4096));
    const bins: number[] = [];
    for (let i = 0; i < s.vrms.length; i += stride) {
      let m = 0;
      for (let j = i; j < Math.min(s.vrms.length, i + stride); j++) m = Math.max(m, s.vrms[j]);
      bins.push(m);
    }
    return { src, points: count, df: s.df * stride, rbwHz: s.enbwHz, bins, peaks: peaks(s, C.spectrum.peaks), harmonics: harmonics(s, C.spectrum.harmonics), measured: measureAll(v, pre.xinc) };
  }

  /** CSV rows for [from, to), decimated by a whole stride if that is more than the row cap. */
  *csv(from: number, to: number): Generator<string> {
    if (!this.meta) throw new HttpError(404, "no deep capture");
    const chs = this.meta.channels;
    const a = Math.max(0, Math.floor(from));
    const b = Math.min(this.meta.points, Math.ceil(to));
    const stride = Math.max(1, Math.ceil((b - a) / C.deep.csv_max_rows));
    yield `# ${C.app.name} deep capture ${this.meta.capturedAt}; xinc ${this.meta.xinc} s; stride ${stride}${stride > 1 ? " (decimated: every Nth point)" : ""}\n`;
    yield `time_s,${chs.map((c) => `${c.src.replace("CHANnel", "CH")}_V`).join(",")}\n`;
    const data = chs.map((c) => ({ c: this.data.get(c.src)!, off: c.pre.yorigin + c.pre.yref, yinc: c.pre.yinc }));
    let lines: string[] = [];
    for (let i = a; i < b; i += stride) {
      const t = this.meta.xorigin + i * this.meta.xinc;
      lines.push(`${t.toExponential(9)},${data.map((d) => ((d.c[i] - d.off) * d.yinc).toPrecision(6)).join(",")}`);
      if (lines.length >= 5000) {
        yield `${lines.join("\n")}\n`;
        lines = [];
      }
    }
    if (lines.length) yield `${lines.join("\n")}\n`;
  }
}
