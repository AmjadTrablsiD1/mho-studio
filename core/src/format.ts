// Rule 16: one formatter every displayed number passes through. A value is
// split into digits and a unit so the UI can typeset the unit smaller.

export type Formatted = { value: string; unit: string };

const PREFIXES: [number, string][] = [
  [1e9, "G"],
  [1e6, "M"],
  [1e3, "k"],
  [1, ""],
  [1e-3, "m"],
  [1e-6, "µ"],
  [1e-9, "n"],
  [1e-12, "p"],
];

function trim(s: string): string {
  return s.includes(".") && !s.includes("e") ? s.replace(/\.?0+$/, "") : s;
}

/**
 * A quantity with an SI prefix and `sig` significant digits:
 * 0.0002 V → "200 µV"; 1234567 Hz → "1.23 MHz". Units that must not take a
 * prefix (%, °, dB, dBV, div, pts) are printed plainly.
 */
export function si(x: number | null | undefined, unit = "", sig = 3): Formatted {
  if (x === null || x === undefined || !Number.isFinite(x)) return { value: "—", unit };
  if (/^(%|°|dB|dBV|div|pts|Sa|x|bit)$/.test(unit) || unit === "") {
    if (unit === "pts" || unit === "Sa") return engineeringCount(x, unit);
    return { value: plain(x, sig), unit };
  }
  if (x === 0) return { value: "0", unit };
  const a = Math.abs(x);
  let [scale, p] = PREFIXES[PREFIXES.length - 1];
  for (const [s, pre] of PREFIXES) {
    if (a >= s * 0.9995) {
      scale = s;
      p = pre;
      break;
    }
  }
  const v = x / scale;
  const digits = Math.max(0, sig - 1 - Math.floor(Math.log10(Math.abs(v) || 1)));
  return { value: trim(v.toFixed(digits)), unit: p + unit };
}

/** A plain number with `sig` significant digits, no prefix. */
export function plain(x: number, sig = 3): string {
  if (!Number.isFinite(x)) return "—";
  if (x === 0) return "0";
  const a = Math.abs(x);
  if (a >= 1e6 || a < 1e-4) return x.toExponential(Math.max(0, sig - 1)).replace(/\.?0+e/, "e");
  const digits = Math.max(0, sig - 1 - Math.floor(Math.log10(a)));
  return trim(x.toFixed(digits));
}

/** Point counts and rates the way a scope prints them: 25 Mpts, 4 GSa/s. */
export function engineeringCount(x: number, unit: string): Formatted {
  const a = Math.abs(x);
  if (a >= 1e9) return { value: trim((x / 1e9).toFixed(2)), unit: `G${unit}` };
  if (a >= 1e6) return { value: trim((x / 1e6).toFixed(2)), unit: `M${unit}` };
  if (a >= 1e3) return { value: trim((x / 1e3).toFixed(2)), unit: `k${unit}` };
  return { value: String(Math.round(x)), unit };
}

export function text(f: Formatted): string {
  return f.unit ? `${f.value} ${f.unit}` : f.value;
}

/** Shorthand used all over the UI: si() as one string. */
export function fmt(x: number | null | undefined, unit = "", sig = 3): string {
  return text(si(x, unit, sig));
}

/**
 * Parse what a person types into a numeric field: "200m", "200 mV", "1.5k",
 * "2u", "2µs", "1e-3". Returns null when it is not a number.
 */
export function parseSI(input: string): number | null {
  const s = input.trim().replace(/,/g, "").replace(/\s+/g, "");
  const m = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)([pnuµmkKMG]?)([A-Za-z%°/]*)$/.exec(s);
  if (!m) return null;
  const mult: Record<string, number> = { p: 1e-12, n: 1e-9, u: 1e-6, "µ": 1e-6, m: 1e-3, "": 1, k: 1e3, K: 1e3, M: 1e6, G: 1e9 };
  // "m" after a number is milli; "M" is mega. A trailing unit never changes the prefix.
  const v = Number(m[1]) * (mult[m[2]] ?? 1);
  return Number.isFinite(v) ? v : null;
}
