// Edge capture: arm ONE trigger, wait for an event that happens once (an SPI
// transfer, a reset, a burst), record a window after it, read every point of
// that record, and measure every edge in it (core/src/dsp/edges.ts).
//
// Works the same on both families: the trigger is set through the registry
// (each family's own option values, matched by meaning: "edge", "channel 2",
// "positive"), Single and Stop through the drivers, the record through deep
// memory. The instrument is left stopped on the captured event, so its own
// screen shows the same thing.
//
// Segments (LeCroy sequence mode): the instrument records N triggers, each in
// its own segment of the memory, with each trigger's time. One Single, one
// read; every segment is analysed on its own (edge times from its own
// trigger) and the statistics are merged.
//
// Besides rise and fall times: pulse widths, glitches (pulses narrower than a
// given width), runts, histograms of the edge times with the slowest edges,
// and the setup and hold of data lines against a clock.

import { C } from "../core/src/constants.ts";
import { key, type Control } from "../core/src/registry/controls.ts";
import {
  findEdges, histogram, levelsFrom, mergeSummaries, setupHold,
  type Anomaly, type Edge, type EdgeKind, type EdgeReport, type Histogram, type Summary, type TimingRow,
} from "../core/src/dsp/edges.ts";
import { extrema, levels as autoLevels, type Levels } from "../core/src/dsp/measure.ts";
import { snap125, step125 } from "../core/src/wave/steps.ts";
import { numericOption, type Value } from "../core/src/scpi/values.ts";
import { HttpError, type ScopeService } from "./scope.ts";
import type { DeepStore, DeepProgress } from "./deep.ts";
import { log } from "./log.ts";

export type TimingConfig = {
  /** The clock channel; every other measured channel is a data line against it. */
  clock: number;
  /** The clock edge that samples the data. */
  edge: EdgeKind;
  /** Required setup and hold, seconds: smaller values are counted as violations (null: not checked). */
  setupMin: number | null;
  holdMin: number | null;
};

export type BurstConfig = {
  /** Channel whose edge triggers (1–4). */
  trigger: number;
  slope: EdgeKind;
  /** Trigger level, volts; null keeps the instrument's. */
  level: number | null;
  /** How long to wait for the event (every segment's trigger) before giving up, seconds. */
  waitS: number;
  /** How much to record after the trigger, seconds. */
  windowS: number;
  /** Channels to measure (the trigger channel and, e.g., an SPI data line). */
  channels: number[];
  /** Most points per channel (per segment) to read. */
  maxPoints: number;
  /** Reference levels for all channels; null: found per channel from its record. */
  base: number | null;
  top: number | null;
  /** Triggers to record, each in its own memory segment (1: one record). */
  segments: number;
  /** Pulses narrower than this are glitches, seconds; null: none flagged. */
  glitchS: number | null;
  /** Setup and hold against a clock; null: not measured. */
  timing: TimingConfig | null;
};

export type BurstPhase = "idle" | "setting up" | "waiting for trigger" | "reading" | "analysing" | "done" | "stopped" | "error";

/** An edge, glitch or runt, and the segment it is in (0 outside sequence mode); its time is from that segment's trigger. */
export type SegEdge = Edge & { seg: number };
export type SegAnomaly = Anomaly & { seg: number };
export type SegRow = TimingRow & { seg: number };

/** One segment of one channel, for the segment table. */
export type SegmentRow = { seg: number; rise: number; fall: number; riseMean: number | null; riseMax: number | null; fallMean: number | null; fallMax: number | null; anomalies: number };

/** offScreen: the record goes past the top or bottom of the screen, where the instrument clips: edge times are then wrong. */
export type ChannelResult = Omit<EdgeReport, "edges" | "anomalies"> & {
  ch: number;
  src: string;
  /** The first C.burst.ui_edges edges (all of them are in the CSV). */
  edges: SegEdge[];
  shown: number;
  offScreen: boolean;
  /** The first C.burst.ui_rows glitches and runts. */
  anomalies: SegAnomaly[];
  hist: { rise: Histogram; fall: Histogram };
  /** The slowest edges of each kind, slowest first. */
  slowest: { rise: SegEdge[]; fall: SegEdge[] };
  /** Per segment (only when there is more than one). */
  perSegment: SegmentRow[];
};

/** Setup and hold of one data channel against the clock. */
export type TimingResult = {
  data: number;
  clock: number;
  edge: EdgeKind;
  setup: Summary;
  hold: Summary;
  worstSetup: SegRow | null;
  worstHold: SegRow | null;
  violations: { setup: number; hold: number };
  limits: { setup: number | null; hold: number | null };
  /** The first C.burst.ui_rows clock edges. */
  rows: SegRow[];
  total: number;
};

export type BurstState = {
  running: boolean;
  phase: BurstPhase;
  config: BurstConfig | null;
  startedAt: string | null;
  triggeredAfterS: number | null;
  error: string | null;
  notes: string[];
  setup: { timeDiv: number; sampleRate: number | null; points: number | null; windowS: number; dt: number | null; segments: number } | null;
  progress: DeepProgress | null;
  results: ChannelResult[];
  timing: TimingResult[];
  /** Sequence mode: segments analysed and recorded, and each one's trigger time from the first (null when the instrument did not say). */
  segments: { count: number; recorded: number; times: number[] | null } | null;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const num = (x: unknown, d: number | null): number | null => (x === undefined || x === null || x === "" ? d : Number(x));
const CHS = [1, 2, 3, 4];

/** The smallest 1-2-5 value not below x. */
export function up125(x: number): number {
  const s = snap125(x);
  return s >= x * (1 - 1e-9) ? s : step125(s, 1);
}

export function checkBurst(b: Partial<BurstConfig>): BurstConfig {
  const trigger = Math.round(Number(b.trigger ?? 1));
  const t = b.timing && typeof b.timing === "object" ? b.timing : null;
  const timing: TimingConfig | null = t
    ? { clock: Math.round(Number(t.clock)), edge: t.edge === "fall" ? "fall" : "rise", setupMin: num(t.setupMin, null), holdMin: num(t.holdMin, null) }
    : null;
  const asked = (Array.isArray(b.channels) && b.channels.length ? b.channels : [trigger]).map((x) => Math.round(Number(x)));
  // The clock is measured too: its edges are what the data is timed against.
  const channels = [...new Set(timing ? [...asked, timing.clock] : asked)].sort();
  const cfg: BurstConfig = {
    trigger,
    slope: b.slope === "fall" ? "fall" : "rise",
    level: num(b.level, null),
    waitS: num(b.waitS, C.burst.default_wait_s)!,
    windowS: num(b.windowS, C.burst.default_window_s)!,
    channels,
    maxPoints: Math.round(num(b.maxPoints, C.deep.max_points_per_channel)!),
    base: num(b.base, null),
    top: num(b.top, null),
    segments: Math.round(num(b.segments, 1)!),
    glitchS: num(b.glitchS, null),
    timing,
  };
  if (!CHS.includes(cfg.trigger)) throw new HttpError(400, "trigger channel 1–4");
  if (!cfg.channels.every((c) => CHS.includes(c))) throw new HttpError(400, "channels 1–4");
  if (cfg.level !== null && !Number.isFinite(cfg.level)) throw new HttpError(400, "trigger level must be a number of volts");
  if (!(cfg.waitS > 0 && cfg.waitS <= C.burst.max_wait_s)) throw new HttpError(400, `wait 0–${C.burst.max_wait_s} s`);
  if (!(cfg.windowS > 0 && cfg.windowS <= C.burst.max_window_s)) throw new HttpError(400, `record window 0–${C.burst.max_window_s} s`);
  if (!(cfg.maxPoints >= 1000 && cfg.maxPoints <= C.deep.max_points_per_channel)) throw new HttpError(400, `1000–${C.deep.max_points_per_channel} points per channel`);
  if ((cfg.base === null) !== (cfg.top === null) || (cfg.base !== null && !(cfg.top! > cfg.base))) throw new HttpError(400, "give both base and top (top above base), or neither");
  if (!(cfg.segments >= 1 && cfg.segments <= C.burst.max_segments)) throw new HttpError(400, `segments 1–${C.burst.max_segments}`);
  if (cfg.glitchS !== null && !(cfg.glitchS > 0)) throw new HttpError(400, "the glitch width must be a positive time");
  if (timing) {
    if (!CHS.includes(timing.clock)) throw new HttpError(400, "clock channel 1–4");
    if (cfg.channels.length < 2) throw new HttpError(400, "setup and hold need a data channel besides the clock: tick it under Measure on");
    for (const [k, v] of [["setup", timing.setupMin], ["hold", timing.holdMin]] as const) {
      if (v !== null && !Number.isFinite(v)) throw new HttpError(400, `required ${k} must be a time`);
    }
  }
  return cfg;
}

const IDLE: BurstState = {
  running: false, phase: "idle", config: null, startedAt: null, triggeredAfterS: null, error: null, notes: [], setup: null, progress: null, results: [], timing: [], segments: null,
};

/** The k largest by duration, largest first. */
class Slowest {
  list: SegEdge[] = [];
  private k: number;
  constructor(k: number) {
    this.k = k;
  }
  add(e: SegEdge): void {
    if (this.list.length === this.k && e.dur <= this.list[this.k - 1].dur) return;
    let i = this.list.length;
    while (i > 0 && this.list[i - 1].dur < e.dur) i--;
    this.list.splice(i, 0, e);
    if (this.list.length > this.k) this.list.pop();
  }
}

/** One channel's findings, segment by segment. */
class ChannelAcc {
  edges: SegEdge[] = [];
  anomalies: SegAnomaly[] = [];
  reports: Omit<EdgeReport, "edges" | "anomalies">[] = [];
  durs = { rise: [] as number[], fall: [] as number[] };
  slow = { rise: new Slowest(C.burst.slowest), fall: new Slowest(C.burst.slowest) };
  perSegment: SegmentRow[] = [];

  add(seg: number, r: EdgeReport): void {
    const { edges, anomalies, ...rest } = r;
    this.reports.push(rest);
    for (const e of edges) {
      const s = { ...e, seg };
      if (this.edges.length < C.burst.max_edges) this.edges.push(s);
      this.durs[e.kind].push(e.dur);
      this.slow[e.kind].add(s);
    }
    for (const a of anomalies) if (this.anomalies.length < C.burst.max_edges) this.anomalies.push({ ...a, seg });
    this.perSegment.push({ seg, rise: r.counts.rise, fall: r.counts.fall, riseMean: r.rises.mean, riseMax: r.rises.max, fallMean: r.falls.mean, fallMax: r.falls.max, anomalies: r.counts.glitch + r.counts.runt });
  }

  result(ch: number, src: string, offScreen: boolean, several: boolean): ChannelResult {
    const R = this.reports;
    const sum = (f: (r: (typeof R)[number]) => number) => R.reduce((a, r) => a + f(r), 0);
    const counts = { rise: sum((r) => r.counts.rise), fall: sum((r) => r.counts.fall), under: sum((r) => r.counts.under), glitch: sum((r) => r.counts.glitch), runt: sum((r) => r.counts.runt) };
    return {
      levels: R[0].levels,
      dt: R[0].dt,
      flat: R.every((r) => r.flat),
      truncated: counts.rise + counts.fall > this.edges.length,
      rises: mergeSummaries(R.map((r) => r.rises)),
      falls: mergeSummaries(R.map((r) => r.falls)),
      periods: mergeSummaries(R.map((r) => r.periods)),
      pulses: { high: mergeSummaries(R.map((r) => r.pulses.high)), low: mergeSummaries(R.map((r) => r.pulses.low)) },
      counts,
      ch,
      src,
      edges: this.edges.slice(0, C.burst.ui_edges),
      shown: Math.min(this.edges.length, C.burst.ui_edges),
      offScreen,
      anomalies: this.anomalies.slice(0, C.burst.ui_rows),
      hist: { rise: histogram(this.durs.rise, C.burst.histogram_bins), fall: histogram(this.durs.fall, C.burst.histogram_bins) },
      slowest: { rise: this.slow.rise.list, fall: this.slow.fall.list },
      perSegment: several ? this.perSegment.slice(0, C.burst.ui_rows) : [],
    };
  }
}

/** One data channel's setup and hold, segment by segment. */
class TimingAcc {
  rows: SegRow[] = [];
  setups: Summary[] = [];
  holds: Summary[] = [];
  worstSetup: SegRow | null = null;
  worstHold: SegRow | null = null;
  violations = { setup: 0, hold: 0 };
  total = 0;
  private t: TimingConfig;
  constructor(t: TimingConfig) {
    this.t = t;
  }

  add(seg: number, clock: Edge[], data: Edge[]): void {
    const r = setupHold(clock, data, this.t.edge);
    this.setups.push(r.setup);
    this.holds.push(r.hold);
    this.total += r.rows.length;
    for (const x of r.rows) {
      if (this.rows.length < C.burst.max_edges) this.rows.push({ ...x, seg });
      if (this.t.setupMin !== null && x.setup !== null && x.setup < this.t.setupMin) this.violations.setup++;
      if (this.t.holdMin !== null && x.hold !== null && x.hold < this.t.holdMin) this.violations.hold++;
    }
    if (r.worstSetup && (!this.worstSetup || r.worstSetup.setup! < this.worstSetup.setup!)) this.worstSetup = { ...r.worstSetup, seg };
    if (r.worstHold && (!this.worstHold || r.worstHold.hold! < this.worstHold.hold!)) this.worstHold = { ...r.worstHold, seg };
  }

  result(data: number): TimingResult {
    const t = this.t;
    return {
      data, clock: t.clock, edge: t.edge, setup: mergeSummaries(this.setups), hold: mergeSummaries(this.holds), worstSetup: this.worstSetup, worstHold: this.worstHold,
      violations: this.violations, limits: { setup: t.setupMin, hold: t.holdMin }, rows: this.rows.slice(0, C.burst.ui_rows), total: this.total,
    };
  }
}

export class BurstRunner {
  state: BurstState = { ...IDLE };
  private stopRequested = false;
  private deep: DeepStore;
  /** Everything found (the state carries only the first few thousand of each). */
  private full = { edges: new Map<number, SegEdge[]>(), anomalies: new Map<number, SegAnomaly[]>(), timing: new Map<number, SegRow[]>() };

  constructor(deep: DeepStore) {
    this.deep = deep;
  }

  stop(): void {
    this.stopRequested = true;
    this.deep.cancel();
  }

  async run(scope: ScopeService, cfg: BurstConfig, publish: (s: BurstState) => void): Promise<BurstState> {
    this.stopRequested = false;
    const set = (p: Partial<BurstState>) => {
      this.state = { ...this.state, ...p };
      publish(this.state);
    };
    set({ ...IDLE, running: true, phase: "setting up", config: cfg, startedAt: new Date().toISOString() });
    const notes: string[] = [];
    try {
      await scope.withBusy("edge capture", async () => {
        const reg = scope.reg;
        if (cfg.segments > 1 && !(reg.features.segments && scope.drv.segmentTimes)) {
          throw new HttpError(400, "Several segments need an instrument with segmented memory the app can read (a LeCroy in sequence mode). Set Segments to 1.");
        }
        const ctl = (id: string): Control | undefined => reg.byId.get(id);
        /** The option of a control that means what `re` says ("EDGE"/"Edge", "CHANnel2"/"C2", "POSitive"/"Positive"). */
        const option = (id: string, re: RegExp): string | null => ctl(id)?.options?.find((o) => re.test(o.value))?.value ?? null;
        const write = async (k: string, v: Value) => {
          const c = ctl(k.split("@")[0]);
          if (!c?.set) return null;
          return (await scope.write(k, v, true)).value;
        };

        // 1. Every channel to be measured is on (an instrument records only displayed channels).
        for (const ch of new Set([cfg.trigger, ...cfg.channels])) if (scope.values.get(key("channel.display", ch)) !== true) await write(key("channel.display", ch), true);

        // 2. An edge trigger on the chosen channel and slope.
        const mode = option("trigger.mode", /^edge$/i);
        if (mode) await write("trigger.mode", mode);
        const src = option("trigger.edge.source", new RegExp(`^(CHAN(nel)?|C)${cfg.trigger}$`, "i"));
        if (!src) throw new HttpError(400, `channel ${cfg.trigger} cannot be a trigger source on this instrument`);
        await write("trigger.edge.source", src);
        const slope = option("trigger.edge.slope", cfg.slope === "rise" ? /^pos/i : /^neg/i);
        if (slope) await write("trigger.edge.slope", slope);
        if (cfg.level !== null) await write("trigger.edge.level", cfg.level);

        // 3. Segments: sequence mode with N segments, or back to one record if an earlier capture left it in sequence mode.
        if (reg.features.segments) {
          const seq = option("acquire.mode", /^sequence$/i);
          const real = option("acquire.mode", /^real/i);
          if (cfg.segments > 1 && seq) {
            await write("acquire.mode", seq);
            await write("acquire.segments", cfg.segments);
          } else if (cfg.segments === 1 && real && scope.values.get("acquire.mode") === seq) await write("acquire.mode", real);
        }

        // 4. Timebase: the window after the trigger fits in the divisions right of the trigger point (10 on most screens, 14 on a T3DSO).
        const divs = reg.divisionsX;
        const pre = C.burst.pre_trigger_div;
        const after = divs - pre;
        let tdiv = Number(await write("timebase.scale", up125(cfg.windowS / after)));
        if (tdiv * after < cfg.windowS * 0.999) tdiv = Number(await write("timebase.scale", step125(tdiv, 1)));
        // Trigger point `pre` divisions from the left edge: screen centre divs/2 − pre divisions after it.
        if (ctl("timebase.offset")?.set) await write("timebase.offset", (divs / 2 - pre) * tdiv);
        else if (ctl("timebase.delay")?.set) await write("timebase.delay", -(divs / 2 - pre) * tdiv);

        // 5. As much memory as allowed, so the sample rate stays as high as the window permits.
        const md = ctl("acquire.mdepth");
        if (md?.set && md.kind === "enum") {
          const best = (md.options ?? []).map((o) => ({ v: o.value, n: numericOption(o.value) })).filter((o) => o.n !== null && o.n <= cfg.maxPoints).sort((a, b) => b.n! - a.n!)[0];
          if (best) await write("acquire.mdepth", best.v);
        } else if (md?.set) await write("acquire.mdepth", cfg.maxPoints);
        const srate = (await scope.readKey("acquire.srate").catch(() => null)) as number | null;
        const dt = typeof srate === "number" && srate > 0 ? 1 / srate : null;
        set({ setup: { timeDiv: tdiv, sampleRate: srate, points: srate ? Math.round(srate * tdiv * divs) : null, windowS: tdiv * after, dt, segments: cfg.segments } });
        if (dt) notes.push(`Sampling every ${fmtS(dt)}: edges faster than about ${fmtS(5 * dt)} cannot be measured well (they are marked under-sampled). A shorter window, or fewer channels switched on (instruments share their sample rate between channels), raises the sample rate.`);

        // 6. One Single, then wait for the instrument to stop on the event (in sequence mode: after the last segment).
        if (this.stopRequested) throw new Stopped();
        await scope.action("root.single", null);
        set({ phase: "waiting for trigger" });
        const t0 = Date.now();
        for (;;) {
          if (this.stopRequested) {
            await scope.action("root.stop", null).catch(() => {});
            throw new Stopped();
          }
          if ((await scope.drv.status()) === "STOP") break;
          if (Date.now() - t0 > cfg.waitS * 1000) {
            await scope.action("root.stop", null).catch(() => {});
            const edge = `${cfg.slope === "rise" ? "rising" : "falling"} edge${cfg.level !== null ? ` through ${cfg.level} V` : ""}`;
            throw new HttpError(408, cfg.segments > 1
              ? `Not all ${cfg.segments} triggers arrived within ${cfg.waitS} s on CH${cfg.trigger} (${edge}). Fewer segments, a longer wait, or check the level and the channel.`
              : `No trigger within ${cfg.waitS} s on CH${cfg.trigger} (${edge}). Check the level and the channel, or wait longer.`);
          }
          await sleep(C.burst.poll_ms);
        }
        set({ triggeredAfterS: (Date.now() - t0) / 1000, phase: "reading" });

        // 7. Every point of the record (deep memory: chunked, the same for both families); in sequence mode every segment.
        const srcs = cfg.channels.map((c) => `CHANnel${c}`);
        const limit = Math.min(C.deep.max_points_per_channel, cfg.maxPoints * cfg.segments);
        const meta = await this.deep.capture(scope, srcs, limit, false, (p) => set({ progress: p }), true);
        let recorded = 1;
        let times: number[] | null = null;
        let offsets: number[] | null = null;
        if (cfg.segments > 1) {
          const seg = await scope.drv.segmentTimes!(srcs[0]);
          if (!seg) notes.push(`The instrument returned one record, not ${cfg.segments} segments: analysed as one record.`);
          else {
            recorded = seg.count;
            if (seg.times.length === seg.count) {
              times = seg.times.map((x) => x.time);
              offsets = seg.times.map((x) => x.offset);
            } else notes.push("The instrument did not send the segments' trigger times: each segment's edge times are taken from the first segment's descriptor.");
          }
        }
        const per = Math.max(1, Math.floor(meta.available / recorded));
        const count = Math.max(1, Math.min(recorded, Math.floor(meta.points / per)));
        if (count < recorded) notes.push(`Only the first ${count} of ${recorded} segments fit in the ${meta.points.toLocaleString()} points read per channel: fewer segments or a shorter window would bring them all.`);

        // 8. Every edge of every channel, segment by segment.
        set({ phase: "analysing" });
        const vs = new Map<number, Float32Array>();
        const lv = new Map<number, Levels>();
        const accs = new Map<number, ChannelAcc>();
        for (const s of srcs) {
          const n = Number(s.slice(-1));
          const v = this.deep.volts(s, 0, count * per);
          vs.set(n, v);
          // One set of reference levels for all segments of a channel: from the whole record, or as given.
          lv.set(n, cfg.base !== null && cfg.top !== null ? levelsFrom(cfg.base, cfg.top) : autoLevels(v));
          accs.set(n, new ChannelAcc());
        }
        const tim = cfg.timing;
        const tAccs = new Map<number, TimingAcc>();
        if (tim) for (const n of cfg.channels) if (n !== tim.clock) tAccs.set(n, new TimingAcc(tim));
        for (let g = 0; g < count; g++) {
          const reps = new Map<number, EdgeReport>();
          for (const s of srcs) {
            const n = Number(s.slice(-1));
            const ch = meta.channels.find((c) => c.src === s)!;
            const r = findEdges(vs.get(n)!.subarray(g * per, (g + 1) * per), ch.pre.xinc, offsets ? offsets[g] : ch.pre.xorigin, {
              levels: lv.get(n), maxEdges: C.burst.max_edges, minSamples: C.burst.min_samples_per_edge, glitchS: cfg.glitchS,
            });
            reps.set(n, r);
            accs.get(n)!.add(g, r);
          }
          if (tim) for (const [n, acc] of tAccs) acc.add(g, reps.get(tim.clock)!.edges, reps.get(n)!.edges);
          if (this.stopRequested) throw new Stopped();
        }
        const results: ChannelResult[] = [];
        for (const s of srcs) {
          const n = Number(s.slice(-1));
          const v = vs.get(n)!;
          // The screen spans ±4 divisions about −offset; past it the ADC soon clips, and a clipped edge looks fast.
          const vdiv = Number(scope.values.get(key("channel.scale", n)));
          const off = Number(scope.values.get(key("channel.offset", n)) ?? 0);
          const { min, max } = extrema(v);
          const offScreen = vdiv > 0 && (max > 4 * vdiv - off + vdiv * 0.05 || min < -4 * vdiv - off - vdiv * 0.05);
          if (offScreen) notes.push(`CH${n} goes off the screen (${fmtV(min)} … ${fmtV(max)} at ${fmtV(vdiv)}/div): the instrument clips it there, so its edges look faster than they are. Set CH${n}'s V/div and offset so the whole signal fits, and capture again.`);
          const acc = accs.get(n)!;
          this.full.edges.set(n, acc.edges);
          this.full.anomalies.set(n, acc.anomalies);
          results.push(acc.result(n, s, offScreen, count > 1));
        }
        const timing: TimingResult[] = [];
        this.full.timing.clear();
        for (const [n, acc] of tAccs) {
          this.full.timing.set(n, acc.rows);
          const r = acc.result(n);
          timing.push(r);
          if (r.violations.setup || r.violations.hold) {
            notes.push(`CH${n} against the CH${r.clock} clock: ${r.violations.setup} setup and ${r.violations.hold} hold violation(s) in ${r.total} clock edges.`);
          }
        }
        if (results.some((r) => r.flat)) notes.push("A channel's record is flat (no swing between its base and top): it has no edges to measure.");
        if (results.some((r) => r.truncated)) notes.push(`More than ${C.burst.max_edges.toLocaleString()} edges: the rest were counted but not listed.`);
        if (recorded > 1) notes.push(`The instrument is left in sequence mode with ${recorded} segments; set Sampling mode back to Real time (Settings) for normal use, or capture again with 1 segment.`);
        set({ results, timing, segments: recorded > 1 ? { count, recorded, times: times ? times.slice(0, C.burst.ui_rows) : null } : null });
      });
      set({ running: false, phase: "done", notes, progress: null });
      log(`edge capture: ${this.state.results.map((r) => `CH${r.ch} ${r.counts.rise}↑ ${r.counts.fall}↓`).join(", ")}${this.state.segments ? ` in ${this.state.segments.count} segments` : ""}`);
    } catch (e) {
      if (e instanceof Stopped) set({ running: false, phase: "stopped", notes, progress: null });
      else set({ running: false, phase: "error", error: (e as Error).message, notes, progress: null });
    }
    return this.state;
  }

  private header(what: string): string {
    return `# ${C.app.name} edge capture ${this.state.startedAt ?? ""}; ${what}; times from the trigger of the row's segment (segment 0 outside sequence mode)\n`;
  }

  /** Every edge found, every channel. */
  csv(): Generator<string> {
    return rows(
      this.header("10-90 % rise and 90-10 % fall times"),
      "channel,segment,edge,kind,time_s,duration_s,under_sampled",
      this.state.results.map((r) => ({ ch: r.ch, list: this.full.edges.get(r.ch) ?? r.edges })),
      (ch, e: SegEdge, i) => `CH${ch},${e.seg},${i + 1},${e.kind},${e.t.toExponential(9)},${e.dur.toExponential(6)},${e.under ? 1 : 0}`,
    );
  }

  /** Every glitch and runt. */
  anomaliesCsv(): Generator<string> {
    return rows(
      this.header("glitches (narrower than the set width) and runts (past 50 % but not to the far level)"),
      "channel,segment,kind,polarity,time_s,width_s,peak_V",
      this.state.results.map((r) => ({ ch: r.ch, list: this.full.anomalies.get(r.ch) ?? r.anomalies })),
      (ch, a: SegAnomaly) => `CH${ch},${a.seg},${a.kind},${a.polarity},${a.t.toExponential(9)},${a.width?.toExponential(6) ?? ""},${a.peak?.toPrecision(6) ?? ""}`,
    );
  }

  /** Setup and hold at every sampling clock edge, every data channel. */
  timingCsv(): Generator<string> {
    const t0 = this.state.timing[0];
    return rows(
      this.header(`setup and hold against the CH${t0?.clock ?? "?"} clock (${t0?.edge === "fall" ? "falling" : "rising"} edges), between 50 % crossings`),
      "data_channel,segment,clock_edge_time_s,setup_s,hold_s",
      this.state.timing.map((t) => ({ ch: t.data, list: this.full.timing.get(t.data) ?? t.rows })),
      (ch, x: SegRow) => `CH${ch},${x.seg},${x.t.toExponential(9)},${x.setup?.toExponential(6) ?? ""},${x.hold?.toExponential(6) ?? ""}`,
    );
  }
}

/** CSV text in pieces of a few thousand lines. */
function* rows<T>(head: string, columns: string, groups: { ch: number; list: T[] }[], line: (ch: number, x: T, i: number) => string): Generator<string> {
  yield head;
  yield `${columns}\n`;
  for (const { ch, list } of groups) {
    let out: string[] = [];
    for (let i = 0; i < list.length; i++) {
      out.push(line(ch, list[i], i));
      if (out.length >= 5000) {
        yield `${out.join("\n")}\n`;
        out = [];
      }
    }
    if (out.length) yield `${out.join("\n")}\n`;
  }
}

class Stopped extends Error {}

const fmtV = (v: number) => `${Number(v.toPrecision(3))} V`;

function fmtS(s: number): string {
  const units: [number, string][] = [[1, "s"], [1e-3, "ms"], [1e-6, "µs"], [1e-9, "ns"], [1e-12, "ps"]];
  for (const [f, u] of units) if (Math.abs(s) >= f) return `${Number((s / f).toPrecision(3))} ${u}`;
  return `${s} s`;
}
