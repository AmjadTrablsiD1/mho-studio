// The browser side of /api: the session token, JSON calls with the confirm
// flow, and the live store fed by Server-Sent Events. Components read the
// store through useLive(); waveform frames bypass React (onFrame).

import { useSyncExternalStore } from "react";
import type { Value } from "../../core/src/scpi/values.ts";
import type { Slot } from "../../core/src/registry/measurements.ts";

export type Identity = { vendor: string; model: string; serial: string; firmware: string; raw: string };
export type UsbInfo = { id: string; vendorId: number; productId: number; manufacturer: string | null; product: string | null; serial: string | null; rigol: boolean; usbtmc: boolean | null };
export type Link = {
  state: "idle" | "connecting" | "connected" | "lost";
  kind: "tcp" | "usb" | "sim";
  protocol: "raw" | "vicp";
  family: "rigol" | "lecroy" | "siglent";
  usb: UsbInfo | null;
  host: string;
  port: number;
  sim: boolean;
  idn: Identity | null;
  error: string | null;
  transport: string | null;
  rttMs: number | null;
  wordOrder: "little" | "big";
  wordOrderLocked: boolean;
  modelWarning: string | null;
};
/** How to name where a link goes, everywhere the interface shows it. */
export function linkAddress(l: Link | null): string {
  if (!l) return "—";
  if (l.kind === "sim") return "simulated bench";
  if (l.kind === "usb") return `USB${l.usb?.serial ? ` · ${l.usb.serial}` : ""}`;
  return `${l.host}:${l.port}`;
}

export type StatsSnap = { last: number | null; n: number; mean: number | null; min: number | null; max: number | null; std: number | null };
export type MeasureRow = { slot: Slot; value: number | null; stats: StatsSnap; cross: number | null };
export type Traffic = { t: number; dir: "out" | "in"; text: string; bytes?: number };
export type LinkStats = { rttMs: number | null; bytesIn: number; bytesOut: number; commands: number; frames: number; fps: number };
export type BodePoint = { hz: number; gainDb: number; phaseDeg: number; vin: number; vout: number };
export type BodeState = {
  running: boolean;
  config: Record<string, unknown> | null;
  generator: string | null;
  points: BodePoint[];
  step: number;
  total: number;
  error: string | null;
  corner: { hz: number; phaseDeg: number } | null;
  startedAt: string | null;
  notes: string[];
};
export type ClkChannel = { ch: number; on: boolean; pllB: boolean; integer: boolean; shared: boolean; unreachable: boolean; sweeping: boolean; drive: number; hz: number };
/** The STM32H743 board and its Si5351 (server/board.ts). */
export type BoardState = {
  state: "idle" | "connecting" | "connected" | "error";
  port: string | null;
  sim: boolean;
  baud: number | null;
  version: { protocol: number; firmware: number; built: string } | null;
  si5351: { present: boolean; status: number; address: number; i2cErrors: number; xtalHz: number; checked: string } | null;
  clk: ClkChannel[];
  /** DAC1 (PC4 and PA5): source 0 idle, 1 FDM, 2 sine, 0x10 + slot a stored waveform; hz for a sine. */
  dac: { running: boolean; source: number; length: number; rateHz: number; hz: number | null } | null;
  busy: string | null;
  error: string | null;
  log: string[];
};
/** The in-app updater (server/update.ts). */
export type UpdateCommit = { sha: string; date: string; message: string; author: string };
export type UpdateState = {
  version: string;
  build: { branch: string; commit: string; dirty: boolean; installedAt: string; from: string } | null;
  where: "installed" | "source" | "exe";
  branch: string;
  checking: boolean;
  checkedAt: string | null;
  latest: (UpdateCommit & { version: string | null }) | null;
  newer: UpdateCommit[];
  newerCount: number;
  available: boolean;
  ahead: number;
  note: string | null;
  installing: string | null;
  error: string | null;
  autoCheck: boolean;
};
export type BoardPortInfo = { path: string; label: string; likely: boolean };
export type Summary = { n: number; min: number | null; mean: number | null; max: number | null; std: number | null };
export type Edge = { i: number; t: number; kind: "rise" | "fall"; dur: number; under: boolean; seg: number };
export type Anomaly = { kind: "glitch" | "runt"; polarity: "high" | "low"; t: number; width: number | null; peak: number | null; seg: number };
export type Histogram = { lo: number; hi: number; counts: number[] };
export type SegmentRow = { seg: number; rise: number; fall: number; riseMean: number | null; riseMax: number | null; fallMean: number | null; fallMax: number | null; anomalies: number };
export type BurstResult = {
  ch: number; src: string; edges: Edge[]; shown: number; rises: Summary; falls: Summary; periods: Summary;
  pulses: { high: Summary; low: Summary }; anomalies: Anomaly[];
  counts: { rise: number; fall: number; under: number; glitch: number; runt: number }; truncated: boolean; dt: number; flat: boolean; offScreen: boolean;
  levels: { top: number; base: number; lo: number; mid: number; hi: number };
  hist: { rise: Histogram; fall: Histogram }; slowest: { rise: Edge[]; fall: Edge[] }; perSegment: SegmentRow[];
};
export type TimingRow = { t: number; setup: number | null; hold: number | null; seg: number };
export type TimingResult = {
  data: number; clock: number; edge: "rise" | "fall"; setup: Summary; hold: Summary; worstSetup: TimingRow | null; worstHold: TimingRow | null;
  violations: { setup: number; hold: number }; limits: { setup: number | null; hold: number | null }; rows: TimingRow[]; total: number;
};
export type BurstConfig = {
  trigger: number; slope: "rise" | "fall"; level: number | null; waitS: number; windowS: number; channels: number[]; maxPoints: number;
  base: number | null; top: number | null; segments: number; glitchS: number | null;
  timing: { clock: number; edge: "rise" | "fall"; setupMin: number | null; holdMin: number | null } | null;
};
export type BurstState = {
  running: boolean;
  phase: "idle" | "setting up" | "waiting for trigger" | "reading" | "analysing" | "done" | "stopped" | "error";
  config: BurstConfig | null;
  startedAt: string | null;
  triggeredAfterS: number | null;
  error: string | null;
  notes: string[];
  setup: { timeDiv: number; sampleRate: number | null; points: number | null; windowS: number; dt: number | null; segments: number } | null;
  progress: DeepProgress | null;
  results: BurstResult[];
  timing: TimingResult[];
  segments: { count: number; recorded: number; times: number[] | null } | null;
};
export type DeepMeta = { channels: { src: string; points: number; pre: { xinc: number; xorigin: number } }[]; capturedAt: string; points: number; xinc: number; xorigin: number; seconds: number };
export type DeepProgress = { src: string; done: number; total: number; channel: number; channels: number; bytesPerSec: number };
export type Preset = { name: string; savedAt: string; model: string; firmware: string; bytes: number };
export type Settings = { host: string; port: number; protocol: "raw" | "vicp"; recent: string[]; lastKind: "tcp" | "usb" | "sim" | null; usbId: string | null; simModel: "rigol" | "lecroy" | "siglent" };

export type Trace = { src: string; points: number; xinc: number; xorigin: number; volts: Float32Array };
export type Frame = { t: number; seq: number; status: string; traces: Trace[] };

export type AllMeasure = { srcs: string[]; values: { src: string; item: string; value: number | null }[]; at: number; points: number };

export type Live = {
  loaded: boolean;
  streamUp: boolean;
  link: Link | null;
  values: Record<string, Value>;
  options: Record<string, boolean>;
  status: string;
  busy: string | null;
  measure: MeasureRow[];
  /** The instrument's all-measure table (RIGOL AMSource), when it is on. */
  allMeasure: AllMeasure | null;
  readings: { counter: number | null; dvm: number | null };
  traffic: Traffic[];
  stats: LinkStats | null;
  bode: BodeState | null;
  board: BoardState | null;
  update: UpdateState | null;
  burst: BurstState | null;
  deep: DeepMeta | null;
  deepProgress: DeepProgress | null;
  presets: Preset[];
  settings: Settings | null;
  problem: string | null;
  /** Control ids this instrument's firmware does not answer (learned, and remembered per firmware). */
  unsupported: string[];
};

let state: Live = {
  loaded: false,
  streamUp: false,
  link: null,
  values: {},
  options: {},
  status: "—",
  busy: null,
  measure: [],
  allMeasure: null,
  readings: { counter: null, dvm: null },
  traffic: [],
  stats: null,
  bode: null,
  board: null,
  update: null,
  burst: null,
  deep: null,
  deepProgress: null,
  presets: [],
  settings: null,
  problem: null,
  unsupported: [],
};

const listeners = new Set<() => void>();
function set(patch: Partial<Live>): void {
  state = { ...state, ...patch };
  for (const l of listeners) l();
}
export const patchLive = set;
export const getLive = () => state;

export function useLive<T>(select: (s: Live) => T): T {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => select(state),
  );
}

// ------------------------------------------------------------------ frames

const frameListeners = new Set<(f: Frame) => void>();
let lastFrame: Frame | null = null;
export const latestFrame = () => lastFrame;
export function onFrame(fn: (f: Frame) => void): () => void {
  frameListeners.add(fn);
  return () => frameListeners.delete(fn);
}

function b64floats(s: string): Float32Array {
  const bin = atob(s);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return new Float32Array(u8.buffer);
}

// ------------------------------------------------------------------- calls

let session: { token: string; header: string } | null = null;
async function token(): Promise<{ token: string; header: string }> {
  if (!session) session = await (await fetch("./api/session")).json();
  return session!;
}

export class ApiError extends Error {
  status: number;
  needsConfirm: boolean;
  constructor(status: number, message: string, needsConfirm: boolean) {
    super(message);
    this.status = status;
    this.needsConfirm = needsConfirm;
  }
}

/** The confirm modal, provided by App; resolves true when the person agrees. */
let confirmer: (message: string) => Promise<boolean> = async (m) => window.confirm(m);
export function setConfirmer(fn: (message: string) => Promise<boolean>): void {
  confirmer = fn;
}
/** Ask the person in the app's own confirm dialog. */
export const ask = (message: string): Promise<boolean> => confirmer(message);

/** Set when the person quit: the window shows that the app has stopped instead of "server not reachable". */
let quitListeners = new Set<() => void>();
export let quitted = false;
export function onQuit(fn: () => void): () => void {
  quitListeners.add(fn);
  return () => quitListeners.delete(fn);
}
/** Quit from the window: the server disconnects the scope and the board, then stops. */
export async function quitApp(): Promise<void> {
  const busy = getLive().board?.state === "connected" ? " and the STM32 board" : "";
  if (!(await ask(`Quit MHO Studio? The oscilloscope${busy} is disconnected and the app stops. The tile starts it again.`))) return;
  const ok = await attempt(() => post("quit"));
  if (!ok) return;
  quitted = true;
  for (const f of quitListeners) f();
  quitListeners = new Set();
}

async function raw<T>(path: string, body: unknown, extraHeaders: Record<string, string> = {}): Promise<T> {
  const t = await token();
  const isBytes = body instanceof Uint8Array || body instanceof ArrayBuffer;
  const res = await fetch(`./api/${path}`, {
    method: "POST",
    headers: { [t.header]: t.token, ...(isBytes ? { "Content-Type": "application/octet-stream" } : { "Content-Type": "application/json" }), ...extraHeaders },
    body: isBytes ? (body as BodyInit) : JSON.stringify(body ?? {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error ?? res.statusText, !!data.needsConfirm);
  return data as T;
}

/**
 * POST with the confirmation round trip: a 409 that asks for confirmation
 * shows the instrument-specific warning and, if accepted, repeats the call
 * with `confirmed: true`.
 */
export async function post<T>(path: string, body: Record<string, unknown> = {}): Promise<T> {
  try {
    return await raw<T>(path, body);
  } catch (e) {
    if (e instanceof ApiError && e.needsConfirm && (await confirmer(e.message))) return raw<T>(path, { ...body, confirmed: true });
    throw e;
  }
}

export async function postBytes<T>(path: string, bytes: Uint8Array, confirmQuery: string): Promise<T> {
  try {
    return await raw<T>(path, bytes);
  } catch (e) {
    if (e instanceof ApiError && e.needsConfirm && (await confirmer(e.message))) return raw<T>(`${path}?${confirmQuery}`, bytes);
    throw e;
  }
}

export async function get<T>(path: string): Promise<T> {
  const res = await fetch(`./api/${path}`);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error ?? res.statusText, false);
  return data as T;
}

export type WriteResult = { key: string; requested: Value; value: Value; coerced: boolean; errors: { code: number; message: string }[] };
export const writeControl = (key: string, value: Value) => post<WriteResult>("control", { key, value });
export const action = (id: string, n?: number | null) => post<{ id: string; errors: { code: number; message: string }[]; status: string }>("action", { id, n: n ?? null });
export const readGroup = (group: string, sub?: string | null, n?: number) => post<Record<string, Value>>("read", { group, sub, n });
export const readKeys = (keys: string[]) => post<Record<string, Value>>("read", { keys });

// ---------------------------------------------------------------- toasts

export type Toast = { id: number; kind: "error" | "success" | "info"; text: string };
let toasts: Toast[] = [];
let toastSeq = 0;
const toastListeners = new Set<() => void>();
export function toast(kind: Toast["kind"], text: string): void {
  const t = { id: ++toastSeq, kind, text };
  toasts = [...toasts.slice(-3), t];
  toastListeners.forEach((l) => l());
  setTimeout(() => dismissToast(t.id), kind === "error" ? 9000 : 4500);
}
export function dismissToast(id: number): void {
  toasts = toasts.filter((t) => t.id !== id);
  toastListeners.forEach((l) => l());
}
export function useToasts(): Toast[] {
  return useSyncExternalStore(
    (l) => (toastListeners.add(l), () => toastListeners.delete(l)),
    () => toasts,
  );
}
/** Run an API call; show its error as a toast instead of throwing. */
export async function attempt<T>(fn: () => Promise<T>, ok?: string): Promise<T | null> {
  try {
    const r = await fn();
    if (ok) toast("success", ok);
    return r;
  } catch (e) {
    toast("error", (e as Error).message);
    return null;
  }
}

// ---------------------------------------------------------------- stream

export async function connectStream(): Promise<void> {
  const snap = await (await fetch("./api/state")).json();
  set({ ...snap, loaded: true });
  const es = new EventSource("./api/stream");
  es.onopen = () => set({ streamUp: true });
  es.onerror = () => set({ streamUp: false });
  const on = <T,>(type: string, fn: (d: T) => void) => es.addEventListener(type, (e) => fn(JSON.parse((e as MessageEvent).data)));
  on<Link>("link", (link) => {
    set({ link });
    if (link.state === "connected") void fetch("./api/state").then((r) => r.json()).then((s) => set({ values: s.values, options: s.options, status: s.status }));
  });
  on<Record<string, Value>>("values", (v) => set({ values: { ...state.values, ...v } }));
  on<Record<string, boolean>>("options", (options) => set({ options }));
  on<string>("status", (status) => set({ status }));
  on<string | null>("busy", (busy) => set({ busy }));
  on<MeasureRow[]>("measure", (measure) => set({ measure }));
  on<AllMeasure | null>("allMeasure", (allMeasure) => set({ allMeasure }));
  on<{ counter: number | null; dvm: number | null }>("readings", (readings) => set({ readings }));
  on<LinkStats>("stats", (stats) => set({ stats }));
  on<BodeState>("bode", (bode) => set({ bode }));
  on<BoardState>("board", (board) => set({ board }));
  on<UpdateState>("update", (update) => set({ update }));
  on<BurstState>("burst", (burst) => set({ burst }));
  on<DeepMeta>("deep", (deep) => set({ deep, deepProgress: null }));
  on<DeepProgress>("deep-progress", (deepProgress) => set({ deepProgress }));
  on<Preset[]>("presets", (presets) => set({ presets }));
  on<{ message: string }>("problem", (p) => set({ problem: p.message }));
  on<string[]>("unsupported", (unsupported) => set({ unsupported }));
  on<Traffic>("traffic", (t) => set({ traffic: [...state.traffic.slice(-299), t] }));
  on<{ t: number; seq: number; status: string; traces: (Omit<Trace, "volts"> & { volts: string })[] }>("frame", (f) => {
    const frame: Frame = { ...f, traces: f.traces.map((t) => ({ ...t, volts: b64floats(t.volts) })) };
    lastFrame = frame;
    for (const fn of frameListeners) fn(frame);
  });
}
