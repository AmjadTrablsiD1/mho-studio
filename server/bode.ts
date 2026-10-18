// Frequency response: step a generator through the band, capture input and
// output channels together, and take gain and phase from the lock-in phasors
// of the two records (core/src/dsp/lockin.ts). The generator is the MHO984's
// own GEN OUT, a Si5351 output on the STM32 board, or the board's DAC sine
// (generators.ts); either way the point is plotted at the frequency the
// generator says it produced.
// Every setting the sweep touches is read first and put back afterwards.

import { C } from "../core/src/constants.ts";
import { key } from "../core/src/registry/controls.ts";
import { corner, cycleHz, plan, point, timebaseFor, type BodePoint, type Spacing } from "../core/src/dsp/bode.ts";
import { phasor } from "../core/src/dsp/lockin.ts";
import { extrema } from "../core/src/dsp/measure.ts";
import { fmt } from "../core/src/format.ts";
import { snap125, step125 } from "../core/src/wave/steps.ts";
import type { Value } from "../core/src/scpi/values.ts";
import type { BoardService } from "./board.ts";
import { boardClock, boardDac, scopeAfg, type Generator } from "./generators.ts";
import { HttpError, type ScopeService } from "./scope.ts";

/** scope: GEN OUT; board: a Si5351 CLK output; dac: the board's DAC1 sine (PC4). */
export type GeneratorKind = "scope" | "board" | "dac";

export type BodeConfig = {
  startHz: number;
  stopHz: number;
  points: number;
  spacing: Spacing;
  generator: GeneratorKind;
  amplitudeVpp: number;
  awg: number;
  /** Si5351 output 0–2 and drive code 0–3 (2/4/6/8 mA), for the board generator. */
  clk: number;
  drive: number;
  inCh: number;
  outCh: number;
  settleMs: number;
};

export type BodeState = {
  running: boolean;
  config: BodeConfig | null;
  /** What drove the circuit, in words ("GEN OUT 1", "STM32 board CLK0 …"). */
  generator: string | null;
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
  const generator: GeneratorKind = b.generator === "board" || b.generator === "dac" ? b.generator : "scope";
  const cfg: BodeConfig = {
    generator,
    startHz: n(b.startHz, generator === "board" ? C.bode.board_start_hz : C.bode.start_hz),
    stopHz: n(b.stopHz, generator === "dac" ? C.board.dac.max_hz : C.bode.stop_hz),
    points: Math.round(n(b.points, C.bode.points)),
    spacing: b.spacing === "lin" ? "lin" : "log",
    amplitudeVpp: n(b.amplitudeVpp, C.bode.amplitude_vpp),
    awg: Math.round(n(b.awg, C.bode.awg)),
    clk: Math.round(n(b.clk, 0)),
    drive: Math.round(n(b.drive, C.board.si5351.drive)),
    inCh: Math.round(n(b.inCh, C.bode.in_channel)),
    outCh: Math.round(n(b.outCh, C.bode.out_channel)),
    settleMs: n(b.settleMs, C.bode.settle_ms),
  };
  const [lo, hi, what] =
    generator === "board" ? [C.board.si5351.min_hz, C.board.si5351.max_hz, "for the Si5351"]
    : generator === "dac" ? [C.board.dac.min_hz, C.board.dac.max_hz, "for the board's DAC"]
    : [C.bode.min_hz, C.bode.max_hz, "for GEN OUT"];
  if (!(cfg.startHz >= lo && cfg.stopHz <= hi && cfg.startHz < cfg.stopHz)) throw new HttpError(400, `frequencies ${what} must satisfy ${fmt(lo, "Hz")} ≤ start < stop ≤ ${fmt(hi, "Hz")}`);
  if (!(cfg.points >= 2 && cfg.points <= 500)) throw new HttpError(400, "2–500 points");
  if (!(cfg.amplitudeVpp > 0 && cfg.amplitudeVpp <= 20)) throw new HttpError(400, "amplitude 0–20 Vpp");
  if (generator === "dac" && !(cfg.amplitudeVpp <= C.board.dac.max_vpp)) throw new HttpError(400, `the board's DAC swings at most ${C.board.dac.max_vpp} Vpp around ${C.board.dac.offset_v} V (it runs from 3.3 V)`);
  if (![1, 2].includes(cfg.awg)) throw new HttpError(400, "generator 1 or 2");
  if (!(cfg.clk >= 0 && cfg.clk < C.board.si5351.channels)) throw new HttpError(400, `board output CLK0–CLK${C.board.si5351.channels - 1}`);
  if (![0, 1, 2, 3].includes(cfg.drive)) throw new HttpError(400, "drive code 0–3 (2, 4, 6 or 8 mA)");
  if (![1, 2, 3, 4].includes(cfg.inCh) || ![1, 2, 3, 4].includes(cfg.outCh) || cfg.inCh === cfg.outCh) throw new HttpError(400, "two different input channels");
  return cfg;
}

export class BodeRunner {
  state: BodeState = { running: false, config: null, generator: null, points: [], step: 0, total: 0, error: null, corner: null, startedAt: null, notes: [] };
  private stopRequested = false;

  stop(): void {
    this.stopRequested = true;
  }

  /** Fails before anything is touched if the chosen generator cannot be used. */
  check(scope: ScopeService, cfg: BodeConfig, board: BoardService | null): void {
    if (cfg.generator === "scope" && !scope.has("AFG")) throw new HttpError(400, "the Bode sweep drives the built-in generator, which needs the AFG50 or AFG100 option — :SYSTem:OPTion:STATus? reports neither. The STM32 board's Si5351 can drive it instead.");
    if (cfg.generator !== "scope") {
      if (!board?.connected) throw new HttpError(409, "connect the STM32 board first (Bode sweep → Board)");
      if (board.state.busy) throw new HttpError(409, `the board is in use by the ${board.state.busy}`);
    }
  }

  async run(scope: ScopeService, cfg: BodeConfig, publish: (s: BodeState) => void, board: BoardService | null = null): Promise<BodeState> {
    this.check(scope, cfg, board);
    const gen: Generator =
      cfg.generator === "board" ? boardClock(board!, cfg.clk, cfg.drive)
      : cfg.generator === "dac" ? boardDac(board!, cfg.amplitudeVpp)
      : scopeAfg(scope, cfg.awg, cfg.amplitudeVpp);
    const freqs = plan(cfg.startHz, cfg.stopHz, cfg.points, cfg.spacing);
    this.stopRequested = false;
    this.state = { running: true, config: cfg, generator: gen.info.label, points: [], step: 0, total: freqs.length, error: null, corner: null, startedAt: new Date().toISOString(), notes: [] };
    publish(this.state);
    const touched = [
      ...gen.keys,
      ...[cfg.inCh, cfg.outCh].flatMap((ch) => [key("channel.display", ch), key("channel.scale", ch), key("channel.offset", ch), key("channel.coupling", ch)]),
      "timebase.scale", "timebase.offset", "trigger.mode", "trigger.sweep", "trigger.edge.source", "trigger.edge.slope", "trigger.edge.level",
    ];
    const sweep = () => scope.withBusy("Bode sweep", async () => {
      const saved = await scope.readKeys(touched);
      const set = (k: string, v: Value) => scope.write(k, v, true);
      try {
        await gen.prepare(freqs[0]);
        for (const ch of [cfg.inCh, cfg.outCh]) {
          await set(key("channel.display", ch), true);
          await set(key("channel.coupling", ch), gen.info.coupling);
          await set(key("channel.offset", ch), 0);
          await set(key("channel.scale", ch), snap125(gen.info.vpp / C.bode.fill_divisions));
        }
        await set("trigger.mode", "EDGE");
        await set("trigger.sweep", "AUTO");
        await set("trigger.edge.source", `CHANnel${cfg.inCh}`);
        await set("trigger.edge.slope", "POSitive");
        await set("trigger.edge.level", 0);
        await set("timebase.offset", 0);
        await gen.on();
        await scope.scpi.write(":RUN");
        let warned = false;
        for (let i = 0; i < freqs.length && !this.stopRequested; i++) {
          const hz = await gen.set(freqs[i]);
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
            // The input channel must show the generator: a channel wired to nothing still yields a "gain".
            const seen = cycleHz(a.volts, a.pre.xinc);
            if (seen === null || Math.abs(seen / hz - 1) > C.bode.wiring_tolerance) {
              const msg = `CH${cfg.inCh} shows ${seen === null ? "no repeating signal" : fmt(seen, "Hz", 4)}, not the ${fmt(hz, "Hz", 4)} from ${gen.info.label} — is the generator wired to CH${cfg.inCh}?`;
              if (i === 0) throw new HttpError(409, msg);
              if (!warned) this.state.notes.push(msg);
              warned = true;
            }
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
        // Put back what the user had, output state last so nothing is driven unexpectedly; then the generator's own.
        const order = touched.filter((k) => !k.startsWith("source.output.state")).concat(touched.filter((k) => k.startsWith("source.output.state")));
        for (const k of order) {
          const v = saved[k];
          if (v === undefined || v === null) continue;
          await scope.write(k, v, true).catch(() => {});
        }
        try {
          this.state.notes.push(...(await gen.restore()));
        } catch (e) {
          this.state.notes.push(`${gen.info.label} could not be put back: ${(e as Error).message}`);
        }
      }
    });
    try {
      await (cfg.generator !== "scope" ? board!.withBusy("Bode sweep", sweep) : sweep());
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
    return `# ${C.app.name} Bode sweep ${this.state.startedAt ?? ""}; generator ${this.state.generator ?? "?"}; frequency_hz is what the generator reported it produced; phase = out − in, lock-in on screen records\nfrequency_hz,gain_db,phase_deg,vin_peak_v,vout_peak_v\n${rows.join("\n")}\n`;
  }
}
