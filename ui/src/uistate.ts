// Per-viewer interface state: which view, which channel is selected, the
// inspector section, cursors, persistence. Kept in localStorage, never sent
// to the instrument.

import { useSyncExternalStore } from "react";
import { C } from "../../core/src/constants.ts";

export type View = "scope" | "spectrum" | "bode" | "deep" | "decode" | "console" | "instrument" | "settings";
export type Section = "vertical" | "horizontal" | "trigger" | "acquire" | "measure" | "math" | "generator" | "counter";
export type CursorMode = "off" | "time" | "volt" | "both";

export type Ui = {
  view: View;
  section: Section;
  channel: number;
  math: number;
  awg: number;
  cursors: CursorMode;
  /** Cursor positions: times in seconds relative to trigger, volts on the selected channel. */
  ca: number;
  cb: number;
  va: number;
  vb: number;
  persistence: boolean;
  inspector: boolean;
};

const KEY = `${C.ui.storage_prefix}.ui`;
const DEFAULT: Ui = { view: "scope", section: "vertical", channel: 1, math: 1, awg: 1, cursors: "off", ca: -2e-4, cb: 2e-4, va: 0.5, vb: -0.5, persistence: false, inspector: true };

function load(): Ui {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) ?? "null");
    if (s && typeof s === "object") return { ...DEFAULT, ...s };
  } catch {
    /* private mode or bad JSON */
  }
  return DEFAULT;
}

let ui = load();
const listeners = new Set<() => void>();

export function setUi(patch: Partial<Ui> | ((u: Ui) => Partial<Ui>)): void {
  ui = { ...ui, ...(typeof patch === "function" ? patch(ui) : patch) };
  try {
    localStorage.setItem(KEY, JSON.stringify(ui));
  } catch {
    /* private mode */
  }
  for (const l of listeners) l();
}

export const getUi = () => ui;

export function useUi<T>(select: (u: Ui) => T): T {
  return useSyncExternalStore(
    (l) => (listeners.add(l), () => listeners.delete(l)),
    () => select(ui),
  );
}
