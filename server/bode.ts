// Frequency response with the MHO984's own generator: step GEN OUT through the
// band, capture input and output channels together, and take gain and phase
// from the lock-in phasors of the two records (core/src/dsp/lockin.ts).
// Every setting the sweep touches is read first and put back afterwards.

import { C } from "../core/src/constants.ts";
import { key } from "../core/src/registry/controls.ts";
import { corner, plan, point, timebaseFor, type BodePoint, type Spacing } from "../core/src/dsp/bode.ts";
import { phasor } from "../core/src/dsp/lockin.ts";
import { extrema } from "../core/src/dsp/measure.ts";
import { snap125, step125 } from "../core/src/wave/steps.ts";
import type { Value } from "../core/src/scpi/values.ts";
import { HttpError, type ScopeService } from "./scope.ts";

export type BodeConfig = {
  startHz: number;
  stopHz: number;
  points: number;
  spacing: Spacing;
  amplitudeVpp: number;
  awg: number;
  inCh: number;
  outCh: number;
  settleMs: number;
};

export type BodeState = {
  running: boolean;
  config: BodeConfig | null;
  points: BodePoint[];
  step: number;
  total: number;
  error: string | null;
  corner: { hz: number; phaseDeg: number } | null;
  startedAt: string | null;
  notes: string[];
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function checkConfig(b: Partial<BodeConfig>): BodeConfig {
  const n = (x: unknown, d: number) => (x === undefined || x === null || x === "" ? d : Number(x));
  const cfg: BodeConfig = {
    startHz: n(b.startHz, C.bode.start_hz),
    stopHz: n(b.stopHz, C.bode.stop_hz),
    points: Math.round(n(b.points, C.bode.points)),
    spacing: b.spacing === "lin" ? "lin" : "log",
    amplitudeVpp: n(b.amplitudeVpp, C.bode.amplitude_vpp),
    awg: Math.round(n(b.awg, C.bode.awg)),
    inCh: Math.round(n(b.inCh, C.bode.in_channel)),
    outCh: Math.round(n(b.outCh, C.bode.out_channel)),
    settleMs: n(b.settleMs, C.bode.settle_ms),
  };
  if (!(cfg.startHz >= C.bode.min_hz && cfg.stopHz <= C.bode.max_hz && cfg.startHz < cfg.stopHz)) throw new HttpError(400, `frequencies must satisfy ${C.bode.min_hz} Hz ≤ start < stop ≤ ${C.bode.max_hz / 1e6} MHz`);
  if (!(cfg.points >= 2 && cfg.points <= 500)) throw new HttpError(400, "2–500 points");
  if (!(cfg.amplitudeVpp > 0 && cfg.amplitudeVpp <= 20)) throw new HttpError(400, "amplitude 0–20 Vpp");
  if (![1, 2].includes(cfg.awg)) throw new HttpError(400, "generator 1 or 2");
  if (![1, 2, 3, 4].includes(cfg.inCh) || ![1, 2, 3, 4].includes(cfg.outCh) || cfg.inCh === cfg.outCh) throw new HttpError(400, "two different input channels");
  return cfg;
}

export class BodeRunner {
  state: BodeState = { running: false, config: null, points: [], step: 0, total: 0, error: null, corner: null, startedAt: null, notes: [] };
  private stopRequested = false;

  stop(): void {
    this.stopRequested = true;
  }

  async run(scope: ScopeService, cfg: BodeConfig, publish: (s: BodeState) => void): Promise<BodeState> {
    if (!scope.has("AFG")) throw new HttpError(400, "the Bode sweep drives the built-in generator, which needs the AFG50 or AFG100 option — :SYSTem:OPTion:STATus? reports neither");
    const freqs = plan(cfg.startHz, cfg.stopHz, cfg.points, cfg.spacing);
    this.stopRequested = false;
    this.state = { running: true, config: cfg, points: [], step: 0, total: freqs.length, error: null, corner: null, startedAt: new Date().toISOString(), notes: [] };
    publish(this.state);
    const g = cfg.awg;
    const touched = [
      key("source.output.state", g), key("source.function", g), key("source.frequency", g), key("source.voltage.amplitude", g), key("source.voltage.offset", g),
      ...[cfg.inCh, cfg.outCh].flatMap((ch) => [key("channel.display", ch), key("channel.scale", ch), key("channel.offset", ch), key("channel.coupling", ch)]),
      "timebase.scale", "timebase.offset", "trigger.mode", "trigger.sweep", "trigger.edge.source", "trigger.edge.slope", "trigger.edge.level",
    ];
    try {
      await scope.withBusy("Bode sweep", async () => {
        const saved = await scope.readKeys(touched);
        const set = (k: string, v: Value) => scope.write(k, v, true);
        try {
          await set(key("source.function", g), "SINusoid");
          await set(key("source.voltage.offset", g), 0);
          await set(key("source.voltage.amplitude", g), cfg.amplitudeVpp);
          await set(key("source.frequency", g), freqs[0]);
          for (const ch of [cfg.inCh, cfg.outCh]) {
            await set(key("channel.display", ch), true);
            await set(key("channel.coupling", ch), "DC");
            await set(key("channel.offset", ch), 0);
            await set(key("channel.scale", ch), snap125(cfg.amplitudeVpp / C.bode.fill_divisions));
          }
          await set("trigger.mode", "EDGE");
          await set("trigger.sweep", "AUTO");
          await set("trigger.edge.source", `CHANnel${cfg.inCh}`);
          await set("trigger.edge.slope", "POSitive");
          await set("trigger.edge.level", 0);
          await set("timebase.offset", 0);
          await set(key("source.output.state", g), true);
          await scope.scpi.write(":RUN");
          for (let i = 0; i < freqs.length && !this.stopRequested; i++) {
            const hz = freqs[i];
            await set(key("source.frequency", g), hz);
            const ideal = timebaseFor(hz, C.bode.periods_on_screen, C.instrument.divisions_x);
            let tb = snap125(ideal);
            if (tb < ideal * 0.999) tb = step125(tb, 1);
            const got = await set("timebase.scale", tb);
            const screen = Number(got.value) * C.instrument.divisions_x;
            let p: BodePoint | null = null;
            for (let attempt = 0; attempt <= C.bode.max_retries && !p; attempt++) {
              // Wait for the settings to settle and at least two fresh screens to be acquired.
              await sleep(Math.max(cfg.settleMs, 2 * screen * 1000));
              const a = await scope.readTrace(`CHANnel${cfg.inCh}`);
              const b = await scope.readTrace(`CHANnel${cfg.outCh}`);
              const again = (await this.rescale(scope, cfg.inCh, a.volts)) || (await this.rescale(scope, cfg.outCh, b.volts));
              if (again && attempt < C.bode.max_retries) continue;
              if (again) this.state.notes.push(`${hz.toPrecision(4)} Hz: a channel was still clipped or tiny after ${C.bode.max_retries} rescales`);
              const pa = phasor(a.volts, a.pre.xinc, hz, a.pre.xorigin);
              const pb = phasor(b.volts, b.pre.xinc, hz, b.pre.xorigin);
              p = point(hz, pa, pb);
            }
            this.state.points.push(p!);
            this.state.step = i + 1;
            this.state.corner = corner(this.state.points);
            publish(this.state);
          }
        } finally {
          // Put back what the user had, output state last so nothing is driven unexpectedly.
          const order = touched.filter((k) => !k.startsWith("source.output.state")).concat(touched.filter((k) => k.startsWith("source.output.state")));
          for (const k of order) {
            const v = saved[k];
            if (v === undefined || v === null) continue;
            await scope.write(k, v, true).catch(() => {});
          }
        }
      });
      if (this.stopRequested) this.state.notes.push("stopped before the last point");
    } catch (e) {
      this.state.error = (e as Error).message;
    } finally {
      this.state.running = false;
      publish(this.state);
    }
    return this.state;
  }

  /** Fit a channel to the record: true if its scale changed (clipped, or under ~1.5 divisions). */
  private async rescale(scope: ScopeService, ch: number, v: Float32Array): Promise<boolean> {
    const s = Number(scope.values.get(key("channel.scale", ch)) ?? 1);
    const e = extrema(v);
    const pp = e.max - e.min;
    const half = (C.instrument.divisions_y / 2) * s;
    const clipped = Math.max(Math.abs(e.max), Math.abs(e.min)) > half * 0.97;
    const tiny = pp < 1.5 * s;
    if (!clipped && !tiny) return false;
    let next = clipped ? step125(step125(s, 1), 1) : snap125(Math.max(pp / C.bode.fill_divisions, 1e-4));
    if (!clipped && next >= s) return false;
    if (next === s) return false;
    const r = await scope.write(key("channel.scale", ch), next, true);
    next = Number(r.value);
    return next !== s;
  }

  csv(): string {
    const rows = this.state.points.map((p) => `${p.hz},${p.gainDb.toFixed(4)},${p.phaseDeg.toFixed(3)},${p.vin.toPrecision(6)},${p.vout.toPrecision(6)}`);
    return `# ${C.app.name} Bode sweep ${this.state.startedAt ?? ""}; phase = out − in, lock-in on screen records\nfrequency_hz,gain_db,phase_deg,vin_peak_v,vout_peak_v\n${rows.join("\n")}\n`;
  }
}
