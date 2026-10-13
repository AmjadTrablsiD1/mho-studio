// Edge capture: wait for ONE event (an SPI transfer, a reset, any burst that
// does not repeat), record a window after it, and measure every edge in that
// one record — rise and fall times, when each edge happened, the spacing
// between them, pulse widths, glitches and runts, and the setup and hold of
// data lines against a clock. On a LeCroy, several triggers can be recorded
// in one go, each in its own memory segment with its time (server/burst.ts).

import { useMemo, useState } from "react";
import { C } from "../../../core/src/constants.ts";
import { fmt, parseSI } from "../../../core/src/format.ts";
import { attempt, post, useLive, type Anomaly, type BurstResult, type Edge, type Histogram, type Summary, type TimingResult } from "../api.ts";
import { Plot } from "../charts/Plot.tsx";
import { useReg } from "../registry.ts";
import { setUi, useUi } from "../uistate.ts";
import { sourceLabel, sourceColor, token } from "../theme.ts";

const WINDOWS = [10e-6, 100e-6, 1e-3, 10e-3, 100e-3, 1, 2];
/** Rows a table shows; the plots show more, the CSV files everything. */
const TABLE_ROWS = 500;

export function EdgesView() {
  const values = useLive((s) => s.values);
  const st = useLive((s) => s.burst);
  const connected = useLive((s) => s.link?.state === "connected");
  const reg = useReg();
  const uiCh = useUi((u) => u.channel);
  const [trigger, setTrigger] = useState(uiCh);
  const [slope, setSlope] = useState<"rise" | "fall">("rise");
  const lv = values["trigger.edge.level"];
  const [level, setLevel] = useState(typeof lv === "number" ? fmt(lv, "V", 4) : "");
  const [waitS, setWaitS] = useState(String(C.burst.default_wait_s));
  const [windowS, setWindowS] = useState(C.burst.default_window_s);
  const [channels, setChannels] = useState<number[]>([uiCh]);
  const [manual, setManual] = useState(false);
  const [base, setBase] = useState("0 V");
  const [top, setTop] = useState("3.3 V");
  const [segments, setSegments] = useState("1");
  const [glitch, setGlitch] = useState("");
  const [timingOn, setTimingOn] = useState(false);
  const [clock, setClock] = useState(uiCh);
  const [clockEdge, setClockEdge] = useState<"rise" | "fall">("rise");
  const [setupMin, setSetupMin] = useState("");
  const [holdMin, setHoldMin] = useState("");
  const [show, setShow] = useState<string | null>(null);
  const running = st?.running === true;
  const canSegment = reg.features.segments;

  const start = () => {
    void attempt(async () => {
      const volts = (text: string, what: string) => {
        const v = parseSI(text);
        if (v === null) throw new Error(`${what}: "${text}" is not a voltage (e.g. 1.65 or 800 mV)`);
        return v;
      };
      const time = (text: string, what: string) => {
        if (!text.trim()) return null;
        const v = parseSI(text);
        if (v === null || !(v > 0)) throw new Error(`${what}: "${text}" is not a time (e.g. 20 ns or 1.5 us)`);
        return v;
      };
      const n = Number(segments);
      if (!Number.isInteger(n) || n < 1) throw new Error(`Segments: "${segments}" is not a whole number of 1 or more`);
      return post("burst/start", {
        trigger,
        slope,
        level: level.trim() ? volts(level, "Trigger level") : null,
        waitS: Number(waitS),
        windowS,
        channels: channels.length ? channels : [trigger],
        ...(manual ? { base: volts(base, "Low level"), top: volts(top, "High level") } : {}),
        segments: canSegment ? n : 1,
        glitchS: time(glitch, "Glitch width"),
        timing: timingOn ? { clock, edge: clockEdge, setupMin: time(setupMin, "Required setup"), holdMin: time(holdMin, "Required hold") } : null,
      });
    });
  };

  const results = st?.results ?? [];
  const timing = st?.timing ?? [];
  const tabs = [...results.map((r) => ({ id: `ch${r.ch}`, label: name(r.ch) })), ...(timing.length ? [{ id: "timing", label: "Setup & hold" }] : [])];
  const tab = tabs.find((t) => t.id === show)?.id ?? tabs[0]?.id ?? null;
  const sel = results.find((r) => `ch${r.ch}` === tab) ?? null;

  return (
    <>
      <div className="toolbar">
        <h1>Edge capture</h1>
        <span className="hint">one trigger · one record · every edge measured</span>
        <span className="grow" />
        {st?.phase === "done" && (
          <>
            <a className="btn small" href="./api/burst/edges.csv" data-test="edges-csv">Edges (CSV)</a>
            {results.some((r) => r.counts.glitch + r.counts.runt > 0) && <a className="btn small" href="./api/burst/anomalies.csv" data-test="anomalies-csv">Glitches and runts (CSV)</a>}
            {timing.length > 0 && <a className="btn small" href="./api/burst/timing.csv" data-test="timing-csv">Setup and hold (CSV)</a>}
            <button className="btn small" onClick={() => setUi({ view: "deep" })}>Open the record in Deep memory</button>
          </>
        )}
      </div>
      <div className="pane">
        <div className="view-grid" style={{ gridTemplateColumns: "320px minmax(0,1fr)" }}>
          <div style={{ display: "grid", gap: 10, alignContent: "start", gridAutoRows: "max-content", overflowY: "auto", minHeight: 0 }}>
            <div className="card">
              <div className="card-head">Trigger once</div>
              <div className="card-body" style={{ display: "grid", gap: 8 }}>
                <div className="field">
                  <label htmlFor="b-trig">Trigger on</label>
                  <select id="b-trig" className="input" value={trigger} onChange={(e) => setTrigger(Number(e.target.value))} disabled={running} data-test="burst-trigger">
                    {[1, 2, 3, 4].map((n) => <option key={n} value={n}>{name(n)}</option>)}
                  </select>
                </div>
                <div className="segmented" role="radiogroup" aria-label="Edge">
                  <button role="radio" aria-checked={slope === "rise"} className={slope === "rise" ? "active" : ""} onClick={() => setSlope("rise")} disabled={running}>Rising edge</button>
                  <button role="radio" aria-checked={slope === "fall"} className={slope === "fall" ? "active" : ""} onClick={() => setSlope("fall")} disabled={running}>Falling edge</button>
                </div>
                <div className="field">
                  <label htmlFor="b-level">Trigger level</label>
                  <input id="b-level" className="input" value={level} placeholder="keep the scope's" onChange={(e) => setLevel(e.target.value)} disabled={running} data-test="burst-level" />
                </div>
                <div className="field">
                  <label htmlFor="b-wait">Wait for the event up to (s)</label>
                  <input id="b-wait" className="input" value={waitS} onChange={(e) => setWaitS(e.target.value)} disabled={running} data-test="burst-wait" />
                </div>
                <div className="field">
                  <label htmlFor="b-win">Record after the trigger</label>
                  <select id="b-win" className="input" value={windowS} onChange={(e) => setWindowS(Number(e.target.value))} disabled={running} data-test="burst-window">
                    {WINDOWS.map((w) => <option key={w} value={w}>{fmt(w, "s", 3)}</option>)}
                  </select>
                </div>
                <div className="field">
                  <label htmlFor="b-seg">Triggers to record (segments)</label>
                  <input id="b-seg" className="input" value={canSegment ? segments : "1"} onChange={(e) => setSegments(e.target.value)} disabled={running || !canSegment} data-test="burst-segments" inputMode="numeric" />
                  <span className="muted" style={{ fontSize: 10.5 }}>
                    {canSegment
                      ? "More than 1: the scope's sequence mode records each trigger in its own segment, with its time. One capture, every repeat of the event."
                      : "Segmented capture needs a LeCroy (sequence mode)."}
                  </span>
                </div>
                <div className="field">
                  <span className="muted" style={{ fontSize: 10.5 }}>Measure on</span>
                  <div className="row wrap" style={{ gap: 10 }}>
                    {[1, 2, 3, 4].map((n) => (
                      <label key={n} className="row" style={{ gap: 4, fontSize: 11.5 }}>
                        <input type="checkbox" checked={channels.includes(n)} disabled={running} onChange={(e) => setChannels((c) => (e.target.checked ? [...c, n] : c.filter((x) => x !== n)))} data-test={`burst-ch-${n}`} />
                        <span style={{ color: `var(--ch${n})` }}>{name(n)}</span>
                      </label>
                    ))}
                  </div>
                </div>
                <label className="row" style={{ gap: 6, fontSize: 11.5 }}>
                  <input type="checkbox" checked={manual} onChange={(e) => setManual(e.target.checked)} disabled={running} />
                  Set the 0 % / 100 % levels myself (else found from each record)
                </label>
                {manual && (
                  <div className="row" style={{ gap: 6 }}>
                    <div className="field grow"><label htmlFor="b-base">Low (0 %)</label><input id="b-base" className="input" value={base} onChange={(e) => setBase(e.target.value)} /></div>
                    <div className="field grow"><label htmlFor="b-top">High (100 %)</label><input id="b-top" className="input" value={top} onChange={(e) => setTop(e.target.value)} /></div>
                  </div>
                )}
                <div className="row" style={{ gap: 6, marginTop: 4 }}>
                  {!running ? (
                    <button className="btn primary grow" disabled={!connected} onClick={start} data-test="burst-start">Arm and capture</button>
                  ) : (
                    <button className="btn danger grow" onClick={() => void attempt(() => post("burst/stop"))} data-test="burst-stop">Stop</button>
                  )}
                </div>
                <p className="body-text" style={{ margin: 0 }}>
                  The scope is set to an edge trigger in Single, waits for the event, and stops on it. The trigger sits {C.burst.pre_trigger_div} division from the left; the record covers the window after it with as much memory as allowed, so the sample rate is as high as the window permits. The scope is left stopped on the event.
                </p>
              </div>
            </div>
            <div className="card">
              <div className="card-head">Look for</div>
              <div className="card-body" style={{ display: "grid", gap: 8 }}>
                <div className="field">
                  <label htmlFor="b-glitch">Glitches: pulses narrower than</label>
                  <input id="b-glitch" className="input" value={glitch} placeholder="off (e.g. 20 ns)" onChange={(e) => setGlitch(e.target.value)} disabled={running} data-test="burst-glitch" />
                  <span className="muted" style={{ fontSize: 10.5 }}>Runts — swings past 50 % that turn back before 90 % — are always listed.</span>
                </div>
                <label className="row" style={{ gap: 6, fontSize: 11.5 }}>
                  <input type="checkbox" checked={timingOn} onChange={(e) => setTimingOn(e.target.checked)} disabled={running} data-test="burst-timing" />
                  Setup and hold of the other measured lines against a clock
                </label>
                {timingOn && (
                  <>
                    <div className="row" style={{ gap: 6 }}>
                      <div className="field grow">
                        <label htmlFor="b-clock">Clock</label>
                        <select id="b-clock" className="input" value={clock} onChange={(e) => setClock(Number(e.target.value))} disabled={running} data-test="burst-clock">
                          {[1, 2, 3, 4].map((n) => <option key={n} value={n}>{name(n)}</option>)}
                        </select>
                      </div>
                      <div className="field grow">
                        <label htmlFor="b-cedge">Data sampled on</label>
                        <select id="b-cedge" className="input" value={clockEdge} onChange={(e) => setClockEdge(e.target.value === "fall" ? "fall" : "rise")} disabled={running} data-test="burst-clock-edge">
                          <option value="rise">rising edges</option>
                          <option value="fall">falling edges</option>
                        </select>
                      </div>
                    </div>
                    <div className="row" style={{ gap: 6 }}>
                      <div className="field grow"><label htmlFor="b-su">Required setup</label><input id="b-su" className="input" value={setupMin} placeholder="optional, e.g. 5 ns" onChange={(e) => setSetupMin(e.target.value)} disabled={running} data-test="burst-setup-min" /></div>
                      <div className="field grow"><label htmlFor="b-ho">Required hold</label><input id="b-ho" className="input" value={holdMin} placeholder="optional" onChange={(e) => setHoldMin(e.target.value)} disabled={running} data-test="burst-hold-min" /></div>
                    </div>
                    <span className="muted" style={{ fontSize: 10.5 }}>
                      At every {clockEdge === "rise" ? "rising" : "falling"} clock edge: setup is the time since the data line last changed, hold the time until it next changes (50 % to 50 %). The clock is measured too; tick the data lines under Measure on.
                    </span>
                  </>
                )}
              </div>
            </div>
            {st && st.phase !== "idle" && <StatusCard />}
          </div>
          <div style={{ display: "grid", gap: 10, alignContent: "start", gridAutoRows: "max-content", overflowY: "auto", minHeight: 0 }}>
            {!results.length && (
              <div className="card"><div className="card-body"><p className="body-text" style={{ margin: 0 }}>
                For an event that happens once — an SPI transfer, a reset, a start-up sequence — choose the line that starts it, the window that holds it and the lines to measure, then <b>Arm and capture</b>. Every rising and falling edge in that one record is listed with its 10–90 % time and when it happened, with the pulse widths, any glitches and runts, and — if asked — the setup and hold of the data lines.
              </p></div></div>
            )}
            {st?.segments && <SegmentsCard s={st.segments} />}
            {tabs.length > 1 && (
              <div className="segmented" role="tablist" aria-label="Result" style={{ justifySelf: "start" }}>
                {tabs.map((t) => <button key={t.id} role="tab" aria-selected={tab === t.id} className={tab === t.id ? "active" : ""} onClick={() => setShow(t.id)} data-test={`burst-tab-${t.id}`}>{t.label}</button>)}
              </div>
            )}
            {sel && <ChannelResult r={sel} segmented={!!st?.segments} />}
            {tab === "timing" && timing.map((t) => <TimingCard key={t.data} t={t} segmented={!!st?.segments} />)}
          </div>
        </div>
      </div>
    </>
  );
}

const name = (n: number) => sourceLabel(`CHANnel${n}`);

function StatusCard() {
  const st = useLive((s) => s.burst)!;
  const p = st.progress;
  const color = st.phase === "error" ? "var(--coral)" : st.phase === "done" ? "var(--ok, var(--text))" : "var(--gold)";
  const several = (st.setup?.segments ?? 1) > 1;
  return (
    <div className="card" data-test="burst-status">
      <div className="card-head">Capture</div>
      <div className="card-body" style={{ display: "grid", gap: 4 }}>
        <div className="metric-row"><span>State</span><strong style={{ color }}>{st.phase}</strong></div>
        {st.setup && (
          <>
            <div className="metric-row"><span>Timebase</span><strong>{fmt(st.setup.timeDiv, "s", 3)}/div · {fmt(st.setup.windowS, "s", 3)} after the trigger</strong></div>
            <div className="metric-row"><span>Sample rate</span><strong>{fmt(st.setup.sampleRate, "Sa/s", 3)} · every {fmt(st.setup.dt, "s", 3)}</strong></div>
            {several && <div className="metric-row"><span>Segments</span><strong>{st.setup.segments}</strong></div>}
          </>
        )}
        {st.triggeredAfterS !== null && <div className="metric-row"><span>{several ? "Last segment after" : "Triggered after"}</span><strong>{fmt(st.triggeredAfterS, "s", 3)}</strong></div>}
        {p && st.phase === "reading" && <div className="metric-row"><span>Reading CH{p.src.slice(-1)}</span><strong>{Math.round((p.done / p.total) * 100)} %</strong></div>}
        {st.error && <p className="body-text" style={{ color: "var(--coral)", margin: 0 }} role="alert">{st.error}</p>}
        {st.notes.map((n) => <p key={n} className="body-text" style={{ margin: 0 }}>{n}</p>)}
      </div>
    </div>
  );
}

function stats(label: string, s: Summary, unit: string, test?: string) {
  return (
    <tr data-test={test}>
      <td>{label}</td>
      <td className="n">{s.n}</td>
      <td className="n">{fmt(s.min, unit, 4)}</td>
      <td className="n"><strong>{fmt(s.mean, unit, 4)}</strong></td>
      <td className="n">{fmt(s.max, unit, 4)}</td>
      <td className="n">{fmt(s.std, unit, 3)}</td>
    </tr>
  );
}

const statsHead = <thead><tr><th /><th className="n">Count</th><th className="n">Min</th><th className="n">Mean</th><th className="n">Max</th><th className="n">σ</th></tr></thead>;

/** "#3 · " in front of a time when the capture has segments. */
const segOf = (segmented: boolean, seg: number) => (segmented ? `#${seg + 1} · ` : "");

function SegmentsCard({ s }: { s: { count: number; recorded: number; times: number[] | null } }) {
  const gaps = s.times && s.times.length > 1 ? s.times.slice(1).map((t, i) => t - s.times![i]) : [];
  return (
    <div className="card" data-test="burst-segments-card">
      <div className="card-head">{s.recorded} triggers recorded{s.count < s.recorded ? ` · first ${s.count} analysed` : ""}</div>
      <div className="card-body" style={{ display: "grid", gap: 4 }}>
        {s.times ? (
          <>
            <div className="metric-row"><span>From the first trigger to the last</span><strong>{fmt(s.times[s.times.length - 1], "s", 6)}</strong></div>
            {gaps.length > 0 && <div className="metric-row"><span>Between triggers</span><strong>{fmt(Math.min(...gaps), "s", 4)} … {fmt(Math.max(...gaps), "s", 4)}</strong></div>}
          </>
        ) : (
          <p className="body-text" style={{ margin: 0 }}>The instrument did not send the segments' trigger times.</p>
        )}
        <p className="body-text" style={{ margin: 0 }}>Edge times are from each segment's own trigger. Per segment: the table under each channel.</p>
      </div>
    </div>
  );
}

/** A histogram as a stepped outline. */
function steps(h: Histogram): { x: number[]; y: number[] } {
  const n = h.counts.length;
  if (!n) return { x: [], y: [] };
  const w = n > 1 ? (h.hi - h.lo) / n : Math.max(Math.abs(h.lo) * 0.01, 1e-15);
  const lo = n > 1 ? h.lo : h.lo - w / 2;
  const x: number[] = [lo];
  const y: number[] = [0];
  for (let i = 0; i < n; i++) {
    x.push(lo + i * w, lo + (i + 1) * w);
    y.push(h.counts[i], h.counts[i]);
  }
  x.push(lo + n * w);
  y.push(0);
  return { x, y };
}

function ChannelResult({ r, segmented }: { r: BurstResult; segmented: boolean }) {
  const col = sourceColor(r.src);
  const rises = useMemo(() => r.edges.filter((e) => e.kind === "rise"), [r]);
  const falls = useMemo(() => r.edges.filter((e) => e.kind === "fall"), [r]);
  const span = useMemo(() => {
    let tMin = Infinity;
    let tMax = -Infinity;
    let dMax = 0;
    for (const e of r.edges) {
      tMin = Math.min(tMin, e.t);
      tMax = Math.max(tMax, e.t);
      dMax = Math.max(dMax, e.dur);
    }
    return r.edges.length ? { tMin, tMax, dMax } : { tMin: 0, tMax: 1, dMax: 1 };
  }, [r]);
  const { tMin, tMax, dMax } = span;
  return (
    <>
      <div className="card" data-test={`burst-result-${r.ch}`}>
        <div className="card-head" style={{ color: col }}>
          {sourceLabel(r.src)} · {r.counts.rise} rising, {r.counts.fall} falling edges
          {r.counts.glitch > 0 && <span className="badge alarm" style={{ marginLeft: 8 }} data-test="burst-glitches">{r.counts.glitch} glitch{r.counts.glitch > 1 ? "es" : ""}</span>}
          {r.counts.runt > 0 && <span className="badge alarm" style={{ marginLeft: 8 }} data-test="burst-runts">{r.counts.runt} runt{r.counts.runt > 1 ? "s" : ""}</span>}
        </div>
        <div className="card-body">
          {r.flat && <p className="body-text" style={{ color: "var(--gold)" }}>This record does not swing between two levels: no edges to measure.</p>}
          {r.offScreen && (
            <p className="body-text" style={{ color: "var(--coral)" }} role="alert" data-test={`burst-offscreen-${r.ch}`}>
              {sourceLabel(r.src)} goes off the screen, where the instrument clips it: these edge times are too short. Set its V/div and offset so the whole signal fits (Scope view), then capture again.
            </p>
          )}
          <table className="table">
            {statsHead}
            <tbody>
              {stats("Rise time 10–90 %", r.rises, "s", "burst-rise")}
              {stats("Fall time 90–10 %", r.falls, "s", "burst-fall")}
              {stats("Rising edge to rising edge", r.periods, "s")}
              {stats("High pulse width (50 %)", r.pulses.high, "s", "burst-high")}
              {stats("Low pulse width (50 %)", r.pulses.low, "s", "burst-low")}
            </tbody>
          </table>
          <div className="row wrap" style={{ gap: 16, marginTop: 8, fontSize: 11 }}>
            <span className="muted">Levels: low {fmt(r.levels.base, "V", 3)}, high {fmt(r.levels.top, "V", 3)} → 10 % {fmt(r.levels.lo, "V", 3)}, 90 % {fmt(r.levels.hi, "V", 3)}</span>
            <span className="muted">Sampled every {fmt(r.dt, "s", 3)}</span>
            {r.counts.under > 0 && <span style={{ color: "var(--gold)" }}>{r.counts.under} edge(s) under-sampled (faster than ~{C.burst.min_samples_per_edge} samples): their times are mostly the sample spacing</span>}
          </div>
        </div>
      </div>
      {r.edges.length > 0 && (
        <div className="plot-card" style={{ height: 260 }} data-test="burst-plot">
          <Plot
            title={`Each edge: its 10–90 % time against when it happened (time from ${segmented ? "its segment's" : "the"} trigger)`}
            x={{ min: tMin - (tMax - tMin) * 0.02 - 1e-12, max: tMax + (tMax - tMin) * 0.02 + 1e-12, unit: "s" }}
            y={{ min: 0, max: dMax * 1.15, unit: "s" }}
            series={[
              { x: rises.map((e) => e.t), y: rises.map((e) => e.dur), color: col, width: 0, dots: true, name: "rise" },
              { x: falls.map((e) => e.t), y: falls.map((e) => e.dur), color: token("muted"), width: 0, dots: true, name: "fall" },
            ]}
          />
        </div>
      )}
      {r.counts.rise + r.counts.fall > 0 && <Spread r={r} segmented={segmented} />}
      {r.anomalies.length > 0 && <Anomalies r={r} segmented={segmented} />}
      {r.perSegment.length > 0 && <PerSegment r={r} />}
      {r.edges.length > 0 && (
        <div className="card">
          <div className="card-head">Edges{r.shown < r.counts.rise + r.counts.fall ? ` — first ${r.shown.toLocaleString()} of ${(r.counts.rise + r.counts.fall).toLocaleString()} (all in the CSV)` : ""}</div>
          <div className="table-scroll" style={{ maxHeight: 320 }} tabIndex={0} role="region" aria-label="Edge list">
            <table className="table" data-test="burst-edges">
              <thead><tr><th className="n">#</th>{segmented && <th className="n">Segment</th>}<th>Edge</th><th className="n">Time from trigger</th><th className="n">10–90 % / 90–10 %</th><th /></tr></thead>
              <tbody>
                {r.edges.slice(0, TABLE_ROWS).map((e, i) => (
                  <tr key={i}>
                    <td className="n">{i + 1}</td>
                    {segmented && <td className="n">{e.seg + 1}</td>}
                    <td>{e.kind === "rise" ? "↑ rising" : "↓ falling"}</td>
                    <td className="n">{fmt(e.t, "s", 6)}</td>
                    <td className="n">{fmt(e.dur, "s", 4)}</td>
                    <td>{e.under && <span className="badge warn" title="Fewer samples across this edge than needed for a trustworthy time">under-sampled</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {r.edges.length > TABLE_ROWS && <p className="body-text" style={{ margin: 8 }}>The table shows the first {TABLE_ROWS}; the plot {r.edges.length.toLocaleString()}; the CSV every edge.</p>}
        </div>
      )}
    </>
  );
}

/** How spread out the edge times are: histograms of every rise and fall time, and the slowest edges with how far each is above the mean. */
function Spread({ r, segmented }: { r: BurstResult; segmented: boolean }) {
  const col = sourceColor(r.src);
  const hr = steps(r.hist.rise);
  const hf = steps(r.hist.fall);
  const xs = [...hr.x, ...hf.x];
  const lo = xs.length ? Math.min(...xs) : 0;
  const hi = xs.length ? Math.max(...xs) : 1;
  const yMax = Math.max(1, ...hr.y, ...hf.y);
  const slow: { e: Edge; s: Summary }[] = [...r.slowest.rise.map((e) => ({ e, s: r.rises })), ...r.slowest.fall.map((e) => ({ e, s: r.falls }))];
  const sigmas = (e: Edge, s: Summary) => (s.std && s.std > 0 && s.mean !== null ? (e.dur - s.mean) / s.std : null);
  return (
    <div className="card" data-test="burst-spread">
      <div className="card-head">Spread of the edge times</div>
      <div className="card-body" style={{ display: "grid", gap: 8 }}>
        <div className="plot-card" style={{ height: 220 }} data-test="burst-hist">
          <Plot
            title="How many edges took how long: rising in colour, falling in grey"
            x={{ min: lo - (hi - lo) * 0.03 - 1e-15, max: hi + (hi - lo) * 0.03 + 1e-15, unit: "s" }}
            y={{ min: 0, max: yMax * 1.1, unit: "" }}
            series={[
              { x: hr.x, y: hr.y, color: col, width: 1.6, name: "rise" },
              { x: hf.x, y: hf.y, color: token("muted"), width: 1.6, name: "fall" },
            ]}
            markers={r.slowest.rise.slice(0, 1).map((e) => ({ x: e.dur, color: token("coral"), label: `slowest rise ${fmt(e.dur, "s", 3)}` }))}
          />
        </div>
        <table className="table" data-test="burst-slowest">
          <thead><tr><th>Slowest</th>{segmented && <th className="n">Segment</th>}<th className="n">At</th><th className="n">Took</th><th className="n">Above the mean</th></tr></thead>
          <tbody>
            {slow.map(({ e, s }, i) => {
              const z = sigmas(e, s);
              return (
                <tr key={i}>
                  <td>{e.kind === "rise" ? "↑ rising" : "↓ falling"}</td>
                  {segmented && <td className="n">{e.seg + 1}</td>}
                  <td className="n">{fmt(e.t, "s", 6)}</td>
                  <td className="n"><strong>{fmt(e.dur, "s", 4)}</strong></td>
                  <td className="n">{z === null ? "—" : <span style={{ color: z >= 4 ? "var(--coral)" : undefined }}>{z.toFixed(1)} σ</span>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <p className="body-text" style={{ margin: 0 }}>An edge 4 σ or more above the mean (in red) stands out from the rest: look at it in Deep memory at the time shown.</p>
      </div>
    </div>
  );
}

function Anomalies({ r, segmented }: { r: BurstResult; segmented: boolean }) {
  const total = r.counts.glitch + r.counts.runt;
  const label = (a: Anomaly) => (a.kind === "glitch" ? `${a.polarity} glitch` : a.polarity === "high" ? "runt (rose, fell back)" : "runt (fell, rose back)");
  return (
    <div className="card">
      <div className="card-head">Glitches and runts{r.anomalies.length < total ? ` — first ${r.anomalies.length.toLocaleString()} of ${total.toLocaleString()} (all in the CSV)` : ""}</div>
      <div className="table-scroll" style={{ maxHeight: 260 }} tabIndex={0} role="region" aria-label="Glitches and runts">
        <table className="table" data-test="burst-anomalies">
          <thead><tr><th className="n">#</th>{segmented && <th className="n">Segment</th>}<th>What</th><th className="n">Time from trigger</th><th className="n">Width (50 %)</th><th className="n">Reached</th></tr></thead>
          <tbody>
            {r.anomalies.slice(0, TABLE_ROWS).map((a, i) => (
              <tr key={i}>
                <td className="n">{i + 1}</td>
                {segmented && <td className="n">{a.seg + 1}</td>}
                <td><span className="badge alarm">{label(a)}</span></td>
                <td className="n">{fmt(a.t, "s", 6)}</td>
                <td className="n">{fmt(a.width, "s", 4)}</td>
                <td className="n">{a.peak === null ? "—" : fmt(a.peak, "V", 3)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function PerSegment({ r }: { r: BurstResult }) {
  const times = useLive((s) => s.burst?.segments?.times ?? null);
  return (
    <div className="card">
      <div className="card-head">Per segment</div>
      <div className="table-scroll" style={{ maxHeight: 280 }} tabIndex={0} role="region" aria-label="Per segment">
        <table className="table" data-test="burst-segtable">
          <thead><tr><th className="n">Segment</th><th className="n">Trigger at</th><th className="n">Rising</th><th className="n">Falling</th><th className="n">Rise mean</th><th className="n">Rise max</th><th className="n">Fall mean</th><th className="n">Fall max</th><th className="n">Glitches / runts</th></tr></thead>
          <tbody>
            {r.perSegment.map((g) => (
              <tr key={g.seg}>
                <td className="n">{g.seg + 1}</td>
                <td className="n">{times ? fmt(times[g.seg], "s", 6) : "—"}</td>
                <td className="n">{g.rise}</td>
                <td className="n">{g.fall}</td>
                <td className="n">{fmt(g.riseMean, "s", 4)}</td>
                <td className="n">{fmt(g.riseMax, "s", 4)}</td>
                <td className="n">{fmt(g.fallMean, "s", 4)}</td>
                <td className="n">{fmt(g.fallMax, "s", 4)}</td>
                <td className="n">{g.anomalies ? <span className="badge alarm">{g.anomalies}</span> : 0}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function TimingCard({ t, segmented }: { t: TimingResult; segmented: boolean }) {
  const col = sourceColor(`CHANnel${t.data}`);
  const su = t.rows.filter((x) => x.setup !== null);
  const ho = t.rows.filter((x) => x.hold !== null);
  let tMin = Infinity;
  let tMax = -Infinity;
  let yMax = 1e-12;
  for (const x of t.rows) {
    tMin = Math.min(tMin, x.t);
    tMax = Math.max(tMax, x.t);
    yMax = Math.max(yMax, x.setup ?? 0, x.hold ?? 0);
  }
  if (!t.rows.length) [tMin, tMax] = [0, 1];
  const bad = (v: number | null, limit: number | null) => limit !== null && v !== null && v < limit;
  const worst = (label: string, w: TimingResult["worstSetup"], v: number | null, limit: number | null, test: string) => (
    <div className="metric-row" data-test={test}>
      <span>Smallest {label}</span>
      <strong style={{ color: bad(v, limit) ? "var(--coral)" : undefined }}>
        {fmt(v, "s", 4)}{w ? ` at ${segOf(segmented, w.seg)}${fmt(w.t, "s", 6)}` : ""}
      </strong>
    </div>
  );
  const nViol = t.violations.setup + t.violations.hold;
  return (
    <>
      <div className="card" data-test={`burst-timing-result-${t.data}`}>
        <div className="card-head" style={{ color: col }}>
          {name(t.data)} against the {name(t.clock)} clock · {t.total} {t.edge === "rise" ? "rising" : "falling"} clock edges
          {nViol > 0 && <span className="badge alarm" style={{ marginLeft: 8 }}>{nViol} violation{nViol > 1 ? "s" : ""}</span>}
        </div>
        <div className="card-body" style={{ display: "grid", gap: 6 }}>
          {worst("setup", t.worstSetup, t.worstSetup?.setup ?? null, t.limits.setup, "burst-worst-setup")}
          {worst("hold", t.worstHold, t.worstHold?.hold ?? null, t.limits.hold, "burst-worst-hold")}
          {(t.limits.setup !== null || t.limits.hold !== null) && (
            <div className="metric-row" data-test="burst-violations">
              <span>Below the requirement</span>
              <strong style={{ color: nViol ? "var(--coral)" : undefined }}>
                {[
                  t.limits.setup !== null ? `setup < ${fmt(t.limits.setup, "s", 3)}: ${t.violations.setup}` : null,
                  t.limits.hold !== null ? `hold < ${fmt(t.limits.hold, "s", 3)}: ${t.violations.hold}` : null,
                ].filter(Boolean).join(" · ")}
              </strong>
            </div>
          )}
          <table className="table">
            {statsHead}
            <tbody>
              {stats("Setup", t.setup, "s", "burst-setup")}
              {stats("Hold", t.hold, "s", "burst-hold")}
            </tbody>
          </table>
        </div>
      </div>
      {t.rows.length > 0 && (
        <div className="plot-card" style={{ height: 240 }} data-test="burst-timing-plot">
          <Plot
            title={`Setup (colour) and hold (grey) at each clock edge${segmented ? " (time from its segment's trigger)" : ""}`}
            x={{ min: tMin - (tMax - tMin) * 0.02 - 1e-12, max: tMax + (tMax - tMin) * 0.02 + 1e-12, unit: "s" }}
            y={{ min: 0, max: yMax * 1.15, unit: "s" }}
            series={[
              { x: su.map((x) => x.t), y: su.map((x) => x.setup!), color: col, width: 0, dots: true, name: "setup" },
              { x: ho.map((x) => x.t), y: ho.map((x) => x.hold!), color: token("muted"), width: 0, dots: true, name: "hold" },
            ]}
          />
        </div>
      )}
      {t.rows.length > 0 && (
        <div className="card">
          <div className="card-head">Every clock edge{t.rows.length < t.total ? ` — first ${t.rows.length.toLocaleString()} of ${t.total.toLocaleString()} (all in the CSV)` : ""}</div>
          <div className="table-scroll" style={{ maxHeight: 280 }} tabIndex={0} role="region" aria-label="Setup and hold per clock edge">
            <table className="table" data-test="burst-timing-rows">
              <thead><tr><th className="n">#</th>{segmented && <th className="n">Segment</th>}<th className="n">Clock edge at</th><th className="n">Setup</th><th className="n">Hold</th></tr></thead>
              <tbody>
                {t.rows.slice(0, TABLE_ROWS).map((x, i) => (
                  <tr key={i}>
                    <td className="n">{i + 1}</td>
                    {segmented && <td className="n">{x.seg + 1}</td>}
                    <td className="n">{fmt(x.t, "s", 6)}</td>
                    <td className="n" style={{ color: bad(x.setup, t.limits.setup) ? "var(--coral)" : undefined }}>{x.setup === null ? "—" : fmt(x.setup, "s", 4)}</td>
                    <td className="n" style={{ color: bad(x.hold, t.limits.hold) ? "var(--coral)" : undefined }}>{x.hold === null ? "—" : fmt(x.hold, "s", 4)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </>
  );
}
