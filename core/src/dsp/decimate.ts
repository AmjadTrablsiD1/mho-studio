// Min/max decimation: a deep record drawn into a few thousand pixel columns
// without losing a single glitch, the way the instrument's own display does.

export type MinMax = { min: Float32Array; max: Float32Array; from: number; to: number };

/** Envelope of v[from, to) in `columns` columns. When there are fewer points than columns, min = max = the point. */
export function minmax(v: ArrayLike<number>, from: number, to: number, columns: number): MinMax {
  const a = Math.max(0, Math.floor(from));
  const b = Math.min(v.length, Math.ceil(to));
  const n = Math.max(0, b - a);
  const cols = Math.max(1, Math.min(columns, n || 1));
  const min = new Float32Array(cols);
  const max = new Float32Array(cols);
  for (let c = 0; c < cols; c++) {
    const i0 = a + Math.floor((c * n) / cols);
    const i1 = Math.max(i0 + 1, a + Math.floor(((c + 1) * n) / cols));
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = i0; i < i1 && i < b; i++) {
      const x = v[i];
      if (x < lo) lo = x;
      if (x > hi) hi = x;
    }
    min[c] = lo === Infinity ? NaN : lo;
    max[c] = hi === -Infinity ? NaN : hi;
  }
  return { min, max, from: a, to: b };
}
