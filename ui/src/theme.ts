// Rule 1: themes are data (shared/themes.json) applied as CSS variables.
import themes from "../../shared/themes.json";
import { C } from "../../core/src/constants.ts";

export type ThemeName = "midnight" | "daylight";
type Palette = Record<string, string>;
export const THEMES = themes as unknown as Record<ThemeName, Palette>;
const KEY = `${C.ui.storage_prefix}.theme`;
const listeners = new Set<() => void>();

export function applyTheme(name: ThemeName): void {
  const t = THEMES[name];
  const root = document.documentElement;
  for (const [token, value] of Object.entries(t)) {
    if (token === "label" || token === "scheme") continue;
    root.style.setProperty(`--${token}`, value);
  }
  root.style.colorScheme = t.scheme;
  root.dataset.theme = name;
  try {
    localStorage.setItem(KEY, name);
  } catch {
    /* private mode */
  }
  listeners.forEach((l) => l());
}

export function initialTheme(): ThemeName {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved === "midnight" || saved === "daylight") return saved;
  } catch {
    /* private mode */
  }
  return window.matchMedia("(prefers-color-scheme: light)").matches ? "daylight" : (C.ui.default_theme as ThemeName);
}

export const currentTheme = (): ThemeName => (document.documentElement.dataset.theme as ThemeName) || "midnight";

/** Canvas code that caches colours re-reads them when the theme changes. */
export function onThemeChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** A token's current value, for canvas code that cannot use var(). */
export function token(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(`--${name}`).trim();
}

/** The colour of a trace source: CHANnel2 → --ch2, MATH1 → --math1. */
export function sourceColor(src: string): string {
  const ch = /^CHAN(?:nel)?(\d)$/i.exec(src);
  if (ch) return token(`ch${ch[1]}`);
  const m = /^MATH(\d)$/i.exec(src);
  if (m) return token(`math${m[1]}`);
  if (/^D\d/.test(src)) return token("digital");
  return token("ref");
}
export function sourceVar(src: string): string {
  const ch = /^CHAN(?:nel)?(\d)$/i.exec(src);
  if (ch) return `var(--ch${ch[1]})`;
  const m = /^MATH(\d)$/i.exec(src);
  if (m) return `var(--math${m[1]})`;
  return "var(--digital)";
}
export function sourceLabel(src: string): string {
  const ch = /^CHAN(?:nel)?(\d)$/i.exec(src);
  if (ch) return `CH${ch[1]}`;
  const m = /^MATH(\d)$/i.exec(src);
  if (m) return `M${m[1]}`;
  return src;
}
