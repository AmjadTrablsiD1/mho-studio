// Reading and writing SCPI parameter values. The instrument answers enums in
// short form ("POS"), numbers in scientific notation ("5.000000E-02"), bools
// as 0/1, and 9.9E37 for "no valid measurement".

import { C } from "../constants.ts";
import { shortForm } from "./header.ts";

export type Value = number | string | boolean | null;

/** "1k" → 1000, "25M" → 2.5e7, "2.5e7" → 2.5e7, "AUTO" → null. Scope-style suffixes, not SI case rules. */
export function numericOption(s: string): number | null {
  const m = /^([+-]?\d+(?:\.\d+)?(?:e[+-]?\d+)?)([kKmM]?)$/.exec(s.trim());
  if (!m) return null;
  const mult = m[2] === "k" || m[2] === "K" ? 1e3 : m[2] === "M" ? 1e6 : m[2] === "m" ? 1e-3 : 1;
  return Number(m[1]) * mult;
}

export function parseNumber(reply: string): number | null {
  const s = reply.trim().replace(/^"|"$/g, "");
  if (!s) return null;
  const n = Number(s);
  if (!Number.isFinite(n)) return numericOption(s);
  if (Math.abs(n) >= C.instrument.invalid_above) return null;
  return n;
}

export function parseBool(reply: string): boolean | null {
  const s = reply.trim().toUpperCase();
  if (s === "1" || s === "ON") return true;
  if (s === "0" || s === "OFF") return false;
  return null;
}

/**
 * Which option a reply names. Letters compare by short form ("POS" ↔ "POSitive",
 * "CHAN1" ↔ "CHANnel1"); numbers compare by value ("1.000000E+04" ↔ "10k").
 */
export function matchOption(reply: string, options: readonly string[]): string | null {
  const r = reply.trim().replace(/^"|"$/g, "");
  const up = r.toUpperCase();
  for (const o of options) if (o.toUpperCase() === up || shortForm(o) === up) return o;
  const rn = Number(r);
  if (Number.isFinite(rn)) {
    for (const o of options) {
      const on = numericOption(o);
      if (on !== null && Math.abs(on - rn) <= Math.abs(rn) * 1e-6) return o;
    }
  }
  // Some replies are a prefix of the long form that is longer than the short form (e.g. "FIFT").
  for (const o of options) if (o.toUpperCase().startsWith(up) && up.length >= shortForm(o).length) return o;
  return null;
}

/** A value as it goes on the wire. */
export function encode(v: Value, kind: "number" | "enum" | "bool" | "string"): string {
  if (kind === "bool") return v ? "1" : "0";
  if (kind === "number") {
    const n = Number(v);
    if (!Number.isFinite(n)) throw new Error(`not a number: ${v}`);
    if (n === 0) return "0";
    const a = Math.abs(n);
    return a >= 1e-3 && a < 1e7 ? String(Number(n.toPrecision(10))) : n.toExponential(9).replace(/\.?0+e/, "e");
  }
  if (kind === "enum") return shortForm(String(v));
  // Strings go unquoted: the guide's examples (":CHANnel1:LABel:CONTent ch1") never quote.
  return String(v).replace(/[\r\n;]/g, " ");
}

/** "-113,\"Undefined header; command cannot be found\"" → {code, message}. */
export function parseError(reply: string): { code: number; message: string } {
  const m = /^\s*([+-]?\d+)\s*,\s*"?(.*?)"?\s*$/.exec(reply);
  if (!m) return { code: -1, message: reply.trim() };
  return { code: Number(m[1]), message: m[2] };
}

/** "RIGOL TECHNOLOGIES,MHO984,MHO9A1234,00.01.02" */
export type Identity = { vendor: string; model: string; serial: string; firmware: string; raw: string };
export function parseIdn(reply: string): Identity {
  const [vendor = "", model = "", serial = "", firmware = ""] = reply.trim().split(",").map((s) => s.trim());
  return { vendor, model, serial, firmware, raw: reply.trim() };
}
