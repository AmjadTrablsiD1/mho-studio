// FFT windows with their coherent gain (to read amplitudes back correctly)
// and equivalent noise bandwidth (to read noise densities back correctly).

export type WindowName = "hann" | "blackman-harris" | "flattop" | "rect";

export const WINDOW_LABELS: Record<WindowName, string> = {
  hann: "Hann",
  "blackman-harris": "Blackman-Harris",
  flattop: "Flat top",
  rect: "Rectangular",
};

/** Cosine-sum coefficients a0 − a1·cos + a2·cos2 − a3·cos3 + a4·cos4 (periodic form). */
const COEFFS: Record<WindowName, number[]> = {
  rect: [1],
  hann: [0.5, 0.5],
  "blackman-harris": [0.35875, 0.48829, 0.14128, 0.01168],
  // The five-term flat top used by Matlab's flattopwin: amplitude error < 0.01 dB anywhere in a bin.
  flattop: [0.21557895, 0.41663158, 0.277263158, 0.083578947, 0.006947368],
};

export type Window = { w: Float64Array; coherentGain: number; enbwBins: number };

export function makeWindow(name: WindowName, n: number): Window {
  const a = COEFFS[name];
  const w = new Float64Array(n);
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < n; i++) {
    let v = 0;
    for (let k = 0; k < a.length; k++) v += (k % 2 ? -1 : 1) * a[k] * Math.cos((2 * Math.PI * k * i) / n);
    w[i] = v;
    s1 += v;
    s2 += v * v;
  }
  return { w, coherentGain: s1 / n, enbwBins: (n * s2) / (s1 * s1) };
}
