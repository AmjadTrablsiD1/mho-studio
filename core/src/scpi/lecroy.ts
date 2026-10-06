// What Teledyne LeCroy X-Stream oscilloscopes send back, and how to read it.
//
// With COMM_HEADER OFF (CHDR OFF) a query answers with its value only, but
// numbers keep their unit ("50E-3 V", "1E-6 S") and memory sizes use LeCroy
// suffixes ("10K", "10MA" — MA is mega, because M would be milli). Waveforms
// come as a WAVEDESC descriptor (template LECROY_2_3, 346 bytes) followed by
// the data array; the descriptor says how to turn codes into volts:
//   volts = VERTICAL_GAIN × code − VERTICAL_OFFSET
//   time of point i = HORIZ_INTERVAL × i + HORIZ_OFFSET   (relative to the trigger)
// Offsets are those of the published template (LeCroy remote control manual,
// "WAVEDESC"); they are the same in every X-Stream model.

import type { Identity, Value } from "./values.ts";
import type { Preamble } from "../wave/decode.ts";

const SUFFIX: Record<string, number> = { K: 1e3, MA: 1e6, M: 1e-3, U: 1e-6, N: 1e-9, P: 1e-12, G: 1e9 };

/** "50E-3 V" → 0.05, "10MA" → 1e7, "2.5K" → 2500, "OFF" → null. The unit after a space is ignored. */
export function lecroyNumber(reply: string): number | null {
  const s = reply.trim().replace(/^"|"$/g, "");
  const m = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:E[+-]?\d+)?)\s*([A-Z]{0,2})\b/i.exec(s);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  const sfx = m[2].toUpperCase();
  // A suffix glued to the number is a multiplier ("10MA"); after a space it is a unit ("50E-3 V").
  const glued = sfx && s[m[1].length] !== " " && SUFFIX[sfx] !== undefined && !/E/i.test(m[1].slice(-1));
  return glued ? n * SUFFIX[sfx] : n;
}

/** VBS booleans come back as -1 / 0 (and some legacy queries as ON / OFF). */
export function lecroyBool(reply: string): boolean | null {
  const s = reply.trim().replace(/^"|"$/g, "").toUpperCase();
  if (s === "ON" || s === "-1" || s === "1" || s === "TRUE") return true;
  if (s === "OFF" || s === "0" || s === "FALSE") return false;
  return null;
}

/** "*IDN LECROY,WM8ZI-A,LCRY1234,7.9.0" (header on) or "LECROY,…" (header off). */
export function lecroyIdn(reply: string): Identity {
  const raw = reply.trim().replace(/^\*?IDN\s+/i, "");
  const [vendor = "", model = "", serial = "", firmware = ""] = raw.split(",").map((x) => x.trim());
  return { vendor, model, serial, firmware, raw };
}

/** Field `i` of a comma-separated reply ("EDGE,SR,C1,HT,OFF" → field 2 is "C1"). */
export function field(reply: string, i: number): string {
  return reply.trim().split(",")[i]?.trim() ?? "";
}

/** The item after `token` in a reply of pairs ("C1,OFF,C2,20MHZ", "C2" → "20MHZ"; "EDGE,SR,C1", "SR" → "C1"). */
export function after(reply: string, token: string): string {
  const parts = reply.trim().split(",").map((x) => x.trim());
  const i = parts.findIndex((p) => p.toUpperCase() === token.toUpperCase());
  return i >= 0 ? (parts[i + 1] ?? "") : "";
}

/**
 * PARAMETER_VALUE? answers "PKPK,812.5E-3 V,OK" (or with the source first,
 * "C1,PKPK,…" on some firmware). The last field is the state: OK, AV
 * (averaged), PT (computed on part of the trace), GT/LT (bound), and
 * anything else (IV invalid, NP no pulse, OF/UF over/underflow…) means the
 * value cannot be trusted.
 */
export function parsePava(reply: string): { value: number | null; state: string } {
  const parts = reply.trim().split(",").map((x) => x.trim());
  const state = (parts[parts.length - 1] ?? "").toUpperCase();
  const numeric = parts.map((p) => lecroyNumber(p)).find((x, i) => x !== null && i < parts.length - 1 && /^[+-]?[\d.]/.test(parts[i])) ?? null;
  const good = ["OK", "AV", "PT", "GT", "LT"].includes(state);
  return { value: good ? numeric : null, state };
}

/** Command-error register (CMR?) codes, from the remote control manual. */
export const CMR: Record<number, string> = {
  1: "unrecognized command or query header",
  2: "illegal header path",
  3: "illegal number",
  4: "illegal number suffix",
  5: "unrecognized keyword",
  6: "string error",
  7: "GET embedded in another message",
  10: "arbitrary data block expected",
  11: "non-digit character in a byte-count field",
  12: "EOI detected during a definite-length block",
  13: "extra bytes detected during a definite-length block",
};

// ------------------------------------------------------------------ WAVEDESC

export type Wavedesc = {
  template: string;
  commType: "byte" | "word";
  order: "big" | "little";
  descriptorBytes: number;
  userText: number;
  trigtime: number;
  ristime: number;
  array1: number;
  instrument: string;
  count: number;
  firstValid: number;
  lastValid: number;
  firstPoint: number;
  sparsing: number;
  gain: number;
  offset: number;
  nominalBits: number;
  interval: number;
  horizOffset: number;
  vertUnit: string;
  horUnit: string;
  source: number;
};

const ascii = (b: Uint8Array, at: number, n: number) => {
  let s = "";
  for (let i = 0; i < n && b[at + i]; i++) s += String.fromCharCode(b[at + i]);
  return s.trim();
};

/** Where the descriptor starts: it always opens with the text "WAVEDESC". */
export function findWavedesc(b: Uint8Array): number {
  const key = [0x57, 0x41, 0x56, 0x45, 0x44, 0x45, 0x53, 0x43];
  outer: for (let i = 0; i + 8 <= Math.min(b.length, 64); i++) {
    for (let k = 0; k < 8; k++) if (b[i + k] !== key[k]) continue outer;
    return i;
  }
  return -1;
}

export function parseWavedesc(b: Uint8Array, at = findWavedesc(b)): Wavedesc {
  if (at < 0 || b.length < at + 346) throw new Error(`not a LeCroy waveform: ${b.length} bytes, no WAVEDESC`);
  const dv = new DataView(b.buffer, b.byteOffset + at, 346);
  // COMM_ORDER (offset 34) says how every multi-byte field is stored: 0 = big-endian (HIFIRST), 1 = little-endian (LOFIRST).
  const le = dv.getUint8(34) === 1 || dv.getUint8(35) === 1;
  const i16 = (o: number) => dv.getInt16(o, le);
  const i32 = (o: number) => dv.getInt32(o, le);
  const f32 = (o: number) => dv.getFloat32(o, le);
  const f64 = (o: number) => dv.getFloat64(o, le);
  return {
    template: ascii(b, at + 16, 16),
    commType: i16(32) === 1 ? "word" : "byte",
    order: le ? "little" : "big",
    descriptorBytes: i32(36),
    userText: i32(40),
    trigtime: i32(48),
    ristime: i32(52),
    array1: i32(60),
    instrument: ascii(b, at + 76, 16),
    count: i32(116),
    firstValid: i32(124),
    lastValid: i32(128),
    firstPoint: i32(132),
    sparsing: i32(136),
    gain: f32(156),
    offset: f32(160),
    nominalBits: i16(172),
    interval: f32(176),
    horizOffset: f64(180),
    vertUnit: ascii(b, at + 196, 48),
    horUnit: ascii(b, at + 244, 48),
    source: i16(344),
  };
}

/** The descriptor and the volts of a whole "WF? ALL" reply (block header already removed). */
export function decodeLecroyWave(b: Uint8Array): { desc: Wavedesc; volts: Float32Array; codes: Int32Array } {
  const at = findWavedesc(b);
  const d = parseWavedesc(b, at);
  // Blocks follow the descriptor in template order: USERTEXT, (RES_DESC1), TRIGTIME, RISTIME, (RES_ARRAY1), DATA_ARRAY_1.
  const dv0 = new DataView(b.buffer, b.byteOffset + at, 346);
  const le = d.order === "little";
  const res = dv0.getInt32(44, le) + dv0.getInt32(56, le);
  const start = at + d.descriptorBytes + d.userText + d.trigtime + d.ristime + res;
  const width = d.commType === "word" ? 2 : 1;
  const n = Math.max(0, Math.min(d.count, Math.floor((Math.min(d.array1 || b.length, b.length - start)) / width)));
  const dv = new DataView(b.buffer, b.byteOffset + start, n * width);
  const codes = new Int32Array(n);
  const volts = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const c = width === 2 ? dv.getInt16(2 * i, le) : dv.getInt8(i);
    codes[i] = c;
    volts[i] = d.gain * c - d.offset;
  }
  return { desc: d, volts, codes };
}

/**
 * The same record in the app's own terms (a RIGOL-style preamble), so every
 * view and the deep-memory store can treat it like any other trace. Codes are
 * stored unsigned (code + 32768): volts = (u − yorigin − yref) × yinc with
 * yinc = gain, yref = 32768, yorigin = offset / gain.
 */
export function preambleOf(d: Wavedesc, points: number): Preamble {
  return {
    format: "WORD",
    mode: "RAW",
    points,
    count: 1,
    xinc: d.interval,
    xorigin: d.horizOffset,
    xref: 0,
    yinc: d.gain,
    yorigin: d.gain ? d.offset / d.gain : 0,
    yref: 32768,
  };
}

/** Build a descriptor + data the way the instrument would (the simulator uses this; tests check the round trip). */
export function buildLecroyWave(o: { codes: Int16Array | Int8Array; gain: number; offset: number; interval: number; horizOffset: number; source: number; instrument: string; order?: "little" | "big"; firstPoint?: number; sparsing?: number; nominalBits?: number }): Uint8Array {
  const le = (o.order ?? "little") === "little";
  const width = o.codes instanceof Int8Array ? 1 : 2;
  const out = new Uint8Array(346 + o.codes.length * width);
  const dv = new DataView(out.buffer);
  const put = (at: number, s: string, n: number) => {
    for (let i = 0; i < Math.min(n, s.length); i++) out[at + i] = s.charCodeAt(i);
  };
  put(0, "WAVEDESC", 16);
  put(16, "LECROY_2_3", 16);
  dv.setInt16(32, width === 2 ? 1 : 0, le); // COMM_TYPE: 0 byte, 1 word
  dv.setInt16(34, le ? 1 : 0, le);
  dv.setInt32(36, 346, le);
  dv.setInt32(60, o.codes.length * width, le);
  put(76, o.instrument, 16);
  dv.setInt32(116, o.codes.length, le);
  dv.setInt32(124, 0, le);
  dv.setInt32(128, Math.max(0, o.codes.length - 1), le);
  dv.setInt32(132, o.firstPoint ?? 0, le);
  dv.setInt32(136, o.sparsing ?? 1, le);
  dv.setFloat32(156, o.gain, le);
  dv.setFloat32(160, o.offset, le);
  dv.setInt16(172, o.nominalBits ?? 8, le);
  dv.setFloat32(176, o.interval, le);
  dv.setFloat64(180, o.horizOffset, le);
  put(196, "V", 48);
  put(244, "S", 48);
  dv.setInt16(344, o.source, le);
  for (let i = 0; i < o.codes.length; i++) {
    if (width === 2) dv.setInt16(346 + 2 * i, o.codes[i], le);
    else dv.setInt8(346 + i, o.codes[i]);
  }
  return out;
}

/** A reply value for the registry: the kinds a LeCroy control can have. */
export function lecroyValue(kind: string, reply: string, options: string[] = []): Value {
  if (kind === "number") return lecroyNumber(reply);
  if (kind === "bool") return lecroyBool(reply);
  const s = reply.trim().replace(/^"|"$/g, "");
  if (kind === "enum") return options.find((o) => o.toUpperCase() === s.toUpperCase()) ?? s;
  if (kind === "readonly") {
    const n = lecroyNumber(s);
    return n !== null && /^[+-]?[\d.]/.test(s) ? n : s;
  }
  return s;
}
