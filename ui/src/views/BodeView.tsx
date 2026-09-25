// Frequency response with the built-in generator: configure, run, watch the
// curve grow, read the corner, export. The server does the sweep; every
// setting it touches is restored when it ends.

import { useState } from "react";
import { C } from "../../../core/src/constants.ts";
import { fmt, parseSI } from "../../../core/src/format.ts";
import { unwrap } from "../../../core/src/dsp/bode.ts";
import { attempt, post, useLive } from "../api.ts";
import { Plot } from "../charts/Plot.tsx";
import { token } from "../theme.ts";

export function BodeView() {
  const st = useLive((s) => s.bode);
  const options = useLive((s) => s.options);
  const [cfg, setCfg] = useState({
    startHz: String(C.bode.start_hz),
    stopHz: "1M",
    points: String(C.bode.points),
    spacing: "log",
    amplitudeVpp: String(C.bode.amplitude_vpp),
    awg: String(C.bode.awg),
    inCh: String(C.bode.in_channel),
    outCh: String(C.bode.out_channel),
    settleMs: String(C.bode.settle_ms),
  });
  const running = !!st?.running;
  const pts = st?.points ?? [];
  const ph = unwrap(pts.map((p) => p.phaseDeg));
  const hasAfg = options.AFG100 || options.AFG50;
  const start = () => {
    const n = (s: string) => parseSI(s);
    const body = { startHz: n(cfg.startHz), stopHz: n(cfg.stopHz), points: Number(cfg.points), spacing: cfg.spacing, amplitudeVpp: n(cfg.amplitudeVpp), awg: Number(cfg.awg), inCh: Number(cfg.inCh), outCh: Number(cfg.outCh), settleMs: Number(cfg.settleMs) };
    void attempt(() => post("bode/start", body));
  };
  const f = (k: keyof typeof cfg, label: string, unit?: string) => (
    <div className="field">
      <label htmlFor={`b-${k}`}>{label}{unit ? <span className="muted"> ({unit})</span> : null}</label>
      <input id={`b-${k}`} className="input" value={cfg[k]} disabled={running} onChange={(e) => setCfg({ ...cfg, [k]: e.target.value })} />
    </div>
  );
  const sel = (k: keyof typeof cfg, label: string, opts: [string, string][]) => (
    <div className="field">
      <label htmlFor={`b-${k}`}>{label}</label>
      <select id={`b-${k}`} className="input" value={cfg[k]} disabled={running} onChange={(e) => setCfg({ ...cfg, [k]: e.target.value })}>
        {opts.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>
    </div>
  );
  const xmin = pts.length ? Math.min(...pts.map((p) => p.hz)) : C.bode.start_hz;
  const xmax = pts.length ? Math.max(pts[pts.length - 1].hz, xmin * 10) : C.bode.stop_hz;
  const log = (st?.config?.spacing ?? cfg.spacing) !== "lin";
  const gmin = Math.min(-40, ...pts.map((p) => p.gainDb)) - 3;
  const gmax = Math.max(6, ...pts.map((p) => p.gainDb)) + 3;
  const pmin = Math.min(-180, ...ph) - 10;
  const pmax = Math.max(20, ...ph) + 10;
  const corner = st?.corner;
  const hover = (x: number) => {
    if (!pts.length) return null;
    let best = 0;
    for (let i = 1; i < pts.length; i++) if (Math.abs(Math.log(pts[i].hz / x)) < Math.abs(Math.log(pts[best].hz / x))) best = i;
    const p = pts[best];
    return `${fmt(p.hz, "Hz", 4)}  ${p.gainDb.toFixed(2)} dB  ${ph[best].toFixed(1)}°`;
  };
  return (
    <>
      <div className="toolbar">
        <h1>Bode sweep</h1>
        <span className="hint">GEN OUT {cfg.awg} → circuit → CH{cfg.outCh}, with a tee to CH{cfg.inCh}</span>
        <span className="grow" />
        {running ? (
          <button className="btn danger" onClick={() => void attempt(() => post("bode/stop"))}>Stop sweep</button>
        ) : (
          <button className="btn primary" data-test="bode-start" disabled={!hasAfg} onClick={start}>Run sweep</button>
        )}
        <a className={`btn${pts.length ? "" : " disabled"}`} href="./api/bode/export.csv" aria-disabled={!pts.length} onClick={(e) => !pts.length && e.preventDefault()}>Export CSV</a>
      </div>
      <div className="pane">
        <div className="view-grid" style={{ gridTemplateColumns: "minmax(0,1fr) 300px", gridTemplateRows: "minmax(0,1fr)" }}>
          <div style={{ display: "grid", gridTemplateRows: "minmax(0,1.2fr) minmax(0,1fr)", gap: 10, minHeight: 0 }}>
            <div className="plot-card" data-test="bode-gain">
              {pts.length ? (
                <Plot
                  title="Gain (out / in)"
                  x={{ min: xmin, max: xmax, log, unit: "Hz" }}
                  y={{ min: gmin, max: gmax, unit: "dB" }}
                  series={[{ x: pts.map((p) => p.hz), y: pts.map((p) => p.gainDb), color: token("ch2"), dots: pts.length < 60 }]}
                  markers={corner ? [{ x: corner.hz, color: token("gold"), label: `−3 dB ${fmt(corner.hz, "Hz", 4)}` }] : []}
                  hoverText={hover}
                />
              ) : (
                <div className="empty">
                  <h3>No sweep yet</h3>
                  <p>Connect GEN OUT {cfg.awg} to your circuit's input and to CH{cfg.inCh} with a tee; its output to CH{cfg.outCh}. Each point sets the generator, fits both channels to the screen, and takes gain and phase from the two waveforms.</p>
                </div>
              )}
            </div>
            <div className="plot-card" data-test="bode-phase">
              {pts.length > 0 && (
                <Plot
                  title="Phase (out − in)"
                  x={{ min: xmin, max: xmax, log, unit: "Hz" }}
                  y={{ min: pmin, max: pmax, unit: "°" }}
                  series={[{ x: pts.map((p) => p.hz), y: ph, color: token("ch1"), dots: pts.length < 60 }]}
                  markers={corner ? [{ x: corner.hz, color: token("gold"), label: `${corner.phaseDeg.toFixed(1)}°` }] : []}
                  hoverText={hover}
                />
              )}
            </div>
          </div>
          <div style={{ display: "grid", gap: 10, alignContent: "start", overflowY: "auto", minHeight: 0 }}>
            <div className="card">
              <div className="card-head">Sweep</div>
              <div className="card-body" style={{ display: "grid", gap: 9 }}>
                {!hasAfg && <p className="body-text" style={{ color: "var(--gold)", margin: 0 }}>Needs the AFG50 or AFG100 option; this instrument reports neither.</p>}
                <div className="form-grid" style={{ gridTemplateColumns: "1fr 1fr" }}>
                  {f("startHz", "Start", "Hz")}
                  {f("stopHz", "Stop", "Hz")}
                  {f("points", "Points")}
                  {sel("spacing", "Spacing", [["log", "Logarithmic"], ["lin", "Linear"]])}
                  {f("amplitudeVpp", "Amplitude", "Vpp")}
                  {sel("awg", "Generator", [["1", "GEN 1"], ["2", "GEN 2"]])}
                  {sel("inCh", "Input on", [["1", "CH1"], ["2", "CH2"], ["3", "CH3"], ["4", "CH4"]])}
                  {sel("outCh", "Output on", [["1", "CH1"], ["2", "CH2"], ["3", "CH3"], ["4", "CH4"]])}
                  {f("settleMs", "Settle", "ms")}
                </div>
                {st && (st.running || st.points.length > 0) && (
                  <>
                    <div className="progress"><div style={{ width: `${st.total ? (100 * st.step) / st.total : 0}%` }} /></div>
                    <span className="muted" style={{ fontSize: 10 }}>{st.step} / {st.total} points{st.running ? " — the scope's settings are restored when it ends" : ""}</span>
                  </>
                )}
                {st?.error && <p className="body-text" style={{ color: "var(--coral)", margin: 0 }}>{st.error}</p>}
              </div>
            </div>
            <div className="card">
              <div className="card-head">Result</div>
              <div className="card-body">
                <div className="hero" data-test="bode-corner">{corner ? fmt(corner.hz, "Hz", 4).split(" ")[0] : "—"}<small>{corner ? `${fmt(corner.hz, "Hz", 4).split(" ")[1]} at −3 dB` : "−3 dB point"}</small></div>
                <div className="metric-row"><span>Phase at −3 dB</span><strong>{corner ? `${corner.phaseDeg.toFixed(1)}°` : "—"}</strong></div>
                <div className="metric-row"><span>Gain at first point</span><strong>{pts[0] ? `${pts[0].gainDb.toFixed(2)} dB` : "—"}</strong></div>
                <div className="metric-row"><span>Gain at last point</span><strong>{pts.length ? `${pts[pts.length - 1].gainDb.toFixed(2)} dB` : "—"}</strong></div>
                {st?.notes.map((n) => <p key={n} className="body-text" style={{ color: "var(--gold)" }}>{n}</p>)}
                <p className="body-text">
                  Gain = 20·log₁₀(|out|/|in|), phase = arg(out) − arg(in), from a Hann-windowed single-frequency DFT of each {C.instrument.normal_points}-point screen record ({C.bode.periods_on_screen}+ periods). The −3 dB point is relative to the first point (a low-pass reading). The instrument's own Bode option cannot return its curve over SCPI, so this sweep is the app's.
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
