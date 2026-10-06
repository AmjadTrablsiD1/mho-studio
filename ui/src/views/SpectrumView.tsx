// Spectrum computed here, with a stated window and scaling: RMS volts per
// bin (a 1 V-peak sine reads −3.01 dBV), peak list with interpolated
// frequency, and harmonic distortion. From the live screen record, or from a
// deep-memory capture for fine resolution.

import { useEffect, useMemo, useRef, useState } from "react";
import { C } from "../../../core/src/constants.ts";
import { fmt } from "../../../core/src/format.ts";
import { dbv, harmonics, peaks, spectrum, type Harmonics, type Peak } from "../../../core/src/dsp/spectrum.ts";
import { WINDOW_LABELS, type WindowName } from "../../../core/src/dsp/window.ts";
import { attempt, get, onFrame, post, useLive } from "../api.ts";
import { Plot } from "../charts/Plot.tsx";
import { sourceColor, sourceLabel, token } from "../theme.ts";
import { useReg } from "../registry.ts";

type Result = { df: number; db: number[]; peaks: Peak[]; harm: Harmonics | null; points: number; rbw: number; from: "screen" | "deep" | "scope"; unit?: string };
type ScopeFft = { df: number; bins: number[]; peaks: Peak[]; harmonics: Harmonics | null; points: number; rbwHz: number; unit: string };

export function SpectrumView() {
  const { screenPoints, family, features } = useReg();
  const lecroy = family === "lecroy";
  const values = useLive((s) => s.values);
  const deep = useLive((s) => s.deep);
  const sources = useMemo(() => {
    const out: string[] = [];
    for (let n = 1; n <= 4; n++) if (values[`channel.display@${n}`] === true) out.push(`CHANnel${n}`);
    return out;
  }, [values]);
  const [src, setSrc] = useState("CHANnel1");
  const [win, setWin] = useState<WindowName>(C.spectrum.default_window as WindowName);
  const [avg, setAvg] = useState(4);
  const [logx, setLogx] = useState(false);
  const [range, setRange] = useState<[number, number]>([-120, 20]);
  const [mode, setMode] = useState<"screen" | "deep" | "scope">("screen");
  const [res, setRes] = useState<Result | null>(null);
  const acc = useRef<{ p: Float64Array; n: number; key: string } | null>(null);

  useEffect(() => {
    if (mode !== "screen") return;
    acc.current = null;
    let last = 0;
    return onFrame((f) => {
      if (Date.now() - last < 120) return;
      last = Date.now();
      const tr = f.traces.find((t) => t.src === src);
      if (!tr) return;
      const s = spectrum(tr.volts, tr.xinc, win, false);
      const k = `${src}|${win}|${tr.xinc}|${s.vrms.length}`;
      if (!acc.current || acc.current.key !== k) acc.current = { p: new Float64Array(s.vrms.length), n: 0, key: k };
      const a = acc.current;
      const w = 1 / Math.min(avg, a.n + 1);
      for (let i = 0; i < s.vrms.length; i++) a.p[i] = a.p[i] * (1 - w) + s.vrms[i] ** 2 * w;
      a.n++;
      const averaged = { ...s, vrms: Float64Array.from(a.p, Math.sqrt) };
      setRes({ df: s.df, db: Array.from(averaged.vrms, dbv), peaks: peaks(averaged, C.spectrum.peaks), harm: harmonics(averaged, C.spectrum.harmonics), points: tr.volts.length, rbw: s.enbwHz, from: "screen" });
    });
  }, [src, win, avg, mode]);

  // The instrument's own FFT (LeCroy F8): poll while chosen, switch it off when left.
  useEffect(() => {
    if (mode !== "scope") return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      const r = await attempt(() => get<ScopeFft>(`scope-fft?src=${src}&window=${win}`));
      if (!alive) return;
      if (r) setRes({ df: r.df, db: r.bins.map(dbv), peaks: r.peaks, harm: r.harmonics, points: r.points, rbw: r.rbwHz, from: "scope", unit: r.unit });
      timer = setTimeout(() => void tick(), C.lecroy.fft_poll_ms);
    };
    void tick();
    return () => {
      alive = false;
      clearTimeout(timer);
      void attempt(() => post("scope-fft/stop"));
    };
  }, [mode, src, win]);
  useEffect(() => {
    if (!features.scopeFft && mode === "scope") setMode("screen");
  }, [features.scopeFft, mode]);

  const runDeep = async () => {
    const r = await attempt(() => get<{ df: number; bins: number[]; peaks: Peak[]; harmonics: Harmonics | null; points: number; rbwHz: number }>(`deep/spectrum?src=${src}&window=${win}`));
    if (r) setRes({ df: r.df, db: r.bins.map(dbv), peaks: r.peaks, harm: r.harmonics, points: r.points, rbw: r.rbwHz, from: "deep" });
  };

  const xs = res ? res.db.map((_, i) => i * res.df) : [];
  const fmax = res ? res.df * (res.db.length - 1) : 1;
  const col = sourceColor(src);
  return (
    <>
      <div className="toolbar">
        <h1>Spectrum</h1>
        <select className="input" style={{ width: 90 }} aria-label="Source" value={src} onChange={(e) => setSrc(e.target.value)}>
          {(sources.length ? sources : ["CHANnel1"]).map((s) => <option key={s} value={s}>{sourceLabel(s)}</option>)}
        </select>
        <select className="input" style={{ width: 140 }} aria-label="Window" value={win} onChange={(e) => setWin(e.target.value as WindowName)}>
          {C.spectrum.windows.map((w) => <option key={w} value={w}>{WINDOW_LABELS[w as WindowName]}</option>)}
        </select>
        <div className="segmented" role="radiogroup" aria-label="Data">
          <button className={mode === "screen" ? "active" : ""} onClick={() => setMode("screen")}>Live screen</button>
          <button className={mode === "deep" ? "active" : ""} onClick={() => setMode("deep")} disabled={!deep}>Deep capture</button>
          {features.scopeFft && <button className={mode === "scope" ? "active" : ""} onClick={() => setMode("scope")} data-test="spectrum-scope" title="The instrument computes the FFT of the whole record (math trace F8); only the spectrum is transferred">Scope FFT</button>}
        </div>
        {mode === "screen" ? (
          <div className="segmented" role="radiogroup" aria-label="Averaging">
            {[1, 4, 16, 64].map((n) => <button key={n} className={avg === n ? "active" : ""} onClick={() => setAvg(n)}>{n === 1 ? "No avg" : `${n}×`}</button>)}
          </div>
        ) : mode === "deep" ? (
          <button className="btn small" onClick={() => void runDeep()}>Analyse capture</button>
        ) : null}
        <div className="segmented" role="radiogroup" aria-label="Frequency axis">
          <button className={!logx ? "active" : ""} onClick={() => setLogx(false)}>Lin</button>
          <button className={logx ? "active" : ""} onClick={() => setLogx(true)}>Log</button>
        </div>
        <span className="grow" />
        <div className="segmented" aria-label="Range">
          {[[-120, 20], [-80, 20], [-60, 0]].map(([a, b]) => (
            <button key={a} className={range[0] === a ? "active" : ""} onClick={() => setRange([a, b])}>{a}…{b} dBV</button>
          ))}
        </div>
      </div>
      <div className="pane">
        <div className="view-grid" style={{ gridTemplateColumns: "minmax(0,1fr) 300px" }}>
          <div className="plot-card" data-test="spectrum-plot">
            {res ? (
              <Plot
                title={`${sourceLabel(src)} · ${WINDOW_LABELS[win]} · ${res.from === "deep" ? "deep capture" : res.from === "scope" ? "computed by the scope (F8)" : `${avg}× power average`}`}
                x={{ min: logx ? Math.max(res.df, fmax / 1e4) : 0, max: fmax, log: logx, unit: "Hz" }}
                y={{ min: range[0], max: range[1], unit: "dBV" }}
                series={[{ x: xs.slice(logx ? 1 : 0), y: res.db.slice(logx ? 1 : 0), color: col, width: 1.2 }]}
                markers={res.peaks.slice(0, 3).map((p, i) => ({ x: p.hz, color: i ? token("muted") : col, label: i ? "" : `${fmt(p.hz, "Hz", 4)} ${p.dbv.toFixed(1)} dBV` }))}
                hoverText={(x) => {
                  const i = Math.round(x / res.df);
                  return i >= 0 && i < res.db.length ? `${fmt(i * res.df, "Hz", 4)}  ${res.db[i].toFixed(1)} dBV` : null;
                }}
              />
            ) : (
              <div className="empty"><p>Waiting for {sourceLabel(src)}… switch the channel on if it is off.</p></div>
            )}
          </div>
          <div style={{ display: "grid", gap: 10, alignContent: "start", overflowY: "auto", minHeight: 0 }}>
            <div className="card">
              <div className="card-head">Peaks</div>
              <table className="table">
                <thead><tr><th className="n">Frequency</th><th className="n">Level</th><th className="n">Vrms</th></tr></thead>
                <tbody>
                  {res?.peaks.map((p) => (
                    <tr key={p.bin}><td className="n">{fmt(p.hz, "Hz", 5)}</td><td className="n">{p.dbv.toFixed(1)}<small>dBV</small></td><td className="n">{fmt(p.vrms, "V", 3)}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="card">
              <div className="card-head">Distortion</div>
              <div className="card-body">
                <div className="hero" data-test="thd">{res?.harm?.thdPct === null || !res?.harm ? "—" : res.harm.thdPct < 0.01 ? res.harm.thdPct.toExponential(1) : res.harm.thdPct.toFixed(res.harm.thdPct < 1 ? 3 : 2)}<small>% THD</small></div>
                <div className="metric-row"><span>Fundamental</span><strong>{fmt(res?.harm?.fundamentalHz, "Hz", 5)}</strong></div>
                <div className="metric-row"><span>THD</span><strong>{res?.harm?.thdDb === null || !res?.harm ? "—" : `${res.harm.thdDb.toFixed(1)} dB`}</strong></div>
                {res?.harm?.note && <p className="body-text" style={{ color: "var(--gold)" }}>{res.harm.note}</p>}
                {res?.harm?.list.slice(0, 6).map((h) => (
                  <div key={h.order} className="metric-row"><span>H{h.order} · {fmt(h.hz, "Hz", 4)}</span><strong>{h.dbc.toFixed(1)}<small>dBc</small></strong></div>
                ))}
              </div>
            </div>
            <div className="card">
              <div className="card-head">Method</div>
              <div className="card-body">
                <div className="metric-row"><span>Points</span><strong>{res ? res.points.toLocaleString() : "—"}</strong></div>
                <div className="metric-row"><span>Bin spacing</span><strong>{fmt(res?.df, "Hz", 3)}</strong></div>
                <div className="metric-row"><span>RBW (window ENBW)</span><strong>{fmt(res?.rbw, "Hz", 3)}</strong></div>
                <p className="body-text">Zero-padded to a power of two. Levels are RMS per bin, corrected for the window's coherent gain; THD sums the power in each harmonic's main lobe up to H{C.spectrum.harmonics}. {res?.from === "scope" ? "Scope FFT: the instrument transforms its whole record at the full sample rate (math trace F8, the window chosen here); the app finds peaks and THD in the result. Levels are the instrument's magnitude scaling, which the manual does not state as peak or RMS — compare with a known sine before trusting absolute dBV. " : ""}A screen record has only {screenPoints} points — capture deep memory for resolution below {res ? fmt(res.df, "Hz", 2) : "a bin"}.{lecroy ? " On a LeCroy the screen record is every Nth point of the acquisition, without a filter: anything above half that reduced rate folds back (aliases) into this screen spectrum. Deep memory has every point." : ""}</p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
