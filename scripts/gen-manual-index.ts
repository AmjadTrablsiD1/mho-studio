#!/usr/bin/env node
// Turn the MHO900 Programming Guide into core/src/registry/manual.json: every
// command header with its parameter types, option lists, ranges and defaults.
//
//   pdftotext -layout MHO900-ProgrammingGuide.pdf pg.txt
//   node scripts/gen-manual-index.ts pg.txt
//
// Only facts are kept (headers, types, ranges, defaults, section numbers); the
// guide's prose is not copied. Labels are made from the header, not the text.
// The output is committed; this script is only re-run for a new guide revision.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const src = process.argv[2];
if (!src) {
  console.error("usage: node scripts/gen-manual-index.ts <pdftotext -layout output>");
  process.exit(1);
}

const NOISE = /Copyright|Programming Guide *$|^\s*$|^\s*[0-9]{1,3}\s*$|^\s*Command System\s*$|^\s*(Application Examples|[IVXL]+)\s*$/;
const lines = readFileSync(src, "utf8")
  .split("\n")
  .filter((l) => !NOISE.test(l))
  .map((l) => l.replace(/\s{2,}/g, " ").replace(/Command System/g, "").trimEnd());

type Block = { section: string; title: string; S: string[]; P: string[] };
const blocks: Block[] = [];
let cur: Block | null = null;
let mode = "";
let body = false;
for (const l of lines) {
  // The table of contents repeats every header; the body starts at chapter 3's first real section.
  const h = /^\s*(3\.\d+(?:\.\d+)+) ([:*][^.]*?)(?:\s*\.{3,}.*)?$/.exec(l);
  if (h) {
    if (h[1] === "3.1.1") body = true;
    if (!body) continue;
    cur = { section: h[1], title: h[2].trim(), S: [], P: [] };
    blocks.push(cur);
    mode = "";
    continue;
  }
  if (!cur) continue;
  if (/^4 Application Examples/.test(l) || /^4\.1 /.test(l)) break;
  const m = /^ (Syntax|Description|Parameter|Remarks|Return Format|Example|Related Command)\s*$/.exec(l);
  if (m) {
    mode = m[1];
    continue;
  }
  if (/^3\.\d+ /.test(l)) {
    mode = "";
    continue;
  }
  if (mode === "Syntax") cur.S.push(l.trim());
  else if (mode === "Parameter" && !/Name Type Range Default/.test(l)) cur.P.push(l.trim());
}

const TYPES = ["Bool", "Discrete", "Integer", "Real", "ASCII String", "Binary"] as const;
type Param = {
  name: string;
  type: (typeof TYPES)[number];
  options?: string[];
  min?: number;
  max?: number;
  unit?: string;
  default?: string | number;
  range?: string;
};

const SI: Record<string, number> = { b: 1, p: 1e-12, n: 1e-9, "μ": 1e-6, u: 1e-6, m: 1e-3, "": 1, k: 1e3, K: 1e3, M: 1e6, G: 1e9 };
/** "50 mV" → {v: 0.05, unit: "V"}; "2 μs/div" → {v: 2e-6, unit: "s/div"}; "4" → {v: 4}. */
function quantity(s: string): { v: number; unit: string } | null {
  const m = /^([+-]?\d+(?:\.\d+)?(?:e[+-]?\d+)?)\s*([pnμumkKMG]?)(V|s|Hz|dB|%|°|A|W|pts|V\/div|s\/div|Vpp|dBV|bps)?(\/div)?$/.exec(s.trim().replace(/,/g, ""));
  if (!m) return null;
  let prefix = m[2];
  let unit = (m[3] ?? "") + (m[4] ?? "");
  // A bare "m" or "M" with no unit is a prefix only when a unit follows.
  if (!unit && prefix) return null;
  return { v: Number(m[1]) * (SI[prefix] ?? 1), unit };
}

function parseParams(P: string[]): Param[] {
  const params: Param[] = [];
  let braceOpen = false;
  let braceText = "";
  let braceOwner: Param | null = null;
  let pendingBrace = ""; // brace text that started before its declaration line
  for (const raw of P) {
    const line = raw.replace(/^Refer$|^toRemarks$/, "");
    const decl = /<(\w+)>\s+(Bool|Discrete|Integer|Real|ASCII String|Binary)\b\s*(.*)$/.exec(line);
    let rest = line;
    if (decl) {
      const p: Param = { name: decl[1], type: decl[2] as Param["type"] };
      params.push(p);
      rest = decl[3].replace(/\s+-$/, "");
      if (braceOpen) braceOwner = p;
      // Default and range come from what follows the type on the declaration line.
      if (p.type === "Bool") {
        p.options = ["ON", "OFF"];
        const d = /\{\{1\|ON\}\|\{0\|OFF\}\}\s*(\S+)?/.exec(rest);
        if (d?.[1]) p.default = /ON|1/.test(d[1]) ? "ON" : /OFF|0/.test(d[1]) ? "OFF" : undefined;
        rest = "";
      } else if (p.type === "Integer" || p.type === "Real") {
        const r = /Refer/.test(rest) ? null : /^(.*?)\s+to\s+(.*)$/.exec(rest);
        if (r) {
          // "<lo> to <hi> <default>": the default is the last token, if it parses as a quantity
          const hiParts = r[2].trim().split(/\s+/);
          let def: string | undefined;
          const last = hiParts[hiParts.length - 1];
          // "10s 8 ns": try the last two tokens as the default first, then the last one
          const two = hiParts.slice(-2).join(" ");
          if (hiParts.length > 2 && quantity(two) && quantity(hiParts.slice(0, -2).join(" "))) {
            def = two;
            hiParts.splice(-2);
          } else if (hiParts.length > 1 && quantity(last) && quantity(hiParts.slice(0, -1).join(" "))) {
            def = last;
            hiParts.splice(-1);
          }
          const lo = quantity(r[1]);
          const hi = quantity(hiParts.join(" "));
          p.range = `${r[1].trim()} to ${hiParts.join(" ")}`;
          if (lo) p.min = lo.v;
          if (hi) p.max = hi.v;
          const u = hi?.unit || lo?.unit;
          if (u) p.unit = u.replace(/\/div$/, "");
          if (def) {
            const q = quantity(def);
            p.default = q ? q.v : def;
            if (q?.unit && !p.unit) p.unit = q.unit;
          }
        } else if (rest && !/Refer/.test(rest)) {
          const q = quantity(rest.split(/\s+/).slice(-1)[0] ?? "");
          if (q) p.default = q.v;
        } else if (/Refer/.test(rest)) {
          const tail = rest.replace(/Refer to\s*Remarks|Refer toRemarks|Refer to|Refer/g, "").trim();
          const q = tail ? quantity(tail) : null;
          if (q) {
            p.default = q.v;
            if (q.unit) p.unit = q.unit.replace(/\/div$/, "");
          }
        }
        rest = "";
      } else if (p.type === "Discrete") {
        // The default is the last whitespace token that is not part of an option list.
        const toks = rest.split(/\s+/).filter(Boolean);
        const last = toks[toks.length - 1];
        if (last && !last.includes("|") && !last.includes("{") && !last.includes("}") && last !== "-" && toks.length >= 1) {
          const before = toks.slice(0, -1).join(" ");
          if (!toks.length || toks.length === 1 || before.endsWith("|") || before.endsWith("}") || before === "") {
            if (!/Refer|Remarks/.test(last)) p.default = last;
            rest = before;
          }
        }
      }
    }
    // Collect brace text; it may span several lines and straddle the declaration.
    for (const ch of rest) {
      if (ch === "{") {
        if (!braceOpen) {
          braceOpen = true;
          braceText = "";
          braceOwner = decl ? params[params.length - 1] : null;
        }
        continue;
      }
      if (ch === "}") {
        if (braceOpen && !/^\s*$/.test(braceText)) {
          braceText += "";
        }
        // Nested braces only occur in Bool, which is handled above; close on the outermost.
        braceOpen = false;
        const owner = braceOwner ?? params[params.length - 1] ?? null;
        const text = pendingBrace + braceText;
        pendingBrace = "";
        if (owner && owner.type !== "Bool") {
          const opts = text.split("|").map((s) => s.trim()).filter((s) => s !== "-" && /^[A-Za-z0-9.+\-_]+$/.test(s));
          owner.options = [...(owner.options ?? []), ...opts];
        } else if (!owner) {
          pendingBrace = text;
        }
        braceText = "";
        continue;
      }
      if (braceOpen) braceText += ch;
    }
    if (braceOpen) braceText += "|";
  }
  // Tidy: collapse split tokens like "D8|" + "|D9" duplicates.
  for (const p of params) {
    if (p.options) p.options = [...new Set(p.options.filter(Boolean))];
    if (p.type === "Discrete" && p.default !== undefined && p.options && !p.options.includes(String(p.default))) {
      // A default not in the list is usually a split token; keep it only if it looks like one of them.
      const d = String(p.default);
      const hit = p.options.find((o) => o.toUpperCase() === d.toUpperCase() || o.replace(/[a-z]/g, "") === d.replace(/[a-z]/g, ""));
      if (hit) p.default = hit;
    }
  }
  return params;
}

type Entry = {
  section: string;
  header: string;
  set: boolean;
  query: boolean;
  queryArgs: boolean;
  params: Param[];
};

const entries: Entry[] = [];
for (const b of blocks) {
  const syn = b.S.filter((s) => s.startsWith(":") || s.startsWith("*"));
  const title = b.title.replace(/\s*\(Option\)\s*$/, "");
  if (!syn.length) continue; // a grouping header such as ":TRIGger:EDGE"
  const header = title.replace(/\?$/, "").replace(/\s+/g, "");
  const set = syn.some((s) => !s.split(/\s/)[0].endsWith("?"));
  const qs = syn.find((s) => s.split(/\s/)[0].endsWith("?"));
  const params = parseParams(b.P.filter((p) => p !== "N/A"));
  entries.push({ section: b.section, header, set, query: !!qs, queryArgs: !!qs && /\?\s*\S/.test(qs), params });
}

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "..", "core", "src", "registry", "manual.json");
writeFileSync(
  out,
  JSON.stringify(
    {
      _comment: "Generated by scripts/gen-manual-index.ts from the RIGOL MHO900 Programming Guide. Facts only: headers, parameter types, ranges and defaults. Do not edit by hand; curated overrides live in controls.ts.",
      source: "MHO900 Programming Guide (RIGOL), chapter 3",
      commands: entries,
    },
    null,
    1,
  ) + "\n",
);
console.log(`${entries.length} commands → ${out}`);
