// The live scope: legend, screen, horizontal/trigger read-out, and the
// measurement table with statistics and the app's independent cross-check.

import { C } from "../../../core/src/constants.ts";
import { key } from "../../../core/src/registry/controls.ts";
import { fmt } from "../../../core/src/format.ts";
import { useReg } from "../registry.ts";
import { attempt, post, useLive } from "../api.ts";
import { setUi, useUi, type CursorMode } from "../uistate.ts";
import { ScopeScreen } from "../scope/ScopeScreen.tsx";
import { sourceLabel, sourceVar } from "../theme.ts";
import { Icon } from "../components/Icons.tsx";
import { ItemSelect, RemoveButton, SourceSelect, addQuick } from "../components/Measurements.tsx";

export function ScopeView() {
  const cursors = useUi((u) => u.cursors);
  const persistence = useUi((u) => u.persistence);
  const rows = useLive((s) => s.measure.length);
  return (
    <>
      <div className="toolbar">
        <h1>Scope</h1>
        <span className="hint">Drag markers · wheel = timebase · Shift+wheel = V/div</span>
        <span className="grow" />
        <span className="muted" style={{ fontSize: 10 }}>Cursors</span>
        <div className="segmented" role="radiogroup" aria-label="Cursors">
          {(["off", "time", "volt", "both"] as CursorMode[]).map((m) => (
            <button key={m} role="radio" aria-checked={cursors === m} className={cursors === m ? "active" : ""} onClick={() => setUi({ cursors: m })} data-test={`cursors-${m}`}>
              {m === "off" ? "Off" : m === "time" ? "Time" : m === "volt" ? "Volts" : "Both"}
            </button>
          ))}
        </div>
        <button className="btn small" onClick={() => void addQuick()} title="Add a measurement on the selected channel; change it in its row below" data-test="measure-quick-add">+ Measurement</button>
        <button className={`icon-btn${persistence ? " on" : ""}`} aria-pressed={persistence} aria-label="Persistence" title="Persistence (P)" onClick={() => setUi({ persistence: !persistence })}><Icon.persist /></button>
      </div>
      <div className="pane" style={{ display: "grid", gridTemplateRows: rows ? "minmax(0,1fr) 196px" : "minmax(0,1fr)" }}>
        <div style={{ position: "relative", minHeight: 0 }}>
          <div className="scope-stage">
            <Legend />
            <ScopeScreen />
            <Foot />
          </div>
        </div>
        {rows > 0 && <MeasureTable />}
      </div>
    </>
  );
}

function Legend() {
  const values = useLive((s) => s.values);
  const selected = useUi((u) => u.channel);
  const items: { src: string; text: string; sub: string; ch: number | null }[] = [];
  for (let n = 1; n <= C.instrument.analog_channels; n++) {
    if (values[key("channel.display", n)] !== true) continue;
    const coup = String(values[key("channel.coupling", n)] ?? "");
    const off = values[key("channel.offset", n)];
    items.push({ src: `CHANnel${n}`, text: `${fmt(values[key("channel.scale", n)] as number, "V", 3)}/div`, sub: `${coup} · ${fmt(off as number, "V", 3)}`, ch: n });
  }
  for (let n = 1; n <= C.instrument.math_channels; n++) {
    if (values[key("math.display", n)] !== true) continue;
    items.push({ src: `MATH${n}`, text: String(values[key("math.operator", n)] ?? ""), sub: "", ch: null });
  }
  return (
    <div className="scope-legend" data-test="legend">
      {items.map((it) => (
        <button key={it.src} className={`legend-item${it.ch === selected ? " selected" : ""}`} onClick={() => it.ch && setUi({ channel: it.ch, section: "vertical" })}>
          <span className="ln" style={{ background: sourceVar(it.src) }} />
          <span style={{ color: sourceVar(it.src), fontWeight: 600 }}>{sourceLabel(it.src)}</span>
          <strong>{it.text}</strong>
          {it.sub && <small>{it.sub}</small>}
        </button>
      ))}
      {items.length === 0 && <span className="muted">No channel is on — switch one on in the rail.</span>}
    </div>
  );
}

function Foot() {
  const v = useLive((s) => s.values);
  const stats = useLive((s) => s.stats);
  const src = String(v["trigger.edge.source"] ?? "");
  const slope = String(v["trigger.edge.slope"] ?? "").toUpperCase();
  const mode = String(v["trigger.mode"] ?? "");
  return (
    <div className="scope-foot" data-test="scope-foot">
      <span>H <b>{fmt(v["timebase.scale"] as number, "s", 3)}/div</b></span>
      <span>pos <b>{fmt(v["timebase.offset"] as number, "s", 3)}</b></span>
      <span><b>{fmt(v["acquire.srate"] as number, "Sa/s", 3)}</b></span>
      <span>mem <b>{typeof v["acquire.mdepth"] === "number" ? fmt(v["acquire.mdepth"], "pts", 3) : String(v["acquire.mdepth"] ?? "—")}</b></span>
      <span>
        T <b>{mode.toUpperCase().startsWith("EDGE") ? `${sourceLabel(src)} ${slope.startsWith("POS") ? "↑" : slope.startsWith("NEG") ? "↓" : "↕"} ${fmt(v["trigger.edge.level"] as number, "V", 3)}` : mode}</b>
      </span>
      <span>sweep <b>{String(v["trigger.sweep"] ?? "—")}</b></span>
      <span className="grow" />
      {stats && <small>{stats.fps.toFixed(1)} screens/s · round trip {stats.rttMs?.toFixed(1) ?? "—"} ms</small>}
    </div>
  );
}

function MeasureTable() {
  const rows = useLive((s) => s.measure);
  const { measurements, screenPoints } = useReg();
  return (
    <div className="bottom">
      <div className="bottom-head">
        <span className="section-title" style={{ margin: 0 }}>Measurements</span>
        <span className="muted" style={{ fontSize: 10 }}>change a row's quantity or channel in place; value from the instrument; cross-check computed here from the {screenPoints}-point screen record</span>
        <span className="grow" />
        <button className="btn small" onClick={() => void addQuick()} disabled={rows.length >= C.measure.max_items}>+ Add</button>
        <button className="btn small" onClick={() => void attempt(() => post("measure/reset"))}>Reset statistics</button>
      </div>
      <div className="table-scroll">
        <table className="table" data-test="measure-table">
          <thead>
            <tr>
              <th>Source</th><th>Measurement</th><th className="n">Current</th><th className="n">Mean</th><th className="n">Min</th><th className="n">Max</th><th className="n">σ</th><th className="n">Count</th><th className="n">Cross-check</th><th />
            </tr>
          </thead>
          <tbody>
            {rows.map((r, index) => {
              const m = measurements.find((x) => x.item === r.slot.item);
              const u = m?.unit ?? "";
              const cell = (x: number | null) => {
                const f = fmt(x, u, 4).split(" ");
                return <>{f[0]}<small>{f[1] ?? ""}</small></>;
              };
              const dev = r.cross !== null && r.value !== null && r.value !== 0 ? (Math.abs(r.cross - r.value) / Math.abs(r.value)) * 100 : null;
              return (
                <tr key={r.slot.id}>
                  <td style={{ whiteSpace: "nowrap" }}>
                    <span className="swatch" style={{ background: sourceVar(r.slot.src1), marginRight: 4, display: "inline-block", verticalAlign: "middle" }} />
                    <SourceSelect slot={r.slot} index={index} />
                    {r.slot.src2 && <> → <SourceSelect slot={r.slot} index={index} which="src2" /></>}
                  </td>
                  <td style={{ minWidth: 150 }}><ItemSelect slot={r.slot} index={index} /></td>
                  <td className="n" style={{ color: "var(--text)", fontWeight: 600 }}>{cell(r.value)}</td>
                  <td className="n">{cell(r.stats.mean)}</td>
                  <td className="n">{cell(r.stats.min)}</td>
                  <td className="n">{cell(r.stats.max)}</td>
                  <td className="n">{cell(r.stats.std)}</td>
                  <td className="n">{r.stats.n}</td>
                  <td className="n" title={`Same quantity computed by MHO Studio from the screen record (${screenPoints} points); a large difference usually means too few points per edge`}>
                    {cell(r.cross)}
                    {dev !== null && <span className={`badge ${dev < 2 ? "ok" : dev < 10 ? "warn" : "alarm"}`} style={{ marginLeft: 6 }}>{dev < 0.1 ? "<0.1" : dev.toFixed(dev < 10 ? 1 : 0)}%</span>}
                  </td>
                  <td><RemoveButton slot={r.slot} label={`${m?.label ?? r.slot.item} on ${sourceLabel(r.slot.src1)}`} /></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
