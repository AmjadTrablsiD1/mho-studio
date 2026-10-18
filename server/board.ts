// The STM32H743 board as a signal source: its Si5351 clock generator or its
// DAC1 sine (PC4 through OPAMP1), set over the board's own command link (USART1 through the CH340, protocol in
// core/src/board/protocol.ts). MHO Studio uses it as a Bode generator
// (server/generators.ts); everything else on the board stays Board Test GUI's.
//
// The port is opened exclusively. Two programs on one UART do not take turns —
// they eat each other's bytes, which looks like a board that answers nothing.
// So a busy port is refused with the name of the likely other owner, and the
// app holds the port only between Connect and Disconnect.

import { C } from "../core/src/constants.ts";
import { fmt } from "../core/src/format.ts";
import {
  AckReader, Cmd, DRIVE_MA, Status, decodeClkFreq, decodeClkInit, decodeDacSine, decodeDacStatus, decodeVersion, encodeChannel, encodeClkDrive, encodeClkFreq,
  encodeClkInit, encodeDacSine, encodeDacStop, packCmd, statusText, type Ack, type ClkChannel, type ClkInit, type DacSine, type DacStatus, type Version,
} from "../core/src/board/protocol.ts";
import { SimBoard } from "../sim/board.ts";
import { HttpError } from "./errors.ts";
import { log } from "./log.ts";

/** A byte pipe to the board: a serial port, or the simulated board. */
export type BoardPort = {
  write(b: Uint8Array): Promise<void>;
  setBaud(baud: number): Promise<void>;
  close(): Promise<void>;
  onData: (b: Uint8Array) => void;
  onClose: (why: string) => void;
};

export type BoardPortInfo = { path: string; label: string; likely: boolean };

export type BoardState = {
  state: "idle" | "connecting" | "connected" | "error";
  port: string | null;
  sim: boolean;
  baud: number | null;
  version: Version | null;
  /** null until the Si5351 has been asked (Detect, or the first frequency set). */
  si5351: (ClkInit & { checked: string }) | null;
  clk: ClkChannel[];
  /** What DAC1 is playing (both channels, PC4 and PA5); for a sine, the frequency it produces. */
  dac: (DacStatus & { hz: number | null }) | null;
  /** Who has the board right now ("Bode sweep"), or null. */
  busy: string | null;
  error: string | null;
  /** The newest lines of the firmware's printf() log, which shares the wire. */
  log: string[];
};

export class BoardError extends HttpError {}

// ---------------------------------------------------------------- serial

type SerialMod = {
  SerialPort: {
    new (o: { path: string; baudRate: number; autoOpen: boolean; lock?: boolean; hupcl?: boolean }): SerialDev;
    list(): Promise<{ path: string; manufacturer?: string; vendorId?: string; productId?: string; serialNumber?: string; friendlyName?: string }[]>;
  };
};
type SerialDev = {
  open(cb: (e: Error | null) => void): void;
  close(cb: (e: Error | null) => void): void;
  write(b: Uint8Array, cb: (e: Error | null | undefined) => void): boolean;
  drain(cb: (e: Error | null) => void): void;
  set(o: { dtr?: boolean; rts?: boolean }, cb: (e: Error | null) => void): void;
  update(o: { baudRate: number }, cb: (e: Error | null) => void): void;
  on(ev: "data", f: (b: Buffer) => void): void;
  on(ev: "close" | "error", f: (e?: Error) => void): void;
  isOpen: boolean;
};

let serial: { mod: SerialMod | null; error: string | null } | null = null;

async function loadSerial(): Promise<{ mod: SerialMod | null; error: string | null }> {
  if (serial) return serial;
  // Tests run beside real hardware: with this set, no real serial port is listed or opened.
  if (process.env.MHO_STUDIO_NO_SERIAL) return (serial = { mod: null, error: "Serial support did not load (switched off: MHO_STUDIO_NO_SERIAL is set, as in the tests)." });
  try {
    const m = (await import("serialport")) as unknown as SerialMod & { default?: SerialMod };
    serial = { mod: m.SerialPort ? m : (m.default as SerialMod), error: null };
  } catch (e) {
    serial = { mod: null, error: `Serial support did not load (${(e as Error).message}). Run the installer again; the simulated board still works.` };
  }
  return serial;
}

const cb = <T = void>(f: (done: (e: Error | null | undefined, v?: T) => void) => void) =>
  new Promise<T>((ok, no) => f((e, v) => (e ? no(e) : ok(v as T))));

/** A refusal to open, in words that say what to do about it. */
export function openError(path: string, e: Error): string {
  const m = e.message;
  if (/busy|lock|EBUSY|EACCES|Access denied|in use/i.test(m)) return `${path} is already open in another program — close Board Test GUI, Loop Bench or any serial monitor, then connect again.`;
  if (/ENOENT|No such file|cannot find|File not found/i.test(m)) return `${path} is gone — was the board unplugged?`;
  return `could not open ${path}: ${m}`;
}

async function openSerial(path: string, baud: number): Promise<BoardPort> {
  const { mod, error } = await loadSerial();
  if (!mod) throw new BoardError(503, error ?? "serial support is not available");
  const dev = new mod.SerialPort({ path, baudRate: baud, autoOpen: false, lock: true, hupcl: false });
  try {
    await cb((d) => dev.open(d));
  } catch (e) {
    throw new BoardError(409, openError(path, e as Error));
  }
  // This board wires the CH340's DTR to BOOT0. It is sampled only at reset, so
  // a running board does not care; held low, a reset with the app connected
  // still boots the firmware rather than the ROM bootloader (as Board Test GUI does).
  await cb((d) => dev.set({ dtr: false, rts: false }, d)).catch(() => {});
  const port: BoardPort = {
    write: (b) => cb((d) => dev.write(b, (e) => (e ? d(e) : dev.drain(d)))),
    setBaud: (b) => cb((d) => dev.update({ baudRate: b }, d)),
    close: () => (dev.isOpen ? cb((d) => dev.close(d)).catch(() => {}) : Promise.resolve()),
    onData: () => {},
    onClose: () => {},
  };
  dev.on("data", (b) => port.onData(new Uint8Array(b)));
  dev.on("close", (e) => port.onClose(e ? e.message : "closed"));
  dev.on("error", (e) => log(`board: ${e?.message}`));
  return port;
}

/** The simulated board behind a BoardPort, so the rest of the app cannot tell. */
export function simPort(board: SimBoard): BoardPort {
  const port: BoardPort = {
    write: async (b) => board.write(b),
    setBaud: async (b) => {
      board.hostBaud = b;
    },
    close: async () => board.close(),
    onData: () => {},
    onClose: () => {},
  };
  board.onData = (b) => port.onData(b);
  return port;
}

export const SIM_PATH = "sim";

export async function listBoardPorts(): Promise<{ available: boolean; error: string | null; ports: BoardPortInfo[] }> {
  const sim: BoardPortInfo = { path: SIM_PATH, label: "Simulated board (Si5351 on the simulated bench)", likely: false };
  const { mod, error } = await loadSerial();
  if (!mod) return { available: false, error, ports: [sim] };
  try {
    const ids = C.board.usb_ids;
    const list = (await mod.SerialPort.list())
      .filter((p) => !/Bluetooth|debug-console|wlan-debug/i.test(p.path))
      .map((p) => {
        const id = ids.find((u) => u.vendor === (p.vendorId ?? "").toLowerCase() && u.product === (p.productId ?? "").toLowerCase());
        // macOS lists /dev/tty.*, which waits for carrier on open; /dev/cu.* is the one to use.
        const path = process.platform === "darwin" ? p.path.replace(/^\/dev\/tty\./, "/dev/cu.") : p.path;
        const what = id ? `${id.name} USB-serial` : (p.manufacturer || p.friendlyName || "serial port");
        return { path, label: `${path} — ${what}`, likely: !!id };
      })
      .sort((a, b) => Number(b.likely) - Number(a.likely) || a.path.localeCompare(b.path));
    return { available: true, error: null, ports: [...list, sim] };
  } catch (e) {
    return { available: false, error: `could not list serial ports: ${(e as Error).message}`, ports: [sim] };
  }
}

// ---------------------------------------------------------------- link

/** One command at a time, each answered by the ACK that echoes its sequence number. */
export class BoardLink {
  private seq = 0;
  private chain: Promise<unknown> = Promise.resolve();
  private waiting: { seq: number; done: (a: Ack) => void } | null = null;
  private reader = new AckReader();
  readonly port: BoardPort;
  onText: (line: string) => void = () => {};

  constructor(port: BoardPort) {
    this.port = port;
    this.reader.onAck = (a) => {
      // An ACK for an older, timed-out command is not this one's answer.
      if (this.waiting && a.seq === this.waiting.seq) this.waiting.done(a);
    };
    this.reader.onText = (l) => this.onText(l);
    port.onData = (b) => this.reader.push(b);
  }

  command(cmd: number, payload?: Uint8Array, timeoutMs: number = C.board.command_timeout_ms): Promise<Ack> {
    const run = async () => {
      this.seq = (this.seq + 1) & 0xffff;
      const seq = this.seq;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const reply = new Promise<Ack>((ok, no) => {
        this.waiting = { seq, done: ok };
        timer = setTimeout(() => no(new BoardError(504, `the board did not answer command 0x${cmd.toString(16).padStart(2, "0")} within ${timeoutMs} ms`)), timeoutMs);
      });
      try {
        await this.port.write(packCmd(cmd, seq, payload));
        return await reply;
      } finally {
        clearTimeout(timer);
        this.waiting = null;
      }
    };
    const p = this.chain.then(run, run);
    this.chain = p.catch(() => {});
    return p;
  }
}

// ---------------------------------------------------------------- service

const idle = (): BoardState => ({ state: "idle", port: null, sim: false, baud: null, version: null, si5351: null, clk: [], dac: null, busy: null, error: null, log: [] });

export class BoardService {
  state: BoardState = idle();
  private link: BoardLink | null = null;
  private publish: (s: BoardState) => void;
  /** The simulated board, when that is what is connected (tests reach in). */
  sim: SimBoard | null = null;
  /** For tests: how a simulated board is made. */
  simFactory: () => SimBoard = () => new SimBoard();

  constructor(publish: (s: BoardState) => void = () => {}) {
    this.publish = publish;
  }

  get connected(): boolean {
    return this.state.state === "connected" && !!this.link;
  }

  private update(p: Partial<BoardState>): void {
    this.state = { ...this.state, ...p };
    this.publish(this.state);
  }

  async connect(path: string): Promise<BoardState> {
    if (this.state.busy) throw new BoardError(409, `the board is in use by the ${this.state.busy}`);
    await this.disconnect();
    const sim = path === SIM_PATH;
    this.update({ ...idle(), state: "connecting", port: path, sim });
    let port: BoardPort | null = null;
    try {
      if (sim) {
        this.sim = this.simFactory();
        port = simPort(this.sim);
      } else port = await openSerial(path, C.board.baud);
      const link = new BoardLink(port);
      link.onText = (l) => {
        const lines = [...this.state.log, l].slice(-C.board.log_lines);
        this.state = { ...this.state, log: lines };
      };
      // A host that changed the speed and died leaves the board at that speed: try them all.
      let baud: number | null = null;
      for (const b of C.board.bauds) {
        await port.setBaud(b);
        try {
          const a = await link.command(Cmd.Ping, new TextEncoder().encode("mhostud!"), C.board.probe_timeout_ms);
          if (a.status === Status.Ok) {
            baud = b;
            break;
          }
        } catch {
          /* the wrong speed: nothing comes back */
        }
      }
      if (baud === null) throw new BoardError(504, `nothing answered on ${path} at any speed (${C.board.bauds.join(", ")} baud). Is it the board's COM port (the CH340), and is the firmware running?`);
      const v = await link.command(Cmd.GetVersion);
      const version = decodeVersion(v.payload);
      if (version.protocol < C.board.min_protocol) throw new BoardError(400, `the board's firmware speaks protocol v${version.protocol}; the Si5351 commands need v${C.board.min_protocol} or newer — flash the current firmware`);
      this.link = link;
      port.onClose = (why) => {
        if (this.link !== link) return;
        this.link = null;
        this.update({ state: "error", error: `the board's port closed (${why}) — unplugged?`, busy: null });
      };
      this.update({ state: "connected", baud, version, error: null });
      await this.refresh();
      log(`board: connected on ${path} at ${baud} baud, protocol v${version.protocol}, firmware ${version.firmware} built ${version.built}`);
      return this.state;
    } catch (e) {
      this.link = null;
      await port?.close().catch(() => {});
      this.sim = null;
      this.update({ state: "error", error: (e as Error).message });
      throw e instanceof HttpError ? e : new BoardError(502, (e as Error).message);
    }
  }

  async disconnect(): Promise<void> {
    if (this.state.busy) throw new BoardError(409, `the board is in use by the ${this.state.busy}`);
    const link = this.link;
    this.link = null;
    this.sim = null;
    if (link) await link.port.close().catch(() => {});
    if (this.state.state !== "idle") this.update(idle());
  }

  private need(): BoardLink {
    if (!this.link) throw new BoardError(409, "the STM32 board is not connected");
    return this.link;
  }

  /** Every output as the board now has it. */
  async refresh(): Promise<ClkChannel[]> {
    const link = this.need();
    const clk: ClkChannel[] = [];
    for (let ch = 0; ch < C.board.si5351.channels; ch++) {
      const a = await link.command(Cmd.ClkGet, encodeChannel(ch));
      if (a.status !== Status.Ok) throw new BoardError(502, `ClkGet CLK${ch}: ${statusText(a.status)}`);
      clk.push(decodeClkFreq(a.payload));
    }
    this.update({ clk });
    await this.dacStatus();
    return clk;
  }

  /** What DAC1 plays now. */
  async dacStatus(): Promise<DacStatus> {
    const a = await this.need().command(Cmd.DacStatus);
    if (a.status !== Status.Ok) throw new BoardError(502, `DacStatus: ${statusText(a.status)}`);
    const d = decodeDacStatus(a.payload);
    this.update({ dac: { ...d, hz: d.running && d.source === 2 && d.length ? d.rateHz / d.length : null } });
    return d;
  }

  /** A sine on DAC1 (PC4 buffered, PA5 direct): peak and centre in volts. Returns what it produces. */
  async dacSine(hz: number, peakV: number, offsetV: number): Promise<DacSine> {
    const a = await this.need().command(Cmd.DacSine, encodeDacSine(hz, peakV * 1000, offsetV * 1000));
    if (a.status === Status.Busy) throw new BoardError(409, "the board's DAC is in use — a control-loop run (Loop Bench) or the board's own sweep holds it; stop that first");
    if (a.status !== Status.Ok) throw new BoardError(502, `DAC sine: ${statusText(a.status)}`);
    const r = decodeDacSine(a.payload);
    this.update({ dac: { running: true, source: 2, length: r.rateHz && r.hz ? Math.round(r.rateHz / r.hz) : 0, rateHz: r.rateHz, hz: r.hz } });
    return r;
  }

  async dacStop(): Promise<void> {
    const a = await this.need().command(Cmd.DacPlay, encodeDacStop());
    if (a.status !== Status.Ok) throw new BoardError(502, `DAC stop: ${statusText(a.status)}`);
    this.update({ dac: { ...decodeDacStatus(a.payload), hz: null } });
  }

  /** Probe the Si5351 (and re-apply every output, as the firmware does on ClkInit). */
  async detect(xtalHz: number = C.board.si5351.xtal_hz, load: number = C.board.si5351.load): Promise<BoardState> {
    if (this.state.busy) throw new BoardError(409, `the board is in use by the ${this.state.busy}`);
    if (!C.board.si5351.xtals_hz.includes(xtalHz)) throw new BoardError(400, `crystal ${xtalHz} Hz: use ${C.board.si5351.xtals_hz.join(" or ")}`);
    if (![0, 1, 2].includes(load)) throw new BoardError(400, "load code 0, 1 or 2 (6, 8 or 10 pF)");
    const a = await this.need().command(Cmd.ClkInit, encodeClkInit(xtalHz, load, C.board.si5351.address));
    const init = decodeClkInit(a.payload);
    this.update({ si5351: { ...init, checked: new Date().toISOString() } });
    if (a.status === Status.Ok) await this.refresh();
    return this.state;
  }

  async get(ch: number): Promise<ClkChannel> {
    const a = await this.need().command(Cmd.ClkGet, encodeChannel(ch));
    if (a.status !== Status.Ok) throw new BoardError(502, `CLK${ch}: ${statusText(a.status)}`);
    return this.store(decodeClkFreq(a.payload));
  }

  /** Set an output; the reply is what it now makes, which is what the caller must use. */
  async set(ch: number, hz: number, on: boolean): Promise<ClkChannel> {
    const a = await this.need().command(Cmd.ClkFreq, encodeClkFreq(ch, hz, on));
    if (a.status === Status.HwError) {
      this.update({ si5351: { present: false, status: 0xff, address: C.board.si5351.address, i2cErrors: 0, xtalHz: 0, checked: new Date().toISOString() } });
      throw new BoardError(502, `no Si5351 answered at 0x${C.board.si5351.address.toString(16)} on I²C2 (P1 pins 12 SCL / 13 SDA, 3.3 V on pin 1) — check the module, then press Detect`);
    }
    if (a.status === Status.InvalidParam) throw new BoardError(400, `CLK${ch} cannot make ${fmt(hz, "Hz", 6)}: the Si5351 covers ${fmt(C.board.si5351.min_hz, "Hz")} – ${fmt(C.board.si5351.max_hz, "Hz")}, and both PLLs may be held by the other outputs`);
    if (a.status !== Status.Ok) throw new BoardError(502, `CLK${ch}: ${statusText(a.status)}`);
    const c = this.store(decodeClkFreq(a.payload));
    if (!this.state.si5351?.present) this.update({ si5351: { present: true, status: 0, address: C.board.si5351.address, i2cErrors: 0, xtalHz: this.state.si5351?.xtalHz ?? 0, checked: new Date().toISOString() } });
    if (c.unreachable) throw new BoardError(409, `CLK${ch} cannot reach ${fmt(hz, "Hz", 6)} while the other two outputs hold both PLLs — switch one of them off (Board Test GUI → Clocks)`);
    return c;
  }

  async drive(ch: number, drive: number): Promise<number> {
    const a = await this.need().command(Cmd.ClkDrive, encodeClkDrive(ch, drive));
    if (a.status !== Status.Ok) throw new BoardError(400, `CLK${ch} drive ${DRIVE_MA[drive] ?? drive} mA: ${statusText(a.status)}`);
    const c = this.state.clk[ch];
    if (c) this.store({ ...c, drive: a.payload[1] });
    return a.payload[1];
  }

  private store(c: ClkChannel): ClkChannel {
    const clk = [...this.state.clk];
    clk[c.ch] = c;
    this.update({ clk });
    return c;
  }

  /** Hold the board for one job; Connect, Disconnect and Detect wait their turn. */
  async withBusy<T>(label: string, f: () => Promise<T>): Promise<T> {
    if (this.state.busy) throw new BoardError(409, `the board is in use by the ${this.state.busy}`);
    this.need();
    this.update({ busy: label });
    try {
      return await f();
    } finally {
      this.update({ busy: null });
    }
  }
}
