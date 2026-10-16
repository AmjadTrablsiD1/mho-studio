// Spectrum computed here, with a stated window and scaling: RMS volts per
// bin (a 1 V-peak sine reads −3.01 dBV), peak list with interpolated
// frequency, and harmonic distortion. From the live screen record, or from a
// full-rate capture (deep memory) for more bandwidth and finer resolution.
//
// Bandwidth: a spectrum reaches half the sample rate of the record it is made
// from. The live screen record has ~1000 points over the screen, so its
// bandwidth follows the timebase (it can be raised here, by setting a faster
// timebase); a full-rate capture has every sample, so it reaches half the
// scope's own sample rate. The span shown (start / stop, or drag on the plot)
// is a window on that; for a capture the server sends the span at the record's
// full resolution.

import { useEffect, useMemo, useRef, useState } from "react";
import { C } from "../../../core/src/constants.ts";
import { fmt } from "../../../core/src/format.ts";
import { dbv, harmonics, peaks, spectrum, type Harmonics, type Peak } from "../../../core/src/dsp/spectrum.ts";
import { WINDOW_LABELS, type WindowName } from "../../../core/src/dsp/window.ts";
import { attempt, get, onFrame, post, useLive } from "../api.ts";
import { parseSI } from "../../../core/src/format.ts";
import { snap125, step125 } from "../../../core/src/wave/steps.ts";
import { Plot } from "../charts/Plot.tsx";
import { sourceColor, sourceLabel, token } from "../theme.ts";
import { useReg } from "../registry.ts";

/** f0: frequency of the first value; nyquist: the most this record can show (half its sample rate). */
type Result = { f0: number; df: number; db: number[]; peaks: Peak[]; harm: Harmonics | null; points: number; rbw: number; from: "screen" | "deep" | "scope"; unit?: string; nyquist: number; sampleRate: number };
type DeepSpectrum = { f0: number; df: number; binDf: number; nyquistHz: number; sampleRate: number; bins: number[]; peaks: Peak[]; harmonics: Harmonics | null; points: number; rbwHz: number };
/** Lengths a full-rate capture can have: longer is finer resolution (sample rate / points) and a longer read. */
const CAPTURE_POINTS = [65_536, 262_144, 1_048_576, 4_194_304];
/** Live bandwidths offered: the timebase is set so that the screen record reaches them. */
const LIVE_BW = [1e4, 1e5, 1e6, 1e7, 1e8, 5e8];
type ScopeFft = { df: number; bins: number[]; peaks: Peak[]; harmonics: Harmonics | null; points: number; rbwHz: number; unit: string };

export function SpectrumView() {
  const { screenPoints, family, features, divisionsX } = useReg();
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
  /** The span shown, Hz; null: everything the record has. */
  const [span, setSpan] = useState<[number, number] | null>(null);
  const [capPoints, setCapPoints] = useState(CAPTURE_POINTS[1]);
  const [capturing, setCapturing] = useState(false);
  const busy = useLive((s) => s.busy);
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
      setRes({ f0: 0, df: s.df, db: Array.from(averaged.vrms, dbv), peaks: peaks(averaged, C.spectrum.peaks), harm: harmonics(averaged, C.spectrum.harmonics), points: tr.volts.length, rbw: s.enbwHz, from: "screen", nyquist: s.df * (s.vrms.length - 1), sampleRate: 1 / tr.xinc });
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
      if (r) setRes({ f0: 0, df: r.df, db: r.bins.map(dbv), peaks: r.peaks, harm: r.harmonics, points: r.points, rbw: r.rbwHz, from: "scope", unit: r.unit, nyquist: r.df * (r.bins.length - 1), sampleRate: 2 * r.df * (r.bins.length - 1) });
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

  /** Analyse the capture over the span shown (the server sends that span at full resolution). */
  const runDeep = async (sp: [number, number] | null = span) => {
    const q = sp ? `&fmin=${sp[0]}&fmax=${sp[1]}` : "";
    const r = await attempt(() => get<DeepSpectrum>(`deep/spectrum?src=${src}&window=${win}${q}`));
    if (r) setRes({ f0: r.f0, df: r.df, db: r.bins.map(dbv), peaks: r.peaks, harm: r.harmonics, points: r.points, rbw: r.rbwHz, from: "deep", nyquist: r.nyquistHz, sampleRate: r.sampleRate });
  };
  /** Full rate: read this channel's record from deep memory (the scope runs on afterwards), then analyse it. */
  const capture = async () => {
    setCapturing(true);
    const ok = await attempt(() => post("deep/capture", { channels: [src], maxPoints: capPoints, resume: true }));
    setCapturing(false);
    if (ok) await runDeep();
  };
  const deepHasSrc = !!deep?.channels.some((c) => c.src === src);
  // A new span on a capture: ask for it at full resolution (after typing or dragging settles).
  useEffect(() => {
    if (mode !== "deep" || !deepHasSrc) return;
    const t = setTimeout(() => void runDeep(span), 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [span, mode, src, win, deepHasSrc]);
  useEffect(() => setSpan(null), [mode, src]);

  const xs = res ? res.db.map((_, i) => res.f0 + i * res.df) : [];
  const fend = res ? res.f0 + res.df * (res.db.length - 1) : 1;
  const view: [number, number] = span ?? [res?.f0 ?? 0, fend];

  // Live bandwidth: the screen record's points over the screen; a faster timebase raises it.
  const tdiv = values["timebase.scale"];
  const srate = values["acquire.srate"];
  const setLiveBw = (hz: number) => {
    let t = snap125(screenPoints / (2 * divisionsX * hz));
    if (t > screenPoints / (2 * divisionsX * hz) * 1.0001) t = step125(t, -1);
    void attempt(() => post("control", { key: "timebase.scale", value: t }), `Time/div ${fmt(t, "s", 3)}: the screen spectrum now reaches ${fmt(screenPoints / (2 * divisionsX * t), "Hz", 3)}`);
    setSpan(null);
  };
  const col = sourceColor(src);
  return (
    <>
      <div className="toolbar">
        <h1>Spectrum</h1>
        <select className="input" style={{ width: 90, flexShrink: 0 }} aria-label="Source" value={src} onChange={(e) => setSrc(e.target.value)}>
          {(sources.length ? sources : ["CHANnel1"]).map((s) => <option key={s} value={s}>{sourceLabel(s)}</option>)}
        </select>
        <select className="input" style={{ width: 140, flexShrink: 0 }} aria-label="Window" value={win} onChange={(e) => setWin(e.target.value as WindowName)}>
          {C.spectrum.windows.map((w) => <option key={w} value={w}>{WINDOW_LABELS[w as WindowName]}</option>)}
        </select>
        <div className="segmented" role="radiogroup" aria-label="Data">
          <button className={mode === "screen" ? "active" : ""} onClick={() => setMode("screen")} data-test="spectrum-live">Live screen</button>
          <button className={mode === "deep" ? "active" : ""} onClick={() => setMode("deep")} data-test="spectrum-full" title="Read a stretch of the scope's memory at its full sample rate: bandwidth up to half the sample rate, resolution sample rate / points">Full rate</button>
          {features.scopeFft && <button className={mode === "scope" ? "active" : ""} onClick={() => setMode("scope")} data-test="spectrum-scope" title="The instrument computes the FFT of the whole record (math trace F8); only the spectrum is transferred">Scope FFT</button>}
        </div>
        {mode === "screen" ? (
          <div className="segmented" role="radiogroup" aria-label="Averaging">
            {[1, 4, 16, 64].map((n) => <button key={n} className={avg === n ? "active" : ""} onClick={() => setAvg(n)}>{n === 1 ? "No avg" : `${n}×`}</button>)}
          </div>
        ) : mode === "deep" ? (
          <>
            <select className="input" style={{ width: 110, flexShrink: 0 }} aria-label="Points to capture" value={capPoints} onChange={(e) => setCapPoints(Number(e.target.value))} data-test="spectrum-points">
              {CAPTURE_POINTS.map((n) => <option key={n} value={n}>{fmt(n, "pts", 3)}</option>)}
            </select>
            <button className="btn small primary" disabled={capturing || busy !== null} onClick={() => void capture()} data-test="spectrum-capture">{capturing ? "Capturing…" : "Capture at full rate"}</button>
          </>
        ) : null}
        <div className="segmented" role="radiogroup" aria-label="Frequency axis">
          <button className={!logx ? "active" : ""} onClick={() => setLogx(false)}>Lin</button>
          <button className={logx ? "active" : ""} onClick={() => setLogx(true)}>Log</button>
        </div>
        <SpanFields view={view} onSet={setSpan} reset={() => setSpan(null)} zoomed={span !== null} />
        <span className="grow" />
      </div>
      <div className="pane">
        <div className="view-grid" style={{ gridTemplateColumns: "minmax(0,1fr) 300px" }}>
          <div className="plot-card" data-test="spectrum-plot">
            {res ? (
              <Plot
                title={`${sourceLabel(src)} · ${WINDOW_LABELS[win]} · ${res.from === "deep" ? "deep capture" : res.from === "scope" ? "computed by the scope (F8)" : `${avg}× power average`}`}
                x={{ min: logx ? Math.max(view[0], res.df, view[1] / 1e4) : view[0], max: view[1], log: logx, unit: "Hz" }}
                onSelect={(a, b) => setSpan([Math.max(0, Math.min(a, b)), Math.max(a, b)])}
                y={{ min: range[0], max: range[1], unit: "dBV" }}
                series={[{ x: xs.slice(logx && res.f0 === 0 ? 1 : 0), y: res.db.slice(logx && res.f0 === 0 ? 1 : 0), color: col, width: 1.2 }]}
                markers={res.peaks.slice(0, 3).map((p, i) => ({ x: p.hz, color: i ? token("muted") : col, label: i ? "" : `${fmt(p.hz, "Hz", 4)} ${p.dbv.toFixed(1)} dBV` }))}
                hoverText={(x) => {
                  const i = Math.round((x - res.f0) / res.df);
                  return i >= 0 && i < res.db.length ? `${fmt(res.f0 + i * res.df, "Hz", 4)}  ${res.db[i].toFixed(1)} dBV` : null;
                }}
              />
            ) : (
              <div className="empty"><p>{mode === "deep" ? <>Choose the number of points and <b>Capture at full rate</b>: the scope's memory is read at its full sample rate ({fmt(srate as number, "Sa/s", 3)}), so the spectrum reaches {fmt(typeof srate === "number" ? srate / 2 : null, "Hz", 3)}.</> : <>Waiting for {sourceLabel(src)}… switch the channel on if it is off.</>}</p></div>
            )}
          </div>
          <div style={{ display: "grid", gap: 10, alignContent: "start", gridAutoRows: "max-content", overflowY: "auto", minHeight: 0 }} tabIndex={0} role="region" aria-label="Spectrum details">
            <div className="card" data-test="spectrum-bandwidth">
              <div className="card-head">Bandwidth</div>
              <div className="card-body" style={{ display: "grid", gap: 4 }}>
                <div className="metric-row"><span>Shown</span><strong data-test="spectrum-shown">{fmt(view[0], "Hz", 4)} … {fmt(view[1], "Hz", 4)}</strong></div>
                <div className="metric-row"><span>This record reaches</span><strong data-test="spectrum-nyquist">{fmt(res?.nyquist ?? null, "Hz", 4)}</strong></div>
                <div className="metric-row"><span>Its sample rate</span><strong>{fmt(res?.sampleRate ?? null, "Sa/s", 3)}</strong></div>
                <div className="metric-row"><span>Resolution (RBW)</span><strong>{fmt(res?.rbw ?? null, "Hz", 3)}</strong></div>
                <div className="metric-row"><span>Signal time analysed</span><strong data-test="spectrum-covers">{fmt(res && res.sampleRate ? res.points / res.sampleRate : null, "s", 3)}</strong></div>
                {res && res.sampleRate > 0 && (
                  <p className="body-text" style={{ margin: 0, fontSize: 10.5 }} data-test="spectrum-lowest">
                    Frequencies below about {fmt((4 * res.sampleRate) / res.points, "Hz", 2)} (a few cycles in {fmt(res.points / res.sampleRate, "s", 2)}) are not resolved{res.from === "deep" ? ": for lower ones capture more points, or use a slower time/div so the same points cover more time" : ""}.
                  </p>
                )}
                <div className="metric-row"><span>The scope samples at</span><strong>{fmt(typeof srate === "number" ? srate : null, "Sa/s", 3)} → up to {fmt(typeof srate === "number" ? srate / 2 : null, "Hz", 3)}</strong></div>
                {family === "rigol" && <RateLimit srate={typeof srate === "number" ? srate : null} on={sources.length} />}
                {mode === "screen" && (
                  <div className="field" style={{ marginTop: 4 }}>
                    <label htmlFor="sp-livebw">Live bandwidth up to</label>
                    <select id="sp-livebw" className="input" value="" onChange={(e) => e.target.value && setLiveBw(Number(e.target.value))} data-test="spectrum-livebw">
                      <option value="">{typeof tdiv === "number" ? `now ${fmt(screenPoints / (2 * divisionsX * tdiv), "Hz", 3)} (${fmt(tdiv, "s", 3)}/div)` : "choose…"}</option>
                      {LIVE_BW.map((f) => <option key={f} value={f} disabled={typeof srate === "number" && f > srate / 2}>{fmt(f, "Hz", 3)}</option>)}
                    </select>
                    <span className="muted" style={{ fontSize: 10.5 }}>Sets a faster time/div on the scope, so its {screenPoints}-point screen record spans less time and reaches higher. For more, and finer resolution, use <b>Full rate</b>.</span>
                  </div>
                )}
                <div className="field" style={{ marginTop: 4 }}>
                  <span className="muted" style={{ fontSize: 10.5 }}>Level range</span>
                  <div className="segmented" role="radiogroup" aria-label="Level range">
                    {[[-120, 20], [-80, 20], [-60, 0]].map(([lo, hi]) => (
                      <button key={lo} role="radio" aria-checked={range[0] === lo} className={range[0] === lo ? "active" : ""} onClick={() => setRange([lo, hi])}>{lo}…{hi} dBV</button>
                    ))}
                  </div>
                </div>
                <span className="muted" style={{ fontSize: 10.5 }}>Drag across the plot to zoom into a span; Start / Stop in the toolbar set it exactly{mode === "deep" ? "; a capture's span is computed at the record's full resolution" : ""}.</span>
              </div>
            </div>
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
                <p className="body-text">Zero-padded to a power of two. Levels are RMS per bin, corrected for the window's coherent gain; THD sums the power in each harmonic's main lobe up to H{C.spectrum.harmonics}. {res?.from === "scope" ? "Scope FFT: the instrument transforms its whole record at the full sample rate (math trace F8, the window chosen here); the app finds peaks and THD in the result. Levels are the instrument's magnitude scaling, which the manual does not state as peak or RMS — compare with a known sine before trusting absolute dBV. " : ""}A screen record has only {screenPoints} points — capture deep memory for resolution below {res ? fmt(res.df, "Hz", 2) : "a bin"}.{family !== "rigol" ? ` On a ${family === "lecroy" ? "LeCroy" : "T3DSO"} the screen record is every Nth point of the acquisition, without a filter: anything above half that reduced rate folds back (aliases) into this screen spectrum. Deep memory has every point.` : ""}</p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

/** Start / stop of the span shown, typed with units ("10k", "2.5 MHz"); "Full" shows everything. */
function SpanFields({ view, onSet, reset, zoomed }: { view: [number, number]; onSet: (s: [number, number]) => void; reset: () => void; zoomed: boolean }) {
  const [a, setA] = useState("");
  const [b, setB] = useState("");
  const form = useRef<HTMLFormElement>(null);
  // Follow the span shown (zoom by dragging, Full) — but never rewrite a field while it is being typed in.
  useEffect(() => {
    if (form.current?.contains(document.activeElement)) return;
    setA(fmt(view[0], "Hz", 4));
    setB(fmt(view[1], "Hz", 4));
  }, [view[0], view[1]]);
  const apply = () => {
    const lo = parseSI(a);
    const hi = parseSI(b);
    if (lo !== null && hi !== null && hi > lo) onSet([Math.max(0, lo), hi]);
  };
  return (
    <>
    <form
      ref={form}
      className="row"
      style={{ gap: 4 }}
      aria-label="Span"
      onSubmit={(e) => (e.preventDefault(), apply())}
      // Applied when focus leaves both fields (or on Enter), not between typing the start and the stop.
      onBlur={(e) => {
        if (!form.current?.contains(e.relatedTarget as Node | null)) apply();
      }}
    >
      <input className="input mono" style={{ width: 92 }} aria-label="Start frequency" value={a} onChange={(e) => setA(e.target.value)} data-test="span-start" />
      <span className="muted">…</span>
      <input className="input mono" style={{ width: 92 }} aria-label="Stop frequency" value={b} onChange={(e) => setB(e.target.value)} data-test="span-stop" />
      <button type="submit" hidden aria-hidden="true" tabIndex={-1} />
    </form>
    {/* Outside the form: clicking it must not count as leaving the fields with their old values. */}
    <button type="button" className="btn small" disabled={!zoomed} onClick={reset} data-test="span-full">Full</button>
    </>
  );
}

/**
 * Why the MHO984 samples slower than its 4 GSa/s: the channels share the converters (4 / 2 / 1 / 1 GSa/s
 * with 1 / 2 / 3 / 4 on, C.instrument.max_sample_rate), and the memory must hold the whole screen
 * (rate = memory ÷ (10 × time/div)), so slow timebases sample slower.
 */
function RateLimit({ srate, on }: { srate: number | null; on: number }) {
  if (srate === null || on < 1) return null;
  const rates = C.instrument.max_sample_rate as number[];
  const max = rates[Math.min(rates.length, on) - 1];
  const top = rates[0];
  const byChannels = on > 1;
  const byMemory = srate < max * 0.99;
  if (!byChannels && !byMemory) return <p className="body-text" style={{ margin: 0, fontSize: 10.5 }} data-test="rate-limit">At the scope's full {fmt(top, "Sa/s", 3)}: one channel on.</p>;
  return (
    <p className="body-text" style={{ margin: 0, fontSize: 10.5, color: "var(--gold)" }} data-test="rate-limit">
      {byChannels && <>{on} channels on: the scope shares its converters, at most {fmt(max, "Sa/s", 3)} each. Switch the others off for {fmt(top, "Sa/s", 3)} ({fmt(top / 2, "Hz", 3)} of bandwidth). </>}
      {byMemory && <>Below {fmt(max, "Sa/s", 3)} because the memory must hold the whole screen at this time/div: a larger Memory depth (or AUTO), or a faster time/div, raises it.</>}
    </p>
  );
}
