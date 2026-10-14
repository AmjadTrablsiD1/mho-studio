// Instrument families the app speaks to, and what each one offers. The server
// picks a family from *IDN?; the interface asks the same table which controls
// exist and which views make sense, so nothing outside this file and the
// drivers needs to know which brand is on the other end of the cable.

import { C } from "../constants.ts";
import { BY_ID, CONTROLS, type Control } from "./controls.ts";
import { ANALOG_SOURCES, MATH_SOURCES, MEASUREMENTS, type Measurement } from "./measurements.ts";
import { LECROY_CONSOLE, LECROY_CONTROLS, LECROY_MEASUREMENTS, LECROY_TRIGGER_SUB } from "./lecroy.ts";
import { SIGLENT_CONSOLE, SIGLENT_CONTROLS, SIGLENT_MEASUREMENTS } from "./siglent.ts";

export type Family = "rigol" | "lecroy" | "siglent";
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
  /** The instrument computes an FFT the app can read (LeCroy math F8 = FFT). */
  scopeFft: boolean;
  /** Segmented memory the app can read with each segment's trigger time (LeCroy sequence mode). */
  segments: boolean;
};

export type ConsoleCommand = { header: string; set: boolean; query: boolean; section: string; params: { name: string; type: string; options?: string[]; range?: string }[] };

export type Registry = {
  family: Family;
  /** The driver's name, as the interface shows it. */
  label: string;
  /** Who the commands come from, for labels and tooltips. */
  doc: string;
  controls: Control[];
  byId: Map<string, Control>;
  measurements: Measurement[];
  measureSources: string[];
  features: Features;
  /** Points in one live screen record. */
  screenPoints: number;
  /** Horizontal divisions of the instrument's screen (and of its record). */
  divisionsX: number;
  /** Points per deep-memory read. */
  deepChunk: number;
  /** Trigger type → the registry sub-group with its fields; null: the RIGOL table in the inspector. */
  triggerSub: Record<string, string> | null;
  /** The console's completion list; null: the RIGOL guide's full command list. */
  console: ConsoleCommand[] | null;
};

const RIGOL: Registry = {
  family: "rigol",
  label: "RIGOL MHO900",
  doc: "MHO900 programming guide",
  controls: CONTROLS,
  byId: BY_ID,
  measurements: MEASUREMENTS,
  measureSources: [...ANALOG_SOURCES, ...MATH_SOURCES],
  features: { generator: true, decode: true, math: true, counter: true, options: true, clock: true, compound: true, scopeFft: false, segments: false },
  screenPoints: C.instrument.normal_points,
  divisionsX: C.instrument.divisions_x,
  deepChunk: C.instrument.raw_chunk_points,
  triggerSub: null,
  console: null,
};

const LECROY: Registry = {
  family: "lecroy",
  label: "Teledyne LeCroy X-Stream (VICP)",
  doc: "LeCroy X-Stream remote control manual",
  controls: LECROY_CONTROLS,
  byId: new Map(LECROY_CONTROLS.map((c) => [c.id, c])),
  measurements: LECROY_MEASUREMENTS,
  measureSources: ANALOG_SOURCES,
  features: { generator: false, decode: false, math: false, counter: false, options: false, clock: false, compound: false, scopeFft: true, segments: true },
  screenPoints: C.lecroy.screen_points,
  divisionsX: 10,
  deepChunk: C.lecroy.deep_chunk_points,
  triggerSub: LECROY_TRIGGER_SUB,
  console: LECROY_CONSOLE,
};

const SIGLENT: Registry = {
  family: "siglent",
  label: "Teledyne T3DSO / Siglent SDS1000X-E",
  doc: "Siglent SDS1000X-E programming guide",
  controls: SIGLENT_CONTROLS,
  byId: new Map(SIGLENT_CONTROLS.map((c) => [c.id, c])),
  measurements: SIGLENT_MEASUREMENTS,
  measureSources: ANALOG_SOURCES,
  // Measured on a T3DSO1204: "C2:VDIV?;C2:OFST?" answers only the first query, so no compound reads.
  features: { generator: false, decode: false, math: false, counter: false, options: false, clock: false, compound: false, scopeFft: false, segments: false },
  screenPoints: C.siglent.screen_points,
  divisionsX: C.siglent.divisions_x,
  deepChunk: C.siglent.deep_chunk_points,
  triggerSub: {},
  console: SIGLENT_CONSOLE,
};

export function registryFor(f: Family | null | undefined): Registry {
  return f === "lecroy" ? LECROY : f === "siglent" ? SIGLENT : RIGOL;
}

/**
 * Which family answered *IDN?. A Siglent-made scope comes first: the Teledyne
 * T3DSO1204 answers "Lecroy,T3DSO1204 ,…" but speaks Siglent's SCPI, not the
 * X-Stream set. Anything that is neither is treated as RIGOL-style SCPI.
 */
export function familyOf(idnRaw: string): Family {
  const [vendor = "", model = ""] = idnRaw.split(",").map((x) => x.trim());
  if (new RegExp(C.siglent.vendor_match, "i").test(vendor) || new RegExp(C.siglent.model_match, "i").test(model)) return "siglent";
  return new RegExp(C.lecroy.vendor_match, "i").test(vendor) ? "lecroy" : "rigol";
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
