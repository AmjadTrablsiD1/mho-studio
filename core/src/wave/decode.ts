// Waveform bytes → volts, using the preamble the instrument sends with them.
//
// Programming guide §3.28: volts = (code − YORigin − YREFerence) × YINCrement,
// time of point i = XORigin + (i − XREFerence) × XINCrement.
// Nothing here assumes a scale: every constant comes from the preamble.

export type Format = "BYTE" | "WORD" | "ASC";
export type Mode = "NORM" | "MAX" | "RAW";

export type Preamble = {
  format: Format;
  mode: Mode;
  points: number;
  count: number;
  xinc: number;
  xorigin: number;
  xref: number;
  yinc: number;
  yorigin: number;
  yref: number;
};

const FORMATS: Format[] = ["BYTE", "WORD", "ASC"];
const MODES: Mode[] = ["NORM", "MAX", "RAW"];

/** "0,0,1000,1,1.000000E-8,-5.000000E-6,0.000000E-12,4.000000E-03,0,128" */
export function parsePreamble(reply: string): Preamble {
  const f = reply.trim().split(",").map((s) => Number(s.trim()));
  if (f.length < 10 || f.some((x) => !Number.isFinite(x))) throw new Error(`malformed preamble: ${reply.trim().slice(0, 120)}`);
  return {
    format: FORMATS[f[0]] ?? "BYTE",
    mode: MODES[f[1]] ?? "NORM",
    points: f[2],
    count: f[3],
    xinc: f[4],
    xorigin: f[5],
    xref: f[6],
    yinc: f[7],
    yorigin: f[8],
    yref: f[9],
  };
}

export function formatPreamble(p: Preamble): string {
  const e = (x: number) => x.toExponential(6).toUpperCase().replace(/E([+-])(\d)$/, "E$10$2");
  return [FORMATS.indexOf(p.format), MODES.indexOf(p.mode), p.points, p.count, e(p.xinc), e(p.xorigin), e(p.xref), e(p.yinc), Math.round(p.yorigin), Math.round(p.yref)].join(",");
}

export type ByteOrder = "little" | "big";

/** Raw codes from a block. WORD is two bytes per point; the byte order is passed in (see detectWordOrder). */
export function codes(data: Uint8Array, format: Format, order: ByteOrder = "little"): Int32Array {
  if (format === "WORD") {
    const n = data.length >> 1;
    const out = new Int32Array(n);
    for (let i = 0; i < n; i++) {
      const a = data[2 * i];
      const b = data[2 * i + 1];
      out[i] = order === "little" ? a | (b << 8) : (a << 8) | b;
    }
    return out;
  }
  const out = new Int32Array(data.length);
  for (let i = 0; i < data.length; i++) out[i] = data[i];
  return out;
}

export function toVolts(c: Int32Array, p: Preamble, out = new Float32Array(c.length)): Float32Array {
  const k = p.yorigin + p.yref;
  for (let i = 0; i < c.length; i++) out[i] = (c[i] - k) * p.yinc;
  return out;
}

/** ASCii format: comma-separated volts. */
export function parseAscii(text: string): Float32Array {
  const parts = text.split(",").filter((s) => s.trim());
  const out = new Float32Array(parts.length);
  for (let i = 0; i < parts.length; i++) out[i] = Number(parts[i]);
  return out;
}

/**
 * Which byte order a WORD block is in. The guide does not say, so it is
 * measured: real waveform codes move smoothly from point to point, and read in
 * the wrong order the low byte becomes the high byte, which turns every small
 * step into a jump of hundreds. Returns the smoother order and how much
 * smoother it was (a ratio; 1 means the data could not tell).
 */
export function detectWordOrder(data: Uint8Array): { order: ByteOrder; confidence: number } {
  const n = data.length >> 1;
  if (n < 8) return { order: "little", confidence: 1 };
  let little = 0;
  let big = 0;
  let pl = data[0] | (data[1] << 8);
  let pb = (data[0] << 8) | data[1];
  for (let i = 1; i < n; i++) {
    const a = data[2 * i];
    const b = data[2 * i + 1];
    const l = a | (b << 8);
    const g = (a << 8) | b;
    little += Math.abs(l - pl);
    big += Math.abs(g - pb);
    pl = l;
    pb = g;
  }
  if (little === big) return { order: "little", confidence: 1 };
  return little < big ? { order: "little", confidence: (big + 1) / (little + 1) } : { order: "big", confidence: (little + 1) / (big + 1) };
}

/** Times for each point of a record (only for small records; big ones use xorigin + i·xinc directly). */
export function times(p: Preamble, n: number): Float64Array {
  const t = new Float64Array(n);
  for (let i = 0; i < n; i++) t[i] = p.xorigin + (i - p.xref) * p.xinc;
  return t;
}
