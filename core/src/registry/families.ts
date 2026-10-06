// Instrument families the app speaks to, and what each one offers. The server
// picks a family from *IDN?; the interface asks the same table which controls
// exist and which views make sense, so nothing outside this file and the
// drivers needs to know which brand is on the other end of the cable.

import { C } from "../constants.ts";
import { BY_ID, CONTROLS, type Control } from "./controls.ts";
import { ANALOG_SOURCES, MATH_SOURCES, MEASUREMENTS, type Measurement } from "./measurements.ts";
import { LECROY_CONTROLS, LECROY_MEASUREMENTS } from "./lecroy.ts";

export type Family = "rigol" | "lecroy";
export type Protocol = "raw" | "vicp";

export type Features = {
  generator: boolean;
  decode: boolean;
  math: boolean;
  counter: boolean;
  options: boolean;
  clock: boolean;
  /** Several queries in one message (":A?;:B?"). */
  compound: boolean;
};

export type Registry = {
  family: Family;
  /** Who the commands come from, for labels and tooltips. */
  doc: string;
  controls: Control[];
  byId: Map<string, Control>;
  measurements: Measurement[];
  measureSources: string[];
  features: Features;
  /** Points in one live screen record. */
  screenPoints: number;
};

const RIGOL: Registry = {
  family: "rigol",
  doc: "MHO900 programming guide",
  controls: CONTROLS,
  byId: BY_ID,
  measurements: MEASUREMENTS,
  measureSources: [...ANALOG_SOURCES, ...MATH_SOURCES],
  features: { generator: true, decode: true, math: true, counter: true, options: true, clock: true, compound: true },
  screenPoints: C.instrument.normal_points,
};

const LECROY: Registry = {
  family: "lecroy",
  doc: "LeCroy X-Stream remote control manual",
  controls: LECROY_CONTROLS,
  byId: new Map(LECROY_CONTROLS.map((c) => [c.id, c])),
  measurements: LECROY_MEASUREMENTS,
  measureSources: ANALOG_SOURCES,
  features: { generator: false, decode: false, math: false, counter: false, options: false, clock: false, compound: false },
  screenPoints: C.lecroy.screen_points,
};

export function registryFor(f: Family | null | undefined): Registry {
  return f === "lecroy" ? LECROY : RIGOL;
}

/** Which family answered *IDN? (anything that is not LeCroy is treated as RIGOL-style SCPI). */
export function familyOf(idnRaw: string): Family {
  return new RegExp(C.lecroy.vendor_match, "i").test(idnRaw.split(",")[0] ?? "") ? "lecroy" : "rigol";
}

/** The link protocol a TCP port usually means: 1861 is VICP. */
export function protocolForPort(port: number): Protocol {
  return port === C.lecroy.vicp_port ? "vicp" : "raw";
}

/** "CHANnel2" → 2 (the app's names for analog sources are the same for every family). */
export function channelOf(src: string): number | null {
  const m = /^CHAN(?:nel)?(\d)$/i.exec(src);
  return m ? Number(m[1]) : null;
}
