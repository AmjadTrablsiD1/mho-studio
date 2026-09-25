// SCPI headers as the programming guide writes them — ":CHANnel<n>:SCALe",
// ":TIMebase[:MAIN]:SCALe", "*IDN" — turned into something that can send a
// command and something that can recognise one (the simulator needs the latter).
//
// SCPI accepts exactly the short form (the capitals) or the long form of each
// mnemonic, in any case; nothing in between. Numeric suffixes are written
// "<n>" in the guide and default to 1 when omitted.

export type Suffixes = Record<string, number>;

/** "CHANnel1" → "CHAN1", "HRESolution" → "HRES", "20M" → "20M" (numbers are literal). */
export function shortForm(mnemonic: string): string {
  if (!/^[A-Za-z]/.test(mnemonic)) return mnemonic;
  const m = /^([A-Za-z]+)(\d*)$/.exec(mnemonic);
  if (!m) return mnemonic;
  const caps = m[1].replace(/[a-z]/g, "");
  return (caps || m[1]).toUpperCase() + m[2];
}

type Node = { long: string; short: string; digits: string; suffix: string | null; optional: boolean };

function nodes(template: string): { star: boolean; nodes: Node[] } {
  const t = template.trim().replace(/\?$/, "");
  if (t.startsWith("*")) return { star: true, nodes: [{ long: t.slice(1).toUpperCase(), short: t.slice(1).toUpperCase(), digits: "", suffix: null, optional: false }] };
  const out: Node[] = [];
  // Split on ':' but keep "[:MAIN]" together.
  const re = /\[:([A-Za-z]+)(<\w+>)?\]|:?([A-Za-z]+)(\d*)(<(\w+)>)?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(t))) {
    if (m[1]) {
      out.push({ long: m[1].toUpperCase(), short: shortForm(m[1]), digits: "", suffix: m[2] ? m[2].slice(1, -1) : null, optional: true });
    } else if (m[3]) {
      out.push({ long: m[3].toUpperCase(), short: shortForm(m[3]), digits: m[4] ?? "", suffix: m[6] ?? null, optional: false });
    }
  }
  return { star: false, nodes: out };
}

/** The command to put on the wire, in short form: (":CHANnel<n>:SCALe", {n:2}) → ":CHAN2:SCAL". */
export function render(template: string, suffix: Suffixes = {}, form: "short" | "long" = "short"): string {
  const { star, nodes: ns } = nodes(template);
  if (star) return template.trim().replace(/\?$/, "").toUpperCase();
  let s = "";
  for (const n of ns) {
    if (n.optional) continue;
    const word = form === "short" ? n.short.replace(/\d+$/, "") : n.long;
    const sfx = n.suffix ? String(suffix[n.suffix] ?? 1) : n.digits;
    s += `:${word}${sfx}`;
  }
  return s;
}

export type Compiled = { template: string; re: RegExp; suffixNames: string[] };

/** A matcher for incoming headers (case-insensitive, short or long, optional nodes, suffixes). */
export function compile(template: string): Compiled {
  const { star, nodes: ns } = nodes(template);
  const suffixNames: string[] = [];
  if (star) return { template, re: new RegExp(`^\\*${ns[0].long}$`, "i"), suffixNames };
  let src = "^";
  for (const n of ns) {
    const shortWord = n.short.replace(/\d+$/, "");
    const alts = n.long === shortWord ? n.long : `${n.long}|${shortWord}`;
    let part = `:(?:${alts})`;
    if (n.suffix) {
      suffixNames.push(n.suffix);
      part += "(\\d*)";
    } else if (n.digits) {
      part += n.digits;
    }
    src += n.optional ? `(?:${part})?` : part;
  }
  src += "$";
  return { template, re: new RegExp(src, "i"), suffixNames };
}

/** Suffix values if `header` (":chan2:scal", no '?') is this command, else null. */
export function match(c: Compiled, header: string): Suffixes | null {
  const h = header.startsWith(":") || header.startsWith("*") ? header : `:${header}`;
  const m = c.re.exec(h);
  if (!m) return null;
  const out: Suffixes = {};
  c.suffixNames.forEach((name, i) => (out[name] = m[i + 1] ? Number(m[i + 1]) : 1));
  return out;
}

/**
 * Split a program message into its units: ":WAV:SOUR CHAN1;:WAV:MODE NORM" →
 * two commands. A relative header after ';' inherits the previous path, as
 * IEEE 488.2 says (":TRIG:EDGE:SOUR CHAN1;LEV 0.2" → ":TRIG:EDGE:LEV 0.2").
 * Quoted strings and definite-length blocks are not split.
 */
export function splitMessage(msg: string): { header: string; args: string; query: boolean }[] {
  const units: string[] = [];
  let cur = "";
  let quote = false;
  for (let i = 0; i < msg.length; i++) {
    const ch = msg[i];
    if (ch === '"') quote = !quote;
    if (!quote && ch === "#" && /\d/.test(msg[i + 1] ?? "")) {
      // #<n><len><bytes>: copy the whole block verbatim
      const n = Number(msg[i + 1]);
      const len = n === 0 ? 0 : Number(msg.slice(i + 2, i + 2 + n));
      const end = i + 2 + n + len;
      cur += msg.slice(i, end);
      i = end - 1;
      continue;
    }
    if (!quote && ch === ";") {
      units.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) units.push(cur);
  const out: { header: string; args: string; query: boolean }[] = [];
  let path = "";
  for (const raw of units) {
    const u = raw.trim();
    if (!u) continue;
    const sp = u.search(/\s/);
    let header = sp < 0 ? u : u.slice(0, sp);
    const args = sp < 0 ? "" : u.slice(sp + 1).trim();
    const query = header.endsWith("?");
    if (query) header = header.slice(0, -1);
    if (!header.startsWith(":") && !header.startsWith("*") && path) header = `${path}:${header}`;
    if (!header.startsWith(":") && !header.startsWith("*")) header = `:${header}`;
    if (!header.startsWith("*")) path = header.slice(0, header.lastIndexOf(":"));
    out.push({ header, args, query });
  }
  return out;
}
