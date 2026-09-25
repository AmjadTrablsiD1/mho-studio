// The browser side of /api: the session token, JSON calls with the confirm
// flow, and the live store fed by Server-Sent Events. Components read the
// store through useLive(); waveform frames bypass React (onFrame).

import { useSyncExternalStore } from "react";
import type { Value } from "../../core/src/scpi/values.ts";
import type { Slot } from "../../core/src/registry/measurements.ts";

export type Identity = { vendor: string; model: string; serial: string; firmware: string; raw: string };
export type Link = {
  state: "idle" | "connecting" | "connected" | "lost";
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
export type StatsSnap = { last: number | null; n: number; mean: number | null; min: number | null; max: number | null; std: number | null };
export type MeasureRow = { slot: Slot; value: number | null; stats: StatsSnap; cross: number | null };
export type Traffic = { t: number; dir: "out" | "in"; text: string; bytes?: number };
export type LinkStats = { rttMs: number | null; bytesIn: number; bytesOut: number; commands: number; frames: number; fps: number };
export type BodePoint = { hz: number; gainDb: number; phaseDeg: number; vin: number; vout: number };
export type BodeState = {
  running: boolean;
  config: Record<string, unknown> | null;
  points: BodePoint[];
  step: number;
  total: number;
  error: string | null;
  corner: { hz: number; phaseDeg: number } | null;
  startedAt: string | null;
  notes: string[];
};
export type DeepMeta = { channels: { src: string; points: number; pre: { xinc: number; xorigin: number } }[]; capturedAt: string; points: number; xinc: number; xorigin: number; seconds: number };
export type DeepProgress = { src: string; done: number; total: number; channel: number; channels: number; bytesPerSec: number };
export type Preset = { name: string; savedAt: string; model: string; firmware: string; bytes: number };
export type Settings = { host: string; port: number; recent: string[]; lastWasSim: boolean };

export type Trace = { src: string; points: number; xinc: number; xorigin: number; volts: Float32Array };
export type Frame = { t: number; seq: number; status: string; traces: Trace[] };

export type Live = {
  loaded: boolean;
  streamUp: boolean;
  link: Link | null;
  values: Record<string, Value>;
  options: Record<string, boolean>;
  status: string;
  busy: string | null;
  measure: MeasureRow[];
  readings: { counter: number | null; dvm: number | null };
  traffic: Traffic[];
  stats: LinkStats | null;
  bode: BodeState | null;
  deep: DeepMeta | null;
  deepProgress: DeepProgress | null;
  presets: Preset[];
  settings: Settings | null;
  problem: string | null;
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
  readings: { counter: null, dvm: null },
  traffic: [],
  stats: null,
  bode: null,
  deep: null,
  deepProgress: null,
  presets: [],
  settings: null,
  problem: null,
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
  on<{ counter: number | null; dvm: number | null }>("readings", (readings) => set({ readings }));
  on<LinkStats>("stats", (stats) => set({ stats }));
  on<BodeState>("bode", (bode) => set({ bode }));
  on<DeepMeta>("deep", (deep) => set({ deep, deepProgress: null }));
  on<DeepProgress>("deep-progress", (deepProgress) => set({ deepProgress }));
  on<Preset[]>("presets", (presets) => set({ presets }));
  on<{ message: string }>("problem", (p) => set({ problem: p.message }));
  on<Traffic>("traffic", (t) => set({ traffic: [...state.traffic.slice(-299), t] }));
  on<{ t: number; seq: number; status: string; traces: (Omit<Trace, "volts"> & { volts: string })[] }>("frame", (f) => {
    const frame: Frame = { ...f, traces: f.traces.map((t) => ({ ...t, volts: b64floats(t.volts) })) };
    lastFrame = frame;
    for (const fn of frameListeners) fn(frame);
  });
}
