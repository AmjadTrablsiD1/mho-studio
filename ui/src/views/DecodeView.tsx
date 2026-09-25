// Serial and parallel bus decoding (the instrument decodes; this reads its
// event table) and the 16-channel logic analyser set-up.

import { useEffect, useState } from "react";
import { key } from "../../../core/src/registry/controls.ts";
import { attempt, get, post, useLive } from "../api.ts";
import { Ctl, GroupPanel } from "../components/Controls.tsx";

const BUS_SUB: Record<string, string> = { PARallel: "parallel", RS232: "rs232", IIC: "iic", SPI: "spi", CAN: "can", LIN: "lin", FLEXray: "flexray", IIS: "iis", M1553: "m1553" };
type Table = { protocol: string; header: string[]; rows: string[][] };
type Dig = { enable: boolean | null; label: string | null };

export function DecodeView() {
  const [bus, setBus] = useState(1);
  const mode = useLive((s) => String(s.values[key("bus.mode", bus)] ?? "PARallel"));
  const [table, setTable] = useState<Table | null>(null);
  const sub = BUS_SUB[mode];
  return (
    <>
      <div className="toolbar">
        <h1>Decode &amp; logic</h1>
        <div className="segmented" role="radiogroup" aria-label="Bus">
          {[1, 2, 3, 4].map((n) => <button key={n} className={bus === n ? "active" : ""} onClick={() => (setBus(n), setTable(null))}>Bus {n}</button>)}
        </div>
        <span className="grow" />
        <button className="btn primary" data-test="bus-read" onClick={async () => setTable(await attempt(() => get<Table>(`bus/${bus}`)))}>Read event table</button>
      </div>
      <div className="pane">
        <div className="view-grid" style={{ gridTemplateColumns: "340px minmax(0,1fr) 330px" }}>
          <div className="card" style={{ overflowY: "auto", minHeight: 0 }}>
            <div className="card-head">Bus {bus}</div>
            <div className="card-body">
              <div className="section">
                <Ctl id="bus.mode" n={bus} />
                <Ctl id="bus.display" n={bus} />
                <Ctl id="bus.format" n={bus} />
                <Ctl id="bus.event" n={bus} />
                <Ctl id="bus.label" n={bus} />
                <Ctl id="bus.position" n={bus} />
              </div>
              {sub && <GroupPanel key={`${bus}-${sub}`} group="bus" sub={sub} n={bus} />}
            </div>
          </div>
          <div className="card" style={{ display: "flex", flexDirection: "column", minHeight: 0 }}>
            <div className="card-head">
              <span>Event table {table ? `· ${table.protocol} · ${table.rows.length} rows` : ""}</span>
              {table && table.rows.length > 0 && (
                <button className="btn small" onClick={() => {
                  const csv = [table.header.join(","), ...table.rows.map((r) => r.join(","))].join("\n");
                  const a = document.createElement("a");
                  a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
                  a.download = `MHO984-bus${bus}-${table.protocol}.csv`;
                  a.click();
                }}>Save CSV</button>
              )}
            </div>
            <div className="table-scroll">
              {table ? (
                <table className="table" data-test="bus-table">
                  <thead><tr>{table.header.map((h) => <th key={h}>{h}</th>)}</tr></thead>
                  <tbody>{table.rows.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j} className={j === 0 ? "n" : "mono"}>{c}</td>)}</tr>)}</tbody>
                </table>
              ) : (
                <p className="body-text" style={{ padding: "0 12px" }}>Turn the bus on, set its protocol and sources, then read the table (:BUS{bus}:DATA?). The instrument decodes what is in its current acquisition; stop it first for a stable table.</p>
              )}
            </div>
          </div>
          <Logic />
        </div>
      </div>
    </>
  );
}

function Logic() {
  const connected = useLive((s) => s.link?.state === "connected");
  const [dig, setDig] = useState<Dig[]>([]);
  const [editing, setEditing] = useState<number | null>(null);
  useEffect(() => {
    if (!connected) return;
    let cancelled = false;
    void (async () => {
      const out: Dig[] = [];
      for (let d = 0; d < 16; d++) out.push((await post<Dig>("digital", { ch: d }).catch(() => ({ enable: null, label: null }))) as Dig);
      if (!cancelled) setDig(out);
    })();
    return () => {
      cancelled = true;
    };
  }, [connected]);
  const patch = async (d: number, p: { enable?: boolean; label?: string }) => {
    const r = await attempt(() => post<Dig>("digital", { ch: d, ...p }));
    if (r) setDig((x) => x.map((v, i) => (i === d ? r : v)));
  };
  return (
    <div className="card" style={{ overflowY: "auto", minHeight: 0 }}>
      <div className="card-head">Logic analyser · 16 digital channels</div>
      <div className="card-body">
        <div className="section">
          <Ctl id="la.enable" />
          <Ctl id="la.pod.display" n={1} label="D0–D7 shown" />
          <Ctl id="la.pod.threshold" n={1} label="D0–D7 threshold" />
          <Ctl id="la.pod.display" n={2} label="D8–D15 shown" />
          <Ctl id="la.pod.threshold" n={2} label="D8–D15 threshold" />
          <Ctl id="la.size" />
          <Ctl id="la.autosort" />
          <Ctl id="la.active" />
        </div>
        <div className="section">
          <div className="section-title">Channels</div>
          <div className="dchan">
            {Array.from({ length: 16 }, (_, d) => (
              <button key={d} className={dig[d]?.enable ? "on" : ""} onClick={() => void patch(d, { enable: !dig[d]?.enable })} onDoubleClick={() => setEditing(d)} title={`D${d}${dig[d]?.label ? ` — ${dig[d]!.label}` : ""} (double-click to rename)`}>
                D{d}
              </button>
            ))}
          </div>
          {editing !== null && (
            <form className="row" style={{ marginTop: 8 }} onSubmit={(e) => {
              e.preventDefault();
              const v = (new FormData(e.currentTarget).get("label") as string) ?? "";
              void patch(editing, { label: v }).then(() => setEditing(null));
            }}>
              <input name="label" className="input" defaultValue={dig[editing]?.label ?? ""} aria-label={`Label for D${editing}`} autoFocus />
              <button className="btn small" type="submit">Label D{editing}</button>
            </form>
          )}
        </div>
        <p className="body-text">Digital channels are set up here and used by triggers, decoding and measurements on the instrument. The MHO900 guide has no command that transfers digital waveform data, so they are not drawn in this app's screen — the instrument screenshot shows them.</p>
      </div>
    </div>
  );
}
