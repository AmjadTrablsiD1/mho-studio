// Frequency-response sweep planning and analysis. The instrument's own Bode
// option cannot hand its curve back over SCPI (§3.5 has no data query), so the
// app drives the built-in generator itself and measures each point.

import { wrapDeg } from "./lockin.ts";

export type Spacing = "log" | "lin";

export function plan(startHz: number, stopHz: number, points: number, spacing: Spacing): number[] {
  const n = Math.max(2, Math.round(points));
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    out.push(spacing === "log" ? startHz * (stopHz / startHz) ** t : startHz + (stopHz - startHz) * t);
  }
  return out;
}

export type BodePoint = { hz: number; gainDb: number; phaseDeg: number; vin: number; vout: number };

/** Gain and phase of out relative to in, from their phasors (peak amplitudes, radians). */
export function point(hz: number, vin: { amp: number; phaseRad: number }, vout: { amp: number; phaseRad: number }): BodePoint {
  return {
    hz,
    gainDb: 20 * Math.log10(Math.max(vout.amp, 1e-15) / Math.max(vin.amp, 1e-15)),
    phaseDeg: wrapDeg(((vout.phaseRad - vin.phaseRad) * 180) / Math.PI),
    vin: vin.amp,
    vout: vout.amp,
  };
}

/** Remove 360° jumps so a phase that keeps falling past −180° is drawn as one curve. */
export function unwrap(phases: number[]): number[] {
  const out: number[] = [];
  let add = 0;
  for (let i = 0; i < phases.length; i++) {
    if (i > 0) {
      const d = phases[i] + add - out[i - 1];
      if (d > 180) add -= 360;
      else if (d < -180) add += 360;
    }
    out.push(phases[i] + add);
  }
  return out;
}

/**
 * Where the gain first falls `dropDb` below its value at the first point
 * (a low-pass corner) — interpolated in log frequency. Null if it never does.
 */
export function corner(points: BodePoint[], dropDb = 3): { hz: number; phaseDeg: number } | null {
  if (points.length < 2) return null;
  const ref = points[0].gainDb - dropDb;
  const ph = unwrap(points.map((p) => p.phaseDeg));
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    if ((a.gainDb - ref) * (b.gainDb - ref) <= 0 && a.gainDb !== b.gainDb) {
      const f = (ref - a.gainDb) / (b.gainDb - a.gainDb);
      const hz = Math.exp(Math.log(a.hz) + f * (Math.log(b.hz) - Math.log(a.hz)));
      return { hz, phaseDeg: ph[i - 1] + f * (ph[i] - ph[i - 1]) };
    }
  }
  return null;
}

/** Timebase (s/div) that shows `periods` cycles of f across `divisions`. */
export function timebaseFor(hz: number, periods: number, divisions: number): number {
  return periods / hz / divisions;
}
