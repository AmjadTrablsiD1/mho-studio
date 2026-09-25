// Single-frequency (lock-in) detection: the complex amplitude of the
// component at a known frequency f in a record. The Bode sweep uses it on the
// input and output channels of the same acquisition, so gain and phase come
// from the waveforms themselves rather than from the instrument's measurement
// conventions (whose sign for phase the guide does not define).

export type Phasor = { amp: number; phaseRad: number; re: number; im: number };

/**
 * Peak amplitude and phase (cosine reference, t measured from `t0`) of the
 * f component of v. A Hann window over the record keeps leakage from DC and
 * from the negative-frequency image small once the record holds ≥ 3 periods.
 */
export function phasor(v: ArrayLike<number>, dt: number, f: number, t0 = 0): Phasor {
  const n = v.length;
  let mean = 0;
  for (let i = 0; i < n; i++) mean += v[i];
  mean /= n;
  let re = 0;
  let im = 0;
  let wsum = 0;
  for (let i = 0; i < n; i++) {
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
    const ph = 2 * Math.PI * f * (t0 + i * dt);
    const x = (v[i] - mean) * w;
    re += x * Math.cos(ph);
    im -= x * Math.sin(ph);
    wsum += w;
  }
  re = (2 * re) / wsum;
  im = (2 * im) / wsum;
  return { amp: Math.hypot(re, im), phaseRad: Math.atan2(im, re), re, im };
}

/** Wrap a phase in degrees to (−180, 180]. */
export function wrapDeg(d: number): number {
  let x = d % 360;
  if (x <= -180) x += 360;
  if (x > 180) x -= 360;
  return x;
}
