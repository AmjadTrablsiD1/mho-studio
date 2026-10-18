// A simulated STM32H743 board with a Si5351 on I2C2 and the DAC1 sine,
// answering the subset of the firmware's command link that MHO Studio uses
// (core/src/board/protocol.ts).
// Its output goes onto the simulated bench (sim/wiring.ts), so a Bode sweep on
// "Simulated board" + "Simulated MHO984" measures the same 20 kHz filter the
// GEN OUT sweep does.
//
// The Si5351 plan is an approximation of the firmware's: an even integer
// output divider, a VCO in 600–900 MHz, a fractional feedback divider with a
// 2^20−1 denominator, and an R divider below 500 kHz. That is enough for the
// achieved frequency to differ from the requested one by a fraction of a hertz
// — which is the point: the sweep must use what the board reports. The DAC sine
// is modelled the way dac_play.cpp chooses it: a table of ~400 kHz / f entries
// (16–1024), a timer rate that is a whole division of 240 MHz, and the
// frequency = rate / length — often a few hertz off the request.

import { C } from "../core/src/constants.ts";
import {
  Cmd, Status, PACKET, encodeClkFlags, encodeDacSineReply, encodeDacStatus, encodeVersion, getU48, packAck, parseCmd, putU48, type DacStatus,
} from "../core/src/board/protocol.ts";
import { setBoardStimulus } from "./wiring.ts";

type Chan = { on: boolean; hz: number; drive: number; integer: boolean; valid: boolean; sweeping: boolean; dwell: number; step: number };

export type SimBoardOptions = {
  /** Si5351 plugged in. */
  si5351?: boolean;
  /** The speed the board's UART is at (a host that changed it and died leaves it there). */
  baud?: number;
  /** Drop this many replies (the board was busy and missed the command). */
  drop?: number;
  protocol?: number;
  /** Put the output on the simulated bench. Off in tests that run two boards. */
  wire?: boolean;
  /** The DAC is held by a control-loop run or the on-board sweep (DacSine answers Busy). */
  dacBusy?: boolean;
  /** What the DAC is playing at power-up. */
  dac?: DacStatus;
};

/** What the Si5351 would make for f with this crystal; null if out of range. */
export function planSi5351(xtalHz: number, f: number): { hz: number; integer: boolean } | null {
  const S = C.board.si5351;
  if (!(f >= S.min_hz && f <= S.max_hz)) return null;
  let r = 1;
  while (f * r < 500e3 && r < 128) r *= 2;
  const fo = f * r;
  let ms = Math.max(4, Math.ceil(600e6 / fo));
  if (ms % 2) ms++;
  if (ms * fo > 900e6) ms -= 2;
  const c = 1048575;
  const mult = (ms * fo) / xtalHz;
  const a = Math.floor(mult);
  const b = Math.round((mult - a) * c);
  const hz = Math.round(((xtalHz * (a + b / c)) / ms / r) * 100) / 100;
  return { hz, integer: b === 0 };
}

/** What dac_play.cpp's start_sine makes for f: clamped, table length and timer rate chosen together. */
export function planDacSine(f: number): { hz: number; rateHz: number; length: number } {
  const D = C.board.dac;
  const hz = Math.min(D.max_hz, Math.max(D.min_hz, f));
  const n = Math.min(D.max_len, Math.max(D.min_len, Math.round(D.target_fs / hz)));
  const want = Math.round(hz * n);
  const rateHz = Math.round(D.timer_hz / Math.max(1, Math.round(D.timer_hz / want)));
  return { hz: Math.fround(rateHz / n), rateHz, length: n };
}

export class SimBoard {
  onData: (b: Uint8Array) => void = () => {};
  readonly log: { cmd: number; payload: Uint8Array }[] = [];
  hostBaud = C.board.baud;
  boardBaud: number;
  present: boolean;
  xtalHz = C.board.si5351.xtal_hz;
  load = C.board.si5351.load;
  address = C.board.si5351.address;
  drop: number;
  dacBusy: boolean;
  dac: DacStatus;
  /** The sine's levels, which DacStatus does not report. */
  dacLevels = { ampMv: 0, offsetMv: 0, hz: 0 };
  chans: Chan[] = Array.from({ length: C.board.si5351.channels }, () => ({ on: false, hz: 0, drive: 0, integer: false, valid: false, sweeping: false, dwell: 0, step: 0 }));
  private rx = new Uint8Array(0);
  private closed = false;
  private protocol: number;
  private wire: boolean;

  constructor(o: SimBoardOptions = {}) {
    this.present = o.si5351 ?? true;
    this.boardBaud = o.baud ?? C.board.baud;
    this.drop = o.drop ?? 0;
    this.protocol = o.protocol ?? C.board.sim.protocol;
    this.wire = o.wire ?? true;
    this.dacBusy = o.dacBusy ?? false;
    this.dac = o.dac ?? { running: false, source: 0, length: 0, rateHz: 0 };
    this.chans[0] = { ...this.chans[0], hz: 10e6, valid: true, integer: true };
  }

  write(b: Uint8Array): void {
    if (this.closed) return;
    // At the wrong speed the board sees framing errors, not packets.
    if (this.hostBaud !== this.boardBaud) return;
    const all = new Uint8Array(this.rx.length + b.length);
    all.set(this.rx);
    all.set(b, this.rx.length);
    let i = 0;
    while (all.length - i >= PACKET) {
      const p = parseCmd(all.subarray(i, i + PACKET));
      if (!p) {
        i++;
        continue;
      }
      i += PACKET;
      this.handle(p.seq, p.cmd, p.payload);
    }
    this.rx = all.slice(i);
  }

  close(): void {
    this.closed = true;
    if (this.wire) setBoardStimulus(null);
  }

  private send(b: Uint8Array): void {
    setTimeout(() => !this.closed && this.onData(b), C.board.sim.latency_ms);
  }

  private text(s: string): void {
    this.send(new TextEncoder().encode(s + "\r\n"));
  }

  private handle(seq: number, cmd: number, p: Uint8Array): void {
    this.log.push({ cmd, payload: p });
    if (this.drop > 0) {
      this.drop--;
      return;
    }
    const out = new Uint8Array(8);
    let st: number = Status.Ok;
    const ch = p[0];
    const chan = (n: number) => this.chans[n];
    const describe = (n: number) => {
      const c = chan(n);
      out[0] = n;
      out[1] = encodeClkFlags({ on: c.on, pllB: n > 0, integer: c.integer, shared: false, unreachable: c.on && !c.valid, sweeping: c.sweeping, drive: c.drive });
      putU48(out, 2, c.valid ? c.hz * 100 : 0);
    };
    switch (cmd) {
      case Cmd.Ping:
        out.set(p);
        break;
      case Cmd.GetVersion: {
        const [day, month, year] = C.board.sim.built;
        out.set(encodeVersion({ protocol: this.protocol, firmware: C.board.sim.firmware, day, month, year }));
        break;
      }
      case Cmd.DacSine: {
        if (this.dacBusy) {
          st = Status.Busy;
          break;
        }
        const v = new DataView(p.buffer, p.byteOffset, 8);
        const plan = planDacSine(v.getFloat32(0, true));
        this.dac = { running: true, source: 2, length: plan.length, rateHz: plan.rateHz };
        this.dacLevels = { ampMv: v.getUint16(4, true), offsetMv: v.getUint16(6, true), hz: plan.hz };
        out.set(encodeDacSineReply({ hz: plan.hz, rateHz: plan.rateHz }));
        break;
      }
      case Cmd.DacPlay:
      case Cmd.DacStatus: {
        if (cmd === Cmd.DacPlay) {
          if (p[0] && this.dacBusy) {
            st = Status.Busy;
            break;
          }
          this.dac = p[0] ? { running: true, source: 1, length: 4096, rateHz: new DataView(p.buffer, p.byteOffset, 8).getUint32(4, true) || 100000 } : { running: false, source: 0, length: 0, rateHz: 0 };
        }
        out.set(encodeDacStatus(this.dac));
        break;
      }
      case Cmd.ClkInit: {
        const v = new DataView(p.buffer, p.byteOffset, 8);
        if (this.present) {
          this.xtalHz = v.getUint32(0, true) || C.board.si5351.xtal_hz;
          this.load = p[4];
          this.address = p[5] || C.board.si5351.address;
          for (const c of this.chans) if (c.valid) this.retune(c, c.hz);
        } else st = Status.HwError;
        out[0] = this.present ? 1 : 0;
        out[1] = this.present ? 0x01 : 0xff;
        out[2] = this.address;
        out[3] = this.present ? 0 : 1;
        new DataView(out.buffer).setUint32(4, this.xtalHz, true);
        break;
      }
      case Cmd.ClkFreq:
      case Cmd.ClkGet: {
        if (ch >= this.chans.length) {
          st = Status.InvalidParam;
          break;
        }
        if (cmd === Cmd.ClkFreq) {
          if (!this.present) {
            st = Status.HwError;
            break;
          }
          const want = getU48(p, 2) / 100;
          const c = chan(ch);
          const plan = planSi5351(this.xtalHz, want);
          if (!plan) {
            st = Status.InvalidParam;
            break;
          }
          c.sweeping = false; // the last instruction about a frequency wins
          c.hz = plan.hz;
          c.integer = plan.integer;
          c.valid = true;
          c.on = (p[1] & 1) !== 0;
          this.text(`SI5351: CLK${ch} ${c.on ? "on" : "off"} at ${plan.hz.toFixed(2)} Hz`);
        }
        describe(ch);
        break;
      }
      case Cmd.ClkDrive: {
        if (ch >= this.chans.length || p[1] > 3) {
          st = Status.InvalidParam;
          break;
        }
        chan(ch).drive = p[1];
        out[0] = ch;
        out[1] = p[1];
        out[2] = this.chans.reduce((m, c, i) => (c.on && c.valid ? m | (1 << i) : m), 0);
        break;
      }
      case Cmd.ClkSweep: {
        if (ch >= this.chans.length) {
          st = Status.InvalidParam;
          break;
        }
        const v = new DataView(p.buffer, p.byteOffset, 8);
        const c = chan(ch);
        c.sweeping = p[1] !== 0;
        c.dwell = v.getUint16(2, true);
        c.step = v.getInt32(4, true);
        out[0] = ch;
        out[1] = c.sweeping ? 1 : 0;
        new DataView(out.buffer).setUint16(2, c.dwell, true);
        new DataView(out.buffer).setInt32(4, c.step, true);
        break;
      }
      default:
        st = Status.UnknownCmd;
    }
    this.publish();
    this.send(packAck(seq, cmd, st, out));
  }

  private retune(c: Chan, hz: number): void {
    const plan = planSi5351(this.xtalHz, hz);
    if (plan) {
      c.hz = plan.hz;
      c.integer = plan.integer;
    }
  }

  /** The DAC sine when it plays, else the lowest CLK output that is on, drives the bench (the pin wired to the tee). */
  private publish(): void {
    if (!this.wire) return;
    if (this.dac.running && this.dac.source === 2) {
      return setBoardStimulus({ kind: "dac", hz: this.dacLevels.hz, ampV: this.dacLevels.ampMv / 1000, offsetV: this.dacLevels.offsetMv / 1000 });
    }
    const i = this.chans.findIndex((c) => c.on && c.valid);
    if (i < 0 || !this.present) return setBoardStimulus(null);
    const c = this.chans[i];
    setBoardStimulus({ kind: "clk", ch: i, hz: c.hz, vpp: C.board.si5351.vpp, riseS: C.board.sim.rise_s * (8 / (2 + 2 * c.drive)) });
  }
}
