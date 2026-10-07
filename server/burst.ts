// Edge capture: arm ONE trigger, wait for an event that happens once (an SPI
// transfer, a reset, a burst), record a window after it, read every point of
// that record, and measure every edge in it (core/src/dsp/edges.ts).
//
// Works the same on both families: the trigger is set through the registry
// (each family's own option values, matched by meaning: "edge", "channel 2",
// "positive"), Single and Stop through the drivers, the record through deep
// memory. The instrument is left stopped on the captured event, so its own
// screen shows the same thing.

import { C } from "../core/src/constants.ts";
import { key, type Control } from "../core/src/registry/controls.ts";
import { findEdges, levelsFrom, type Edge, type EdgeReport } from "../core/src/dsp/edges.ts";
import { extrema } from "../core/src/dsp/measure.ts";
import { snap125, step125 } from "../core/src/wave/steps.ts";
import { numericOption, type Value } from "../core/src/scpi/values.ts";
import { HttpError, type ScopeService } from "./scope.ts";
import type { DeepStore, DeepProgress } from "./deep.ts";
import { log } from "./log.ts";

export type BurstConfig = {
  /** Channel whose edge triggers (1–4). */
  trigger: number;
  slope: "rise" | "fall";
  /** Trigger level, volts; null keeps the instrument's. */
  level: number | null;
  /** How long to wait for the event before giving up, seconds. */
  waitS: number;
  /** How much to record after the trigger, seconds. */
  windowS: number;
  /** Channels to measure (the trigger channel and, e.g., an SPI data line). */
  channels: number[];
  /** Most points per channel to read. */
  maxPoints: number;
  /** Reference levels for all channels; null: found per channel from its record. */
  base: number | null;
  top: number | null;
};

export type BurstPhase = "idle" | "setting up" | "waiting for trigger" | "reading" | "analysing" | "done" | "stopped" | "error";

/** offScreen: the record goes past the top or bottom of the screen, where the instrument clips: edge times are then wrong. */
export type ChannelResult = Omit<EdgeReport, "edges"> & { ch: number; src: string; edges: Edge[]; shown: number; offScreen: boolean };

export type BurstState = {
  running: boolean;
  phase: BurstPhase;
  config: BurstConfig | null;
  startedAt: string | null;
  triggeredAfterS: number | null;
  error: string | null;
  notes: string[];
  setup: { timeDiv: number; sampleRate: number | null; points: number | null; windowS: number; dt: number | null } | null;
  progress: DeepProgress | null;
  results: ChannelResult[];
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const num = (x: unknown, d: number | null): number | null => (x === undefined || x === null || x === "" ? d : Number(x));

/** The smallest 1-2-5 value not below x. */
export function up125(x: number): number {
  const s = snap125(x);
  return s >= x * (1 - 1e-9) ? s : step125(s, 1);
}

export function checkBurst(b: Partial<BurstConfig>): BurstConfig {
  const trigger = Math.round(Number(b.trigger ?? 1));
  const channels = (Array.isArray(b.channels) && b.channels.length ? b.channels : [trigger]).map((x) => Math.round(Number(x)));
  const cfg: BurstConfig = {
    trigger,
    slope: b.slope === "fall" ? "fall" : "rise",
    level: num(b.level, null),
    waitS: num(b.waitS, C.burst.default_wait_s)!,
    windowS: num(b.windowS, C.burst.default_window_s)!,
    channels: [...new Set(channels)].sort(),
    maxPoints: Math.round(num(b.maxPoints, C.deep.max_points_per_channel)!),
    base: num(b.base, null),
    top: num(b.top, null),
  };
  if (![1, 2, 3, 4].includes(cfg.trigger)) throw new HttpError(400, "trigger channel 1–4");
  if (!cfg.channels.every((c) => [1, 2, 3, 4].includes(c))) throw new HttpError(400, "channels 1–4");
  if (cfg.level !== null && !Number.isFinite(cfg.level)) throw new HttpError(400, "trigger level must be a number of volts");
  if (!(cfg.waitS > 0 && cfg.waitS <= C.burst.max_wait_s)) throw new HttpError(400, `wait 0–${C.burst.max_wait_s} s`);
  if (!(cfg.windowS > 0 && cfg.windowS <= C.burst.max_window_s)) throw new HttpError(400, `record window 0–${C.burst.max_window_s} s`);
  if (!(cfg.maxPoints >= 1000 && cfg.maxPoints <= C.deep.max_points_per_channel)) throw new HttpError(400, `1000–${C.deep.max_points_per_channel} points per channel`);
  if ((cfg.base === null) !== (cfg.top === null) || (cfg.base !== null && !(cfg.top! > cfg.base))) throw new HttpError(400, "give both base and top (top above base), or neither");
  return cfg;
}

const IDLE: BurstState = { running: false, phase: "idle", config: null, startedAt: null, triggeredAfterS: null, error: null, notes: [], setup: null, progress: null, results: [] };

export class BurstRunner {
  state: BurstState = { ...IDLE };
  private stopRequested = false;
  private deep: DeepStore;

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

        // 3. Timebase: the window after the trigger fits in the divisions right of the trigger point.
        const pre = C.burst.pre_trigger_div;
        const after = 10 - pre;
        let tdiv = Number(await write("timebase.scale", up125(cfg.windowS / after)));
        if (tdiv * after < cfg.windowS * 0.999) tdiv = Number(await write("timebase.scale", step125(tdiv, 1)));
        // Trigger point `pre` divisions from the left edge: screen centre 5 − pre divisions after it.
        if (ctl("timebase.offset")?.set) await write("timebase.offset", (5 - pre) * tdiv);
        else if (ctl("timebase.delay")?.set) await write("timebase.delay", -(5 - pre) * tdiv);

        // 4. As much memory as allowed, so the sample rate stays as high as the window permits.
        const md = ctl("acquire.mdepth");
        if (md?.set && md.kind === "enum") {
          const best = (md.options ?? []).map((o) => ({ v: o.value, n: numericOption(o.value) })).filter((o) => o.n !== null && o.n <= cfg.maxPoints).sort((a, b) => b.n! - a.n!)[0];
          if (best) await write("acquire.mdepth", best.v);
        } else if (md?.set) await write("acquire.mdepth", cfg.maxPoints);
        const srate = (await scope.readKey("acquire.srate").catch(() => null)) as number | null;
        const dt = typeof srate === "number" && srate > 0 ? 1 / srate : null;
        set({ setup: { timeDiv: tdiv, sampleRate: srate, points: srate ? Math.round(srate * tdiv * 10) : null, windowS: tdiv * after, dt } });
        if (dt) notes.push(`Sampling every ${fmtS(dt)}: edges faster than about ${fmtS(5 * dt)} cannot be measured well (they are marked under-sampled). A shorter window, or fewer channels switched on (instruments share their sample rate between channels), raises the sample rate.`);

        // 5. One trigger: Single, then wait for the instrument to stop on the event.
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
            throw new HttpError(408, `No trigger within ${cfg.waitS} s on CH${cfg.trigger} (${cfg.slope === "rise" ? "rising" : "falling"} edge${cfg.level !== null ? ` through ${cfg.level} V` : ""}). Check the level and the channel, or wait longer.`);
          }
          await sleep(C.burst.poll_ms);
        }
        set({ triggeredAfterS: (Date.now() - t0) / 1000, phase: "reading" });

        // 6. Every point of the record (deep memory: chunked, the same for both families).
        const srcs = cfg.channels.map((c) => `CHANnel${c}`);
        const meta = await this.deep.capture(scope, srcs, cfg.maxPoints, false, (p) => set({ progress: p }), true);

        // 7. Every edge of every channel.
        set({ phase: "analysing" });
        const results: ChannelResult[] = [];
        for (const s of srcs) {
          const v = this.deep.volts(s, 0, meta.points);
          const ch = meta.channels.find((c) => c.src === s)!;
          const r = findEdges(v, ch.pre.xinc, ch.pre.xorigin, {
            levels: cfg.base !== null && cfg.top !== null ? levelsFrom(cfg.base, cfg.top) : undefined,
            maxEdges: C.burst.max_edges,
            minSamples: C.burst.min_samples_per_edge,
          });
          this.full.set(s, r.edges);
          const n = Number(s.slice(-1));
          // The screen spans ±4 divisions about −offset; past it the ADC soon clips, and a clipped edge looks fast.
          const vdiv = Number(scope.values.get(key("channel.scale", n)));
          const off = Number(scope.values.get(key("channel.offset", n)) ?? 0);
          const { min, max } = extrema(v);
          const offScreen = vdiv > 0 && (max > 4 * vdiv - off + vdiv * 0.05 || min < -4 * vdiv - off - vdiv * 0.05);
          if (offScreen) notes.push(`CH${n} goes off the screen (${fmtV(min)} … ${fmtV(max)} at ${fmtV(vdiv)}/div): the instrument clips it there, so its edges look faster than they are. Set CH${n}'s V/div and offset so the whole signal fits, and capture again.`);
          results.push({ ...r, ch: n, src: s, edges: r.edges.slice(0, C.burst.ui_edges), shown: Math.min(r.edges.length, C.burst.ui_edges), offScreen });
        }
        if (results.some((r) => r.flat)) notes.push("A channel's record is flat (no swing between its base and top): it has no edges to measure.");
        if (results.some((r) => r.truncated)) notes.push(`More than ${C.burst.max_edges.toLocaleString()} edges: the rest were counted but not listed.`);
        set({ results });
      });
      set({ running: false, phase: "done", notes, progress: null });
      log(`edge capture: ${this.state.results.map((r) => `CH${r.ch} ${r.counts.rise}↑ ${r.counts.fall}↓`).join(", ")}`);
    } catch (e) {
      if (e instanceof Stopped) set({ running: false, phase: "stopped", notes, progress: null });
      else set({ running: false, phase: "error", error: (e as Error).message, notes, progress: null });
    }
    return this.state;
  }

  /** Every edge found (the state carries only the first few thousand). */
  private full = new Map<string, Edge[]>();

  *csv(): Generator<string> {
    yield `# ${C.app.name} edge capture ${this.state.startedAt ?? ""}; times from the trigger; 10-90 % rise and 90-10 % fall times\n`;
    yield "channel,edge,kind,time_s,duration_s,under_sampled\n";
    for (const r of this.state.results) {
      const all = this.full.get(r.src) ?? r.edges;
      let lines: string[] = [];
      for (let i = 0; i < all.length; i++) {
        const e = all[i];
        lines.push(`CH${r.ch},${i + 1},${e.kind},${e.t.toExponential(9)},${e.dur.toExponential(6)},${e.under ? 1 : 0}`);
        if (lines.length >= 5000) {
          yield `${lines.join("\n")}\n`;
          lines = [];
        }
      }
      if (lines.length) yield `${lines.join("\n")}\n`;
    }
  }
}

class Stopped extends Error {}

const fmtV = (v: number) => `${Number(v.toPrecision(3))} V`;

function fmtS(s: number): string {
  const units: [number, string][] = [[1, "s"], [1e-3, "ms"], [1e-6, "µs"], [1e-9, "ns"], [1e-12, "ps"]];
  for (const [f, u] of units) if (Math.abs(s) >= f) return `${Number((s / f).toPrecision(3))} ${u}`;
  return `${s} s`;
}
