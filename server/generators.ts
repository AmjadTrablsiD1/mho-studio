// What drives the circuit during a Bode sweep. The sweep itself (bode.ts) does
// not care: it asks for a frequency, gets back the one actually produced, and
// measures both channels at that frequency.
//
//   scopeAfg    the MHO984's own GEN OUT (AFG50/AFG100 option), over SCPI
//   boardClock  a Si5351 output on the STM32H743 board, over its serial link
//   boardDac    the board's DAC1 sine on PC4 (through OPAMP1), same link
//
// "Actually produced" matters: the Si5351 lands a fraction of a hertz away
// from most requests, three outputs share two PLLs, and the DAC's frequency is
// a whole timer division over a table length — often hertz off. A sweep that
// drew the requested frequency would be right about the axis only by luck.

import { C } from "../core/src/constants.ts";
import { DRIVE_MA, dacSourceText, type ClkChannel, type DacStatus } from "../core/src/board/protocol.ts";
import { fmt } from "../core/src/format.ts";
import { key } from "../core/src/registry/controls.ts";
import type { BoardService } from "./board.ts";
import type { ScopeService } from "./scope.ts";

export type GeneratorInfo = {
  kind: "scope" | "board" | "dac";
  label: string;
  minHz: number;
  maxHz: number;
  /** How the scope channels should be coupled: the board's outputs sit on a DC level (Si5351 0–3.3 V, DAC 1.65 V), so it is taken off. */
  coupling: "DC" | "AC";
  /** Expected peak-to-peak at the input channel, for the first channel scale. */
  vpp: number;
};

export type Generator = {
  info: GeneratorInfo;
  /** Scope settings this generator changes; the sweep reads them first and puts them back. */
  keys: string[];
  prepare(startHz: number): Promise<void>;
  on(): Promise<void>;
  /** Move to hz; returns the frequency now being produced. */
  set(hz: number): Promise<number>;
  /** Put back anything outside the scope; returns notes for the result. */
  restore(): Promise<string[]>;
};

export function scopeAfg(scope: ScopeService, awg: number, vpp: number): Generator {
  const set = (k: string, v: number | string | boolean) => scope.write(k, v, true);
  return {
    info: { kind: "scope", label: `GEN OUT ${awg}`, minHz: C.bode.min_hz, maxHz: C.bode.max_hz, coupling: "DC", vpp },
    keys: [key("source.output.state", awg), key("source.function", awg), key("source.frequency", awg), key("source.voltage.amplitude", awg), key("source.voltage.offset", awg)],
    async prepare(startHz) {
      await set(key("source.function", awg), "SINusoid");
      await set(key("source.voltage.offset", awg), 0);
      await set(key("source.voltage.amplitude", awg), vpp);
      await set(key("source.frequency", awg), startHz);
    },
    async on() {
      await set(key("source.output.state", awg), true);
    },
    async set(hz) {
      const got = await set(key("source.frequency", awg), hz);
      const v = Number(got.value);
      return Number.isFinite(v) && v > 0 ? v : hz;
    },
    async restore() {
      return []; // the sweep restores the scope's own settings, output state last
    },
  };
}

export function boardClock(board: BoardService, ch: number, drive: number): Generator {
  const S = C.board.si5351;
  let saved: ClkChannel | null = null;
  let last = 0;
  return {
    info: { kind: "board", label: `STM32 board CLK${ch} (Si5351, ${DRIVE_MA[drive]} mA)`, minHz: S.min_hz, maxHz: S.max_hz, coupling: "AC", vpp: S.vpp },
    keys: [],
    async prepare(startHz) {
      saved = await board.get(ch);
      await board.drive(ch, drive);
      last = (await board.set(ch, startHz, false)).hz;
    },
    async on() {
      last = (await board.set(ch, last, true)).hz;
    },
    async set(hz) {
      last = (await board.set(ch, hz, true)).hz;
      return last;
    },
    async restore() {
      const notes: string[] = [];
      if (!saved) return notes;
      const s = saved;
      if (s.drive !== drive) await board.drive(ch, s.drive);
      // An output that had no frequency is left on the last one, switched off.
      await board.set(ch, s.hz > 0 ? s.hz : last, s.on);
      if (s.sweeping) notes.push(`An on-board sweep was stepping CLK${ch}; the Bode sweep stopped it. Start it again in Board Test GUI if you need it.`);
      return notes;
    },
  };
}

/**
 * DAC1's sine, centred on 1.65 V. Every frequency change restarts the table
 * (the firmware stops and replays), so the output glitches once per point —
 * the settle wait covers it. Whatever the DAC played before is reported, not
 * restarted: DacStatus does not say at what levels.
 */
export function boardDac(board: BoardService, vpp: number): Generator {
  const D = C.board.dac;
  let before: DacStatus | null = null;
  let last = 0;
  const play = async (hz: number) => {
    const r = await board.dacSine(hz, vpp / 2, D.offset_v);
    // The firmware clamps to 1 Hz – 60 kHz rather than refusing; a large miss means it did.
    if (Math.abs(r.hz / hz - 1) > 0.05) throw new Error(`the DAC made ${fmt(r.hz, "Hz", 4)} for ${fmt(hz, "Hz", 4)} — outside its ${fmt(D.min_hz, "Hz")} – ${fmt(D.max_hz, "Hz")}`);
    return r.hz;
  };
  return {
    info: { kind: "dac", label: `STM32 board DAC (${D.pin}, ${vpp} Vpp sine)`, minHz: D.min_hz, maxHz: D.max_hz, coupling: "AC", vpp },
    keys: [],
    async prepare(startHz) {
      before = await board.dacStatus();
      last = startHz;
    },
    async on() {
      last = await play(last);
    },
    async set(hz) {
      last = await play(hz);
      return last;
    },
    async restore() {
      await board.dacStop();
      const b = before;
      return b?.running ? [`The DAC was playing ${dacSourceText(b)} before the sweep; it is stopped now. Start it again in Board Test GUI if you need it.`] : [];
    },
  };
}
