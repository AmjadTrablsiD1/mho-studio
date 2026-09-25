// Deep memory: read the whole acquisition memory, then zoom through it without
// going back to the instrument. Views are min/max envelopes, so a one-sample
// glitch in 25 Mpts still shows at full zoom-out.

import { useEffect, useState } from "react";
import { C } from "../../../core/src/constants.ts";
import { fmt } from "../../../core/src/format.ts";
import { attempt, get, post, useLive } from "../api.ts";
import { Plot, type Series } from "../charts/Plot.tsx";
import { sourceColor, sourceLabel } from "../theme.ts";

type ViewData = { src: string; from: number; to: number; cols: number; min: number[]; max: number[]; xinc: number; xorigin: number };
type Measured = Record<string, number | null>;

const DEPTHS = [100_000, 1_000_000, 5_000_000, 10_000_000, 25_000_000];

export function DeepView() {
  const meta = useLive((s) => s.deep);
  const progress = useLive((s) => s.deepProgress);
  const busy = useLive((s) => s.busy);
  const values = useLive((s) => s.values);
  const [chs, setChs] = useState<string[]>(["CHANnel1", "CHANnel2"]);
  const [maxPoints, setMaxPoints] = useState(1_000_000);
  const [resume, setResume] = useState(true);
  const [range, setRange] = useState<[number, number] | null>(null);
  const [views, setViews] = useState<ViewData[]>([]);
  const [measured, setMeasured] = useState<{ src: string; m: Measured; from: number; to: number } | null>(null);
  const capturing = busy === "deep capture";

  useEffect(() => {
    if (meta) setRange([0, meta.points]);
    setMeasured(null);
  }, [meta?.capturedAt]);

  useEffect(() => {
    if (!meta || !range) return;
    const t = setTimeout(() => {
      void Promise.all(meta.channels.map((c) => get<ViewData>(`deep/view?src=${c.src}&from=${Math.floor(range[0])}&to=${Math.ceil(range[1])}&cols=${C.deep.view_columns}`)))
        .then(setViews)
        .catch(() => {});
    }, 60);
    return () => clearTimeout(t);
  }, [meta?.capturedAt, range?.[0], range?.[1]]);

  const toIndex = (t: number) => (meta ? (t - meta.xorigin) / meta.xinc : 0);
  const zoom = (centreT: number, factor: number) => {
    if (!meta || !range) return;
    const c = toIndex(centreT);
    const span = Math.max(50, (range[1] - range[0]) * factor);
    let a = c - (c - range[0]) * (span / (range[1] - range[0]));
    a = Math.max(0, Math.min(meta.points - span, a));
    setRange([a, Math.min(meta.points, a + span)]);
  };
  const series: Series[] = views.map((v) => ({
    x: v.min.map((_, i) => v.xorigin + (v.from + ((i + 0.5) * (v.to - v.from)) / v.cols) * v.xinc),
    y: v.min,
    y2: v.max,
    color: sourceColor(v.src),
    width: 1,
  }));
  const ymin = views.length ? Math.min(...views.map((v) => Math.min(...v.min))) : -1;
  const ymax = views.length ? Math.max(...views.map((v) => Math.max(...v.max))) : 1;
  const pad = (ymax - ymin) * 0.08 || 0.1;
  const t0 = meta && range ? meta.xorigin + range[0] * meta.xinc : 0;
  const t1 = meta && range ? meta.xorigin + range[1] * meta.xinc : 1;

  return (
    <>
      <div className="toolbar">
        <h1>Deep memory</h1>
        {[1, 2, 3, 4].map((n) => {
          const s = `CHANnel${n}`;
          const on = chs.includes(s);
          return (
            <label key={n} className="row" style={{ gap: 5, fontSize: 11, color: on ? sourceColor(s) : "var(--muted)", fontWeight: 600 }}>
              <input type="checkbox" checked={on} disabled={capturing} onChange={() => setChs(on ? chs.filter((x) => x !== s) : [...chs, s].sort())} /> CH{n}
              {values[`channel.display@${n}`] !== true && <span className="muted" style={{ fontWeight: 400 }}>(off)</span>}
            </label>
          );
        })}
        <select className="input" style={{ width: 120 }} aria-label="Points per channel" value={maxPoints} disabled={capturing} onChange={(e) => setMaxPoints(Number(e.target.value))}>
          {DEPTHS.map((d) => <option key={d} value={d}>≤ {fmt(d, "pts", 3)}</option>)}
        </select>
        <label className="row" style={{ gap: 5, fontSize: 11 }}><input type="checkbox" checked={resume} onChange={(e) => setResume(e.target.checked)} /> Run again after</label>
        {capturing ? (
          <button className="btn danger" onClick={() => void attempt(() => post("deep/cancel"))}>Cancel</button>
        ) : (
          <button className="btn primary" data-test="deep-capture" disabled={!chs.length || !!busy} onClick={() => void attempt(() => post("deep/capture", { channels: chs, maxPoints, resume }))}>Stop &amp; read memory</button>
        )}
        <span className="grow" />
        {meta && range && (
          <>
            <button className="btn small" onClick={() => setRange([0, meta.points])}>Zoom to all</button>
            <a className="btn small" href={`./api/deep/export.csv?from=${Math.floor(range[0])}&to=${Math.ceil(range[1])}`}>CSV (visible)</a>
            <a className="btn small" href="./api/deep/export.csv">CSV (all)</a>
          </>
        )}
      </div>
      <div className="pane">
        <div className="view-grid" style={{ gridTemplateColumns: "minmax(0,1fr) 290px" }}>
          <div className="plot-card" data-test="deep-plot">
            {capturing && progress && (
              <div className="empty" style={{ zIndex: 2, background: "color-mix(in srgb, var(--screen) 85%, transparent)" }}>
                <h3>Reading {sourceLabel(progress.src)} ({progress.channel}/{progress.channels})</h3>
                <div className="progress" style={{ width: 320 }}><div style={{ width: `${(100 * progress.done) / progress.total}%` }} /></div>
                <p className="mono">{fmt(progress.done, "pts", 3)} of {fmt(progress.total, "pts", 3)} · {fmt(progress.bytesPerSec, "B/s", 3)}</p>
              </div>
            )}
            {meta && views.length ? (
              <Plot
                title="Drag to zoom · wheel to zoom about the pointer"
                x={{ min: t0, max: t1, unit: "s" }}
                y={{ min: ymin - pad, max: ymax + pad, unit: "V" }}
                series={series}
                onSelect={(a, b) => setRange([Math.max(0, toIndex(a)), Math.min(meta.points, toIndex(b))])}
                onZoom={zoom}
                hoverText={(t) => fmt(t, "s", 5)}
              />
            ) : (
              !capturing && (
                <div className="empty">
                  <h3>No capture yet</h3>
                  <p>Stops the scope and reads every point of the acquisition memory (RAW mode, in chunks of {fmt(C.instrument.raw_chunk_points, "pts", 3)}), then lets you zoom, measure and export it here. A 25 Mpt channel is 50 MB over the LAN.</p>
                </div>
              )
            )}
          </div>
          <div style={{ display: "grid", gap: 10, alignContent: "start", overflowY: "auto", minHeight: 0 }}>
            <div className="card">
              <div className="card-head">Capture</div>
              <div className="card-body">
                {meta ? (
                  <>
                    <div className="metric-row"><span>Points / channel</span><strong>{meta.points.toLocaleString()}</strong></div>
                    <div className="metric-row"><span>Sample interval</span><strong>{fmt(meta.xinc, "s", 4)}</strong></div>
                    <div className="metric-row"><span>Sample rate</span><strong>{fmt(1 / meta.xinc, "Sa/s", 4)}</strong></div>
                    <div className="metric-row"><span>Record length</span><strong>{fmt(meta.points * meta.xinc, "s", 4)}</strong></div>
                    <div className="metric-row"><span>Transfer</span><strong>{meta.seconds.toFixed(1)} s</strong></div>
                    <div className="metric-row"><span>Visible</span><strong>{range ? `${fmt(range[1] - range[0], "pts", 3)} · ${fmt(t1 - t0, "s", 3)}` : "—"}</strong></div>
                  </>
                ) : (
                  <p className="body-text" style={{ margin: 0 }}>Nothing captured in this session.</p>
                )}
              </div>
            </div>
            {meta && range && (
              <div className="card">
                <div className="card-head">
                  Measure visible range
                </div>
                <div className="card-body">
                  <div className="row wrap" style={{ marginBottom: 8 }}>
                    {meta.channels.map((c) => (
                      <button key={c.src} className="btn small" style={{ color: sourceColor(c.src) }} onClick={async () => {
                        const r = await attempt(() => get<{ measured: Measured }>(`deep/spectrum?src=${c.src}&from=${Math.floor(range[0])}&to=${Math.ceil(range[1])}`));
                        if (r) setMeasured({ src: c.src, m: r.measured, from: range[0], to: range[1] });
                      }}>{sourceLabel(c.src)}</button>
                    ))}
                  </div>
                  {measured && (
                    <>
                      <span className="muted" style={{ fontSize: 10 }}>{sourceLabel(measured.src)}, first {fmt(Math.min(1 << 20, measured.to - measured.from), "pts", 3)} of the visible range</span>
                      {(["VPP", "VMAX", "VMIN", "VAVG", "ACRMs", "FREQuency", "PERiod", "RTIMe", "FTIMe", "PDUTy", "PEDGes"] as const).map((k) => (
                        <div key={k} className="metric-row"><span>{k}</span><strong>{fmt(measured.m[k], k === "FREQuency" ? "Hz" : k === "PDUTy" ? "%" : k === "PEDGes" ? "" : /TIM|PER/.test(k) ? "s" : "V", 4)}</strong></div>
                      ))}
                    </>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
