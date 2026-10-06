// Every settable and readable value the app knows for the instrument on the
// line — the whole MHO900 programming guide on a RIGOL, the common X-Stream
// set on a LeCroy — grouped, each with its command on hover. This is where
// "all of the instrument" lives when it has no dedicated panel.

import { useEffect, useMemo, useState } from "react";
import { groups, key } from "../../../core/src/registry/controls.ts";
import { GROUP_LABEL, mnemonicLabel } from "../../../core/src/registry/labels.ts";
import { readKeys, useLive } from "../api.ts";
import { Ctl, GroupPanel } from "../components/Controls.tsx";
import { useReg } from "../registry.ts";

const ORDER = ["channel", "timebase", "acquire", "trigger", "measure", "math", "source", "counter", "dvm", "cursor", "display", "la", "bus", "histogram", "mask", "record", "search", "navigate", "reference", "save", "load", "bodeplot", "autoset", "system", "lan", "quick", "root", "common", "waveform"];

export function SettingsView() {
  const connected = useLive((s) => s.link?.state === "connected");
  const r = useReg();
  const CONTROLS = r.controls;
  const all = useMemo(() => groups(r.controls).sort((a, b) => (ORDER.indexOf(a.group) + 100) % 200 - (ORDER.indexOf(b.group) + 100) % 200), [r]);
  const [group, setGroup] = useState("trigger");
  const [n, setN] = useState(1);
  const [q, setQ] = useState("");
  const g = all.find((x) => x.group === group);
  const suffixCount = CONTROLS.find((c) => c.group === group && c.suffix)?.suffix?.values.length ?? 0;
  const hits = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (s.length < 2) return [];
    return CONTROLS.filter((c) => !c.hidden && (c.label.toLowerCase().includes(s) || c.header.toLowerCase().includes(s) || c.id.includes(s))).slice(0, 60);
  }, [q, CONTROLS]);
  useEffect(() => {
    if (connected && hits.length) void readKeys(hits.filter((c) => c.query).map((c) => key(c.id, c.suffix ? 1 : null))).catch(() => {});
  }, [connected, hits.map((h) => h.id).join()]);
  const count = CONTROLS.filter((c) => !c.hidden).length;
  return (
    <>
      <div className="toolbar">
        <h1>All settings</h1>
        <span className="hint">{count} values from the {r.doc} — hover a label for its command{r.family === "lecroy" ? "; anything else goes through VBS in the console" : ""}</span>
        <span className="grow" />
        <input className="input" style={{ width: 240 }} placeholder="Search: holdoff, :TRIG:SPI, baud…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search settings" data-test="settings-search" />
      </div>
      <div className="pane" style={{ display: "grid", gridTemplateColumns: "190px minmax(0,1fr)" }}>
        <nav className="rail" style={{ borderRight: "1px solid var(--line)" }} aria-label="Groups">
          {all.map((x) => (
            <button key={x.group} className={`nav-item${!q && group === x.group ? " active" : ""}`} onClick={() => (setGroup(x.group), setQ(""), setN(1))}>
              {GROUP_LABEL[x.group] ?? mnemonicLabel(x.group.toUpperCase())}
              <span className="count">{CONTROLS.filter((c) => c.group === x.group && !c.hidden).length}</span>
            </button>
          ))}
        </nav>
        <div className="pane scroll">
          {q.trim().length >= 2 ? (
            <div style={{ padding: 14, maxWidth: 560 }}>
              {hits.length === 0 && <p className="body-text">Nothing matches.</p>}
              {hits.map((c) => (
                <div key={c.id}>
                  <div className="muted mono" style={{ fontSize: 9.5, marginTop: 6 }}>{c.header}{r.family === "rigol" ? ` · §${c.section}` : ""}{c.suffix ? " · shown for n = 1" : ""}</div>
                  <Ctl id={c.id} n={c.suffix ? 1 : null} />
                </div>
              ))}
            </div>
          ) : (
            <>
              {suffixCount > 1 && (
                <div className="toolbar" style={{ position: "sticky", top: 0, zIndex: 2 }}>
                  <span className="muted">Instance</span>
                  <div className="segmented">
                    {Array.from({ length: suffixCount }, (_, i) => i + 1).map((i) => <button key={i} className={n === i ? "active" : ""} onClick={() => setN(i)}>{i}</button>)}
                  </div>
                </div>
              )}
              <div className="settings-list" data-test="settings-groups">
                {g?.subs.map((sub) => (
                  <div className="card" key={`${group}-${sub}-${n}`}>
                    <div className="card-body">
                      <GroupPanel group={group} sub={sub} n={n} />
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    </>
  );
}
