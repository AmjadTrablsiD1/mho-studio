// What a Siglent-made oscilloscope (Teledyne T3DSO1000, Siglent SDS1000X-E)
// sends back, and how to read it. Every format here was seen on a T3DSO1204
// (firmware 8.3.6.1.37R8, 2026-10-14) unless marked otherwise:
//   C2:VDIV? → "C2:VDIV 1.00E+00V" (header on) or "1.00E+00" (CHDR OFF)
//   SARA?    → "SARA 5.00E+08Sa/s" or "5.00E+08";  MSIZ? → "7M", "700K"
//   C2:PAVA? PKPK → "PKPK,4.000000E-02" ("****" when it cannot measure)
//   C2:WF? DAT2   → "DAT2,#9000000350" + 350 signed bytes + "\n\n"
//   SCDP          → an 800×480 RGB565 BMP, raw, with no block header
// Waveform bytes are signed 8-bit codes, 25 per vertical division:
//   volts = code × VDIV / 25 − OFST        (VDIV includes the probe factor)
//   time of point i = −TRDL − TDIV × 14 / 2 + i / SARA
// (14 horizontal divisions; the sign of TRDL is the programming guide's,
// still to be checked on a signal: TODO → Next.)

import type { Identity, Value } from "./values.ts";

/** Memory sizes and the multipliers Siglent glues to them ("7M" is 7 Mpts, not 7 milli). */
const MULT: Record<string, number> = { K: 1e3, M: 1e6, G: 1e9 };

/** "1.00E+00", "1.00E+00V", "5.00E+08Sa/s", "-0.00E+00S", "700K", "1.4M", "10" → numbers. Units are dropped. */
export function siglentNumber(reply: string): number | null {
  const s = reply.trim().replace(/^"|"$/g, "");
  const m = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:E[+-]?\d+)?)\s*([A-Za-z/%]*)$/i.exec(s);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  const mult = MULT[m[2]];
  return mult && !/E/i.test(m[1]) ? n * mult : n;
}

export function siglentBool(reply: string): boolean | null {
  const s = reply.trim().toUpperCase();
  if (s === "ON" || s === "1") return true;
  if (s === "OFF" || s === "0") return false;
  return null;
}

/** A reply value for the registry. */
export function siglentValue(kind: string, reply: string, options: string[] = []): Value {
  const s = reply.trim().replace(/^"|"$/g, "");
  if (kind === "number") return siglentNumber(s);
  if (kind === "bool") return siglentBool(s);
  if (kind === "enum") return options.find((o) => o.toUpperCase() === s.toUpperCase()) ?? s;
  if (kind === "readonly") {
    const n = siglentNumber(s);
    return n !== null && /^[+-]?[\d.]/.test(s) ? n : s;
  }
  return s;
}

/** "Lecroy,T3DSO1204 ,T0101C22230356,8.3.6.1.37R8": fields trimmed (the model comes with a trailing space). */
export function siglentIdn(reply: string): Identity {
  const raw = reply.trim().replace(/^\*?IDN\s+/i, "");
  const [vendor = "", model = "", serial = "", firmware = ""] = raw.split(",").map((x) => x.trim());
  return { vendor, model, serial, firmware, raw };
}

/** "PKPK,4.000000E-02" or "C2:PAVA PKPK,4.000000E-02V"; "FREQ,****" when the instrument cannot measure it. */
export function parseSiglentPava(reply: string): { value: number | null; state: string } {
  const v = reply.trim().split(",").pop()?.trim() ?? "";
  if (/^\*+$/.test(v) || !v) return { value: null, state: "****" };
  const n = siglentNumber(v);
  return { value: n, state: n === null ? v : "OK" };
}

/** *ESR? bits (IEEE 488.2): what went wrong since the last read. */
export function esrErrors(esr: number): { code: number; message: string }[] {
  const out: { code: number; message: string }[] = [];
  if (esr & 32) out.push({ code: -100, message: "command error (a header or parameter the instrument does not know)" });
  if (esr & 16) out.push({ code: -200, message: "execution error (a value out of range, or not possible in this state)" });
  if (esr & 8) out.push({ code: -300, message: "device-specific error" });
  if (esr & 4) out.push({ code: -400, message: "query error (a reply was lost or not asked for)" });
  return out;
}

/** The settings that turn a DAT2 record into volts and seconds. */
export type SiglentScale = { vdiv: number; ofst: number; tdiv: number; trdl: number; sara: number };

/** Signed 8-bit codes of a DAT2 block (block header already removed). */
export function siglentCodes(b: Uint8Array): Int8Array {
  return new Int8Array(b.buffer, b.byteOffset, b.length);
}

/** Volts of signed codes: code × VDIV / 25 − OFST. */
export function siglentVolts(codes: Int8Array, s: Pick<SiglentScale, "vdiv" | "ofst">, codesPerDiv: number): Float32Array {
  const g = s.vdiv / codesPerDiv;
  return Float32Array.from(codes, (c) => c * g - s.ofst);
}

/** Time of the record's first point (relative to the trigger), for a record starting at point `first` and spanning `divisions` divisions. */
export function siglentT0(s: Pick<SiglentScale, "tdiv" | "trdl" | "sara">, divisions: number, first = 0): number {
  return -s.trdl - (s.tdiv * divisions) / 2 + first / s.sara;
}
