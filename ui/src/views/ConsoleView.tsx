// SCPI console: any command, with completion from the programming guide's
// full command list (the X-Stream remote control set on a LeCroy, where a VBS
// line reaches everything else), history, the error queue after every command, and an
// optional view of all traffic (including the app's own polling).

import { useEffect, useMemo, useRef, useState } from "react";
import { C } from "../../../core/src/constants.ts";
import manual from "../../../core/src/registry/manual.json";
import { LECROY_CONSOLE } from "../../../core/src/registry/lecroy.ts";
import { attempt, post, useLive } from "../api.ts";

type Entry = { t: number; kind: "out" | "in" | "err" | "note"; text: string };
type Reply = { reply: string | null; block: { bytes: number; text: string | null; hex: string } | null; errors: { code: number; message: string }[] };

const HKEY = `${C.ui.storage_prefix}.console`;
const RIGOL_COMMANDS = (manual as { commands: { header: string; set: boolean; query: boolean; section: string; params: { name: string; type: string; options?: string[]; range?: string }[] }[] }).commands;

function loadHistory(): string[] {
  try {
    return JSON.parse(localStorage.getItem(HKEY) ?? "[]");
  } catch {
    return [];
  }
}

export function ConsoleView() {
  const connected = useLive((s) => s.link?.state === "connected");
  const traffic = useLive((s) => s.traffic);
  const lecroy = useLive((s) => s.link?.family === "lecroy");
  const COMMANDS = lecroy ? LECROY_CONSOLE : RIGOL_COMMANDS;
  const [log, setLog] = useState<Entry[]>([{ t: Date.now(), kind: "note", text: "Type a command. A '?' makes it a query. Tab completes from the instrument's command list (the MHO900 guide on a RIGOL; on a LeCroy the common remote-control set, and VBS? 'return=app.…' reads any automation property); ↑/↓ walk the history." }]);
  const [cmd, setCmd] = useState("");
  const [hist, setHist] = useState<string[]>(loadHistory);
  const [hi, setHi] = useState(-1);
  const [sel, setSel] = useState(0);
  const [all, setAll] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);

  const suggestions = useMemo(() => {
    const q = cmd.trim().split(/\s/)[0].toLowerCase();
    if (q.length < 2 || cmd.includes(" ")) return [];
    return COMMANDS.filter((c) => c.header.toLowerCase().replace(/[<>[\]]/g, "").includes(q.replace(/^:/, "")) || c.header.toLowerCase().includes(q)).slice(0, 14);
  }, [cmd, COMMANDS]);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [log, all, traffic.length]);

  const send = async () => {
    const c = cmd.trim();
    if (!c) return;
    const h = [c, ...hist.filter((x) => x !== c)].slice(0, C.ui.console_history);
    setHist(h);
    try {
      localStorage.setItem(HKEY, JSON.stringify(h));
    } catch {
      /* private mode */
    }
    setHi(-1);
    setCmd("");
    const add = (e: Omit<Entry, "t">[]) => setLog((l) => [...l.slice(-400), ...e.map((x) => ({ ...x, t: Date.now() }))]);
    add([{ kind: "out", text: c }]);
    const r = await attempt(() => post<Reply>("console", { cmd: c }));
    if (!r) return;
    const out: Omit<Entry, "t">[] = [];
    if (r.reply !== null) out.push({ kind: "in", text: r.reply || "(empty reply)" });
    if (r.block) out.push({ kind: "in", text: r.block.text ?? `#block ${r.block.bytes} bytes: ${r.block.hex}${r.block.bytes > 64 ? " …" : ""}` });
    for (const e of r.errors) out.push({ kind: "err", text: `${e.code}, ${e.message}` });
    if (!out.length) out.push({ kind: "note", text: "ok (no error in the queue)" });
    add(out);
  };

  const complete = (header: string) => {
    const expanded = header.replace(/<\w+>/g, "1").replace(/\[:[A-Za-z]+\]/g, "");
    setCmd(expanded);
    setSel(0);
  };

  const shown: Entry[] = all ? traffic.map((t) => ({ t: t.t, kind: t.dir === "out" ? "out" : "in", text: t.text })) : log;
  return (
    <>
      <div className="toolbar">
        <h1>SCPI console</h1>
        <span className="hint">{connected ? "Commands go straight to the instrument." : "Not connected — connect first."}</span>
        <span className="grow" />
        <div className="segmented">
          <button className={!all ? "active" : ""} onClick={() => setAll(false)}>This console</button>
          <button className={all ? "active" : ""} onClick={() => setAll(true)}>All traffic</button>
        </div>
        <button className="btn small" onClick={() => setLog([])}>Clear</button>
      </div>
      <div className="pane">
        <div className="console">
          <div className="console-log" ref={logRef} data-test="console-log">
            {shown.map((e, i) => (
              <div key={i} className={e.kind}>
                <span className="t">{new Date(e.t).toLocaleTimeString()}</span>
                {e.kind === "out" ? "→ " : e.kind === "in" ? "← " : e.kind === "err" ? "✕ " : "· "}
                {e.text}
              </div>
            ))}
          </div>
          <form className="console-input" onSubmit={(e) => (e.preventDefault(), void send())}>
            {suggestions.length > 0 && (
              <div className="suggest" role="listbox">
                {suggestions.map((s, i) => (
                  <button type="button" key={s.header} role="option" aria-selected={i === sel} className={i === sel ? "active" : ""} onClick={() => complete(s.header)}>
                    <span>{s.header}{s.query && !s.set ? "?" : ""}</span>
                    <span>§{s.section} · {s.set && s.query ? "set/query" : s.query ? "query" : "command"}{s.params.filter((p) => p.name !== "n")[0]?.options ? ` · ${s.params.filter((p) => p.name !== "n")[0].options!.slice(0, 5).join("|")}` : s.params.filter((p) => p.name !== "n")[0]?.range ? ` · ${s.params.filter((p) => p.name !== "n")[0].range}` : ""}</span>
                  </button>
                ))}
              </div>
            )}
            <input
              className="input"
              style={{ height: 32 }}
              aria-label="SCPI command"
              data-test="console-input"
              placeholder={lecroy ? "C1:VDIV?   or   VBS? 'return=app.Acquisition.C1.VerScale'" : ":TIMebase:MAIN:SCALe?"}
              value={cmd}
              disabled={!connected}
              onChange={(e) => (setCmd(e.target.value), setSel(0))}
              onKeyDown={(e) => {
                if (e.key === "Tab" && suggestions.length) {
                  e.preventDefault();
                  complete(suggestions[sel].header);
                } else if (e.key === "ArrowDown" && suggestions.length) {
                  e.preventDefault();
                  setSel((s) => Math.min(suggestions.length - 1, s + 1));
                } else if (e.key === "ArrowUp" && suggestions.length) {
                  e.preventDefault();
                  setSel((s) => Math.max(0, s - 1));
                } else if (e.key === "ArrowUp" && hist.length) {
                  e.preventDefault();
                  const i = Math.min(hist.length - 1, hi + 1);
                  setHi(i);
                  setCmd(hist[i]);
                } else if (e.key === "ArrowDown" && hi >= 0) {
                  e.preventDefault();
                  const i = hi - 1;
                  setHi(i);
                  setCmd(i < 0 ? "" : hist[i]);
                }
              }}
            />
            <button className="btn primary" type="submit" disabled={!connected || !cmd.trim()}>Send</button>
          </form>
        </div>
      </div>
    </>
  );
}
