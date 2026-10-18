// What is plugged into the simulated bench besides the scope itself. The
// simulated board (sim/board.ts) writes its output here; the simulated MHO984
// (sim/instrument.ts) reads it when it builds CH1 and CH2:
//
//   board output ──┬──────────────────────── CH1
//                  └── 2nd-order low-pass ── CH2
//
// in place of GEN OUT 1, as long as the board drives something: its DAC sine
// (PC4) when one is playing, else its lowest Si5351 output that is on. `gen`
// counts changes, so the scope rebuilds its source tables only when something moved.

export type BoardStimulus =
  | { kind: "clk"; ch: number; hz: number; vpp: number; riseS: number }
  | { kind: "dac"; hz: number; ampV: number; offsetV: number };

export const wiring: { board: BoardStimulus | null; gen: number } = { board: null, gen: 0 };

export function setBoardStimulus(c: BoardStimulus | null): void {
  if (JSON.stringify(wiring.board) === JSON.stringify(c)) return;
  wiring.board = c;
  wiring.gen++;
}
