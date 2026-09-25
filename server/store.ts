// What survives a restart: the last instrument address, recent addresses, and
// saved instrument setups (presets). Nothing else is written to disk.

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { C } from "../core/src/constants.ts";

/** "~/x" → absolute. MHO_STUDIO_HOME replaces the home directory (tests use a temp one). */
export function expand(p: string): string {
  const home = process.env.MHO_STUDIO_HOME || homedir();
  return p.startsWith("~/") ? join(home, p.slice(2)) : p;
}

export type Settings = { host: string; port: number; recent: string[]; lastWasSim: boolean };
const DEFAULTS: Settings = { host: "", port: C.instrument.scpi_port, recent: [], lastWasSim: false };

export function loadSettings(): Settings {
  try {
    return { ...DEFAULTS, ...JSON.parse(readFileSync(expand(C.paths.settings_file), "utf8")) };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveSettings(s: Settings): void {
  const f = expand(C.paths.settings_file);
  mkdirSync(dirname(f), { recursive: true });
  const tmp = `${f}.tmp`;
  writeFileSync(tmp, JSON.stringify(s, null, 2));
  renameSync(tmp, f);
}

// ------------------------------------------------------------------ presets

export type PresetMeta = { name: string; savedAt: string; model: string; firmware: string; bytes: number };

const presetDir = () => expand(C.paths.presets_dir);
const safe = (name: string) => {
  const n = name.trim();
  if (!/^[\w .()+-]{1,60}$/.test(n)) throw new Error("preset names use letters, digits, spaces and . ( ) + - _ (at most 60)");
  return n;
};

export function listPresets(): PresetMeta[] {
  const d = presetDir();
  if (!existsSync(d)) return [];
  return readdirSync(d)
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      try {
        return JSON.parse(readFileSync(join(d, f), "utf8")) as PresetMeta;
      } catch {
        return null;
      }
    })
    .filter((x): x is PresetMeta => x !== null)
    .sort((a, b) => b.savedAt.localeCompare(a.savedAt));
}

export function savePreset(name: string, blob: Uint8Array, model: string, firmware: string): PresetMeta {
  const n = safe(name);
  const d = presetDir();
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, `${n}.setup`), blob);
  const meta: PresetMeta = { name: n, savedAt: new Date().toISOString(), model, firmware, bytes: blob.length };
  writeFileSync(join(d, `${n}.json`), JSON.stringify(meta, null, 2));
  return meta;
}

export function readPreset(name: string): Uint8Array {
  const f = join(presetDir(), `${safe(name)}.setup`);
  if (!existsSync(f) || !statSync(f).isFile()) throw new Error(`no preset called "${name}"`);
  return new Uint8Array(readFileSync(f));
}

export function deletePreset(name: string): void {
  const n = safe(name);
  for (const ext of [".setup", ".json"]) {
    const f = join(presetDir(), n + ext);
    if (existsSync(f)) unlinkSync(f);
  }
}
