// The STM32H743 board's command link (firmware: Core/Inc/test_protocol.hpp in
// ~/Desktop/Projects_Git/STM32H743/H743_CORE_V13_Cpp). MHO Studio uses only the
// Si5351 commands, the DAC sine and the version query; Board Test GUI speaks the rest.
//
// 16 bytes each way, little-endian:
//
//   CMD (host -> board)          ACK (board -> host)
//     0  4  magic 0xC0DE5A5A       0  4  magic 0xACED5A5A
//     4  2  seq                    4  2  seq echo
//     6  1  cmd_id                 6  1  cmd_id echo
//     7  1  flags (0)              7  1  status
//     8  8  payload                8  8  payload
//
// The same UART carries the firmware's printf() log and, for some commands,
// bulk data frames (magic 0xDA7A5A5A, u16 seq, u16 bytes, u32 CRC, payload).
// The reader scans for the magics and treats everything else as log text.

export const CMD_MAGIC = 0xc0de5a5a;
export const ACK_MAGIC = 0xaced5a5a;
export const DATA_MAGIC = 0xda7a5a5a;
export const PACKET = 16;
export const PAYLOAD = 8;
const DATA_HEADER = 12;

export const Cmd = {
  Ping: 0x01,
  GetVersion: 0x02,
  DacPlay: 0x30,
  DacStatus: 0x31,
  DacSine: 0x32,
  ClkInit: 0x70,
  ClkFreq: 0x71,
  ClkGet: 0x72,
  ClkDrive: 0x73,
  ClkSweep: 0x75,
} as const;

export const Status = { Ok: 0, InvalidParam: 1, HwError: 2, Busy: 3, UnknownCmd: 4 } as const;
const STATUS_TEXT = ["ok", "invalid parameter", "hardware error", "busy", "unknown command"];
export const statusText = (s: number) => STATUS_TEXT[s] ?? `status ${s}`;

export type Ack = { seq: number; cmd: number; status: number; payload: Uint8Array };

export function packCmd(cmd: number, seq: number, payload: Uint8Array = new Uint8Array(0)): Uint8Array {
  if (payload.length > PAYLOAD) throw new Error(`payload too big: ${payload.length} > ${PAYLOAD}`);
  const b = new Uint8Array(PACKET);
  const v = new DataView(b.buffer);
  v.setUint32(0, CMD_MAGIC, true);
  v.setUint16(4, seq & 0xffff, true);
  b[6] = cmd & 0xff;
  b.set(payload, 8);
  return b;
}

export function packAck(seq: number, cmd: number, status: number, payload: Uint8Array = new Uint8Array(0)): Uint8Array {
  const b = new Uint8Array(PACKET);
  const v = new DataView(b.buffer);
  v.setUint32(0, ACK_MAGIC, true);
  v.setUint16(4, seq & 0xffff, true);
  b[6] = cmd & 0xff;
  b[7] = status & 0xff;
  b.set(payload.subarray(0, PAYLOAD), 8);
  return b;
}

export function parseCmd(b: Uint8Array): { seq: number; cmd: number; payload: Uint8Array } | null {
  if (b.length < PACKET) return null;
  const v = new DataView(b.buffer, b.byteOffset, PACKET);
  if (v.getUint32(0, true) !== CMD_MAGIC) return null;
  return { seq: v.getUint16(4, true), cmd: b[6], payload: b.slice(8, PACKET) };
}

const le32 = (m: number) => [m & 0xff, (m >>> 8) & 0xff, (m >>> 16) & 0xff, (m >>> 24) & 0xff];
const ACK_LE = le32(ACK_MAGIC);
const DATA_LE = le32(DATA_MAGIC);

/**
 * Splits the board's byte stream into ACKs and log text. Bytes arrive in any
 * chunking; a packet split across two reads is held until it is complete.
 * Data frames are skipped whole (MHO Studio sends no command that asks for one).
 */
export class AckReader {
  private buf = new Uint8Array(0);
  private text = "";
  onAck: (a: Ack) => void = () => {};
  onText: (line: string) => void = () => {};

  push(chunk: Uint8Array): void {
    const b = new Uint8Array(this.buf.length + chunk.length);
    b.set(this.buf);
    b.set(chunk, this.buf.length);
    let i = 0;
    while (i < b.length) {
      const m = matchAt(b, i);
      if (m === "partial") break;
      if (m === "ack") {
        if (b.length - i < PACKET) break;
        const v = new DataView(b.buffer, b.byteOffset + i, PACKET);
        this.flushText();
        this.onAck({ seq: v.getUint16(4, true), cmd: b[i + 6], status: b[i + 7], payload: b.slice(i + 8, i + PACKET) });
        i += PACKET;
        continue;
      }
      if (m === "data") {
        if (b.length - i < DATA_HEADER) break;
        const n = new DataView(b.buffer, b.byteOffset + i, DATA_HEADER).getUint16(6, true);
        if (b.length - i < DATA_HEADER + n) break;
        i += DATA_HEADER + n;
        continue;
      }
      this.char(b[i]);
      i++;
    }
    this.buf = b.slice(i);
  }

  private char(c: number): void {
    if (c === 0x0a) this.flushText();
    else if (c !== 0x0d && c >= 0x20 && c < 0x7f) this.text += String.fromCharCode(c);
    if (this.text.length > 400) this.flushText();
  }

  private flushText(): void {
    if (this.text.trim()) this.onText(this.text);
    this.text = "";
  }
}

/** Whether a magic starts at i: complete, possibly (not enough bytes yet), or not at all. */
function matchAt(b: Uint8Array, i: number): "ack" | "data" | "partial" | null {
  for (const [kind, m] of [["ack", ACK_LE], ["data", DATA_LE]] as const) {
    let k = 0;
    while (k < 4 && i + k < b.length && b[i + k] === m[k]) k++;
    if (k === 4) return kind;
    if (i + k === b.length && k > 0) return "partial";
  }
  return null;
}

// ------------------------------------------------------------ payloads

/** Si5351 frequencies cross the wire as u48 in 0.01 Hz. */
export function putU48(b: Uint8Array, at: number, v: number): void {
  let x = Math.round(v);
  for (let k = 0; k < 6; k++) {
    b[at + k] = x % 256;
    x = Math.floor(x / 256);
  }
}

export function getU48(b: Uint8Array, at: number): number {
  let x = 0;
  for (let k = 5; k >= 0; k--) x = x * 256 + b[at + k];
  return x;
}

export type Version = { protocol: number; firmware: number; built: string };

export function decodeVersion(p: Uint8Array): Version {
  const v = new DataView(p.buffer, p.byteOffset, PAYLOAD);
  const y = v.getUint16(6, true);
  return { protocol: v.getUint16(0, true), firmware: v.getUint16(2, true), built: `${y}-${String(p[5]).padStart(2, "0")}-${String(p[4]).padStart(2, "0")}` };
}

export function encodeVersion(v: { protocol: number; firmware: number; day: number; month: number; year: number }): Uint8Array {
  const p = new Uint8Array(PAYLOAD);
  const d = new DataView(p.buffer);
  d.setUint16(0, v.protocol, true);
  d.setUint16(2, v.firmware, true);
  p[4] = v.day;
  p[5] = v.month;
  d.setUint16(6, v.year, true);
  return p;
}

/** Crystal load capacitance codes, register 183. Must match the crystal fitted. */
export const LOAD_PF = [6, 8, 10];
/** Output drive codes 0..3 = 2, 4, 6, 8 mA. */
export const DRIVE_MA = [2, 4, 6, 8];

export function encodeClkInit(xtalHz: number, load: number, addr: number): Uint8Array {
  const p = new Uint8Array(PAYLOAD);
  new DataView(p.buffer).setUint32(0, xtalHz, true);
  p[4] = load;
  p[5] = addr;
  return p;
}

export type ClkInit = { present: boolean; status: number; address: number; i2cErrors: number; xtalHz: number };

export function decodeClkInit(p: Uint8Array): ClkInit {
  return { present: p[0] === 1, status: p[1], address: p[2], i2cErrors: p[3], xtalHz: new DataView(p.buffer, p.byteOffset, PAYLOAD).getUint32(4, true) };
}

export function encodeClkFreq(ch: number, hz: number, on: boolean): Uint8Array {
  const p = new Uint8Array(PAYLOAD);
  p[0] = ch;
  p[1] = on ? 1 : 0;
  putU48(p, 2, hz * 100);
  return p;
}

/** One output as it now is — not as it was asked to be (three outputs share two PLLs). */
export type ClkChannel = { ch: number; on: boolean; pllB: boolean; integer: boolean; shared: boolean; unreachable: boolean; sweeping: boolean; drive: number; hz: number };

export function decodeClkFreq(p: Uint8Array): ClkChannel {
  const f = p[1];
  return {
    ch: p[0],
    on: (f & 0x01) !== 0,
    pllB: (f & 0x02) !== 0,
    integer: (f & 0x04) !== 0,
    shared: (f & 0x08) !== 0,
    unreachable: (f & 0x10) !== 0,
    sweeping: (f & 0x20) !== 0,
    drive: (f >> 6) & 3,
    hz: getU48(p, 2) / 100,
  };
}

export function encodeClkFlags(c: Omit<ClkChannel, "ch" | "hz">): number {
  return (c.on ? 1 : 0) | (c.pllB ? 2 : 0) | (c.integer ? 4 : 0) | (c.shared ? 8 : 0) | (c.unreachable ? 0x10 : 0) | (c.sweeping ? 0x20 : 0) | ((c.drive & 3) << 6);
}

export const encodeChannel = (ch: number) => Uint8Array.of(ch, 0, 0, 0, 0, 0, 0, 0);
export const encodeClkDrive = (ch: number, drive: number) => Uint8Array.of(ch, drive, 0, 0, 0, 0, 0, 0);

/** ClkSweep: u8 ch, u8 run, u16 dwell ms, i32 step in 0.01 Hz. Only used here to stop one. */
export function encodeClkSweep(ch: number, run: boolean, dwellMs: number, stepChz: number): Uint8Array {
  const p = new Uint8Array(PAYLOAD);
  const v = new DataView(p.buffer);
  p[0] = ch;
  p[1] = run ? 1 : 0;
  v.setUint16(2, dwellMs, true);
  v.setInt32(4, stepChz, true);
  return p;
}

// ------------------------------------------------------------ DAC sine
//
// DacSine plays one sine on both DAC1 channels: PC4 (through OPAMP1, buffered)
// and PA5 (direct). The frequency is the timer's real rate over the table
// length, so the reply carries what came out. DacPlay with on = 0 stops it.

export function encodeDacSine(hz: number, ampMv: number, offsetMv: number): Uint8Array {
  const p = new Uint8Array(PAYLOAD);
  const v = new DataView(p.buffer);
  v.setFloat32(0, hz, true);
  v.setUint16(4, Math.round(ampMv), true);
  v.setUint16(6, Math.round(offsetMv), true);
  return p;
}

export type DacSine = { hz: number; rateHz: number };

export function decodeDacSine(p: Uint8Array): DacSine {
  const v = new DataView(p.buffer, p.byteOffset, PAYLOAD);
  return { hz: v.getFloat32(0, true), rateHz: v.getUint32(4, true) };
}

export function encodeDacSineReply(r: DacSine): Uint8Array {
  const p = new Uint8Array(PAYLOAD);
  const v = new DataView(p.buffer);
  v.setFloat32(0, r.hz, true);
  v.setUint32(4, r.rateHz, true);
  return p;
}

/** DacStatus (and DacPlay's reply): what the DAC is playing. source 0 idle, 1 FDM, 2 sine, 0x10 + slot a stored waveform. */
export type DacStatus = { running: boolean; source: number; length: number; rateHz: number };

export function decodeDacStatus(p: Uint8Array): DacStatus {
  const v = new DataView(p.buffer, p.byteOffset, PAYLOAD);
  return { running: p[0] === 1, source: p[1], length: v.getUint16(2, true), rateHz: v.getUint32(4, true) };
}

export function encodeDacStatus(d: DacStatus): Uint8Array {
  const p = new Uint8Array(PAYLOAD);
  const v = new DataView(p.buffer);
  p[0] = d.running ? 1 : 0;
  p[1] = d.source;
  v.setUint16(2, d.length, true);
  v.setUint32(4, d.rateHz, true);
  return p;
}

export const dacSourceText = (d: DacStatus) =>
  !d.running ? "idle" : d.source === 1 ? "the FDM waveform" : d.source === 2 ? "a sine" : d.source >= 0x10 ? `stored waveform ${d.source - 0x10}` : `source ${d.source}`;

/** DacPlay: u8 on, u8 pad, u16 pad, u32 rate (0 = design). Only used here to stop. */
export const encodeDacStop = () => new Uint8Array(PAYLOAD);
