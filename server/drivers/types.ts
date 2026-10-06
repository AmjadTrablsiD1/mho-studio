// What a family driver does for the scope service: the parts of talking to
// an oscilloscope that differ from brand to brand. Everything else — the link,
// the value mirror, the live loop, read-back after writes, learning which
// queries a firmware leaves unanswered — is the service's and is shared.

import type { Control } from "../../core/src/registry/controls.ts";
import type { Registry } from "../../core/src/registry/families.ts";
import type { Slot } from "../../core/src/registry/measurements.ts";
import type { Value } from "../../core/src/scpi/values.ts";
import type { Preamble } from "../../core/src/wave/decode.ts";

export type InstrumentError = { code: number; message: string };
export type Record1 = { volts: Float32Array; pre: Preamble };
/** Deep-memory points as unsigned codes; volts = (code − yorigin − yref) × yinc. */
export type DeepChunk = { pre: Preamble; codes: ArrayLike<number>; bytes: number };

export interface Driver {
  readonly reg: Registry;
  /** Put the instrument in the state the driver expects. Returns what *IDN? answers from now on (the resync token). */
  init(idnRaw: string): Promise<string>;
  queryOf(c: Control, n: number | null): string;
  setOf(c: Control, n: number | null, v: Value): string;
  parse(c: Control, n: number | null, reply: string): Value;
  errors(): Promise<InstrumentError[]>;
  /** Trigger status in the app's terms: TD, WAIT, RUN, AUTO or STOP. */
  status(): Promise<string>;
  action(c: Control, n: number | null): Promise<void>;
  visibleSources(): string[];
  /** One screen record of each source, inside the caller's exclusive section. */
  frame(srcs: string[]): Promise<Map<string, Record1>>;
  readTrace(src: string): Promise<Record1>;
  screenshot(): Promise<Uint8Array>;
  setupBlob(): Promise<Uint8Array>;
  restoreSetup(blob: Uint8Array): Promise<void>;
  addMeasurement(slot: Slot): Promise<void>;
  /** After one was removed: what the instrument should still measure. */
  measurementsChanged(remaining: Slot[]): Promise<void>;
  readMeasurement(slot: Slot): Promise<number | null>;
  /** Stop the instrument and say how many points each channel holds. */
  deepBegin(): Promise<{ total: number }>;
  /** `count` points of `src` from index `start` (0-based). */
  deepChunk(src: string, start: number, count: number): Promise<DeepChunk>;
  deepEnd(resume: boolean, wasRunning: boolean): Promise<void>;
  /**
   * Several values in one round trip, where the family has a way (LeCroy: one VBS
   * line joining automation properties). Null when one of them has no such form.
   */
  readMany?(items: { c: Control; n: number | null }[]): Promise<Value[] | null>;
  /** Whether readMany can carry this control at all. */
  batchable?(c: Control): boolean;
  /** The instrument's own FFT of `src` (magnitude per bin as the instrument scales it), set up on first use. */
  scopeFft?(src: string, window: string): Promise<{ df: number; f0: number; mag: Float32Array; unit: string; points: number }>;
  /** Switch that FFT off again. */
  scopeFftStop?(): Promise<void>;
  /** Console queries that return big data blocks get the long timeout. */
  slowQuery(cmd: string): boolean;
}
