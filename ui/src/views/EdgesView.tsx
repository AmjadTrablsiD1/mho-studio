// Edge capture: wait for ONE event (an SPI transfer, a reset, any burst that
// does not repeat), record a window after it, and measure every edge in that
// one record — rise and fall times, when each edge happened, the spacing
// between them. Same on a RIGOL and on a LeCroy (server/burst.ts).

import { useMemo, useState } from "react";
import { C } from "../../../core/src/constants.ts";
import { fmt, parseSI } from "../../../core/src/format.ts";
import { attempt, post, useLive, type BurstResult, type Summary } from "../api.ts";
import { Plot } from "../charts/Plot.tsx";
import { setUi, useUi } from "../uistate.ts";
import { sourceLabel, sourceColor, token } from "../theme.ts";

const WINDOWS = [10e-6, 100e-6, 1e-3, 10e-3, 100e-3, 1, 2];

export function EdgesView() {
  const values = useLive((s) => s.values);
  const st = useLive((s) => s.burst);
  const connected = useLive((s) => s.link?.state === "connected");
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
  const [show, setShow] = useState<number | null>(null);
  const running = st?.running === true;

  const start = () => {
    void attempt(async () => {
      const volts = (text: string, what: string) => {
        const v = parseSI(text);
        if (v === null) throw new Error(`${what}: "${text}" is not a voltage (e.g. 1.65 or 800 mV)`);
        return v;
      };
      return post("burst/start", {
        trigger,
        slope,
        level: level.trim() ? volts(level, "Trigger level") : null,
        waitS: Number(waitS),
        windowS,
        channels: channels.length ? channels : [trigger],
        ...(manual ? { base: volts(base, "Low level"), top: volts(top, "High level") } : {}),
      });
    });
  };

  const results = st?.results ?? [];
  const sel = results.find((r) => r.ch === show) ?? results[0] ?? null;
  const name = (n: number) => sourceLabel(`CHANnel${n}`);

  return (
    <>
      <div className="toolbar">
        <h1>Edge capture</h1>
        <span className="hint">one trigger · one record · every edge measured</span>
        <span className="grow" />
        {st?.phase === "done" && (
          <>
            <a className="btn small" href="./api/burst/edges.csv" data-test="edges-csv">Download all edges (CSV)</a>
            <button className="btn small" onClick={() => setUi({ view: "deep" })}>Open the record in Deep memory</button>
          </>
        )}
      </div>
      <div className="pane">
        <div className="view-grid" style={{ gridTemplateColumns: "320px minmax(0,1fr)" }}>
          <div style={{ display: "grid", gap: 10, alignContent: "start", overflowY: "auto", minHeight: 0 }}>
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
            {st && st.phase !== "idle" && <StatusCard />}
          </div>
          <div style={{ display: "grid", gap: 10, alignContent: "start", overflowY: "auto", minHeight: 0 }}>
            {!results.length && (
              <div className="card"><div className="card-body"><p className="body-text" style={{ margin: 0 }}>
                For an event that happens once — an SPI transfer, a reset, a start-up sequence — choose the line that starts it, the window that holds it and the lines to measure, then <b>Arm and capture</b>. Every rising and falling edge in that one record is listed with its 10–90 % time and when it happened.
              </p></div></div>
            )}
            {results.length > 1 && (
              <div className="segmented" role="tablist" aria-label="Channel" style={{ justifySelf: "start" }}>
                {results.map((r) => <button key={r.ch} role="tab" aria-selected={sel?.ch === r.ch} className={sel?.ch === r.ch ? "active" : ""} onClick={() => setShow(r.ch)}>{name(r.ch)}</button>)}
              </div>
            )}
            {sel && <ChannelResult r={sel} />}
          </div>
        </div>
      </div>
    </>
  );
}

function StatusCard() {
  const st = useLive((s) => s.burst)!;
  const p = st.progress;
  const color = st.phase === "error" ? "var(--coral)" : st.phase === "done" ? "var(--ok, var(--text))" : "var(--gold)";
  return (
    <div className="card" data-test="burst-status">
      <div className="card-head">Capture</div>
      <div className="card-body" style={{ display: "grid", gap: 4 }}>
        <div className="metric-row"><span>State</span><strong style={{ color }}>{st.phase}</strong></div>
        {st.setup && (
          <>
            <div className="metric-row"><span>Timebase</span><strong>{fmt(st.setup.timeDiv, "s", 3)}/div · {fmt(st.setup.windowS, "s", 3)} after the trigger</strong></div>
            <div className="metric-row"><span>Sample rate</span><strong>{fmt(st.setup.sampleRate, "Sa/s", 3)} · every {fmt(st.setup.dt, "s", 3)}</strong></div>
          </>
        )}
        {st.triggeredAfterS !== null && <div className="metric-row"><span>Triggered after</span><strong>{fmt(st.triggeredAfterS, "s", 3)}</strong></div>}
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

function ChannelResult({ r }: { r: BurstResult }) {
  const col = sourceColor(r.src);
  const rises = useMemo(() => r.edges.filter((e) => e.kind === "rise"), [r]);
  const falls = useMemo(() => r.edges.filter((e) => e.kind === "fall"), [r]);
  const all = [...rises, ...falls].map((e) => e.dur);
  const tMin = r.edges.length ? r.edges[0].t : 0;
  const tMax = r.edges.length ? r.edges[r.edges.length - 1].t : 1;
  const dMax = all.length ? Math.max(...all) : 1;
  return (
    <>
      <div className="card" data-test={`burst-result-${r.ch}`}>
        <div className="card-head" style={{ color: col }}>{sourceLabel(r.src)} · {r.counts.rise} rising, {r.counts.fall} falling edges</div>
        <div className="card-body">
          {r.flat && <p className="body-text" style={{ color: "var(--gold)" }}>This record does not swing between two levels: no edges to measure.</p>}
          {r.offScreen && (
            <p className="body-text" style={{ color: "var(--coral)" }} role="alert" data-test={`burst-offscreen-${r.ch}`}>
              {sourceLabel(r.src)} goes off the screen, where the instrument clips it: these edge times are too short. Set its V/div and offset so the whole signal fits (Scope view), then capture again.
            </p>
          )}
          <table className="table">
            <thead><tr><th /><th className="n">Count</th><th className="n">Min</th><th className="n">Mean</th><th className="n">Max</th><th className="n">σ</th></tr></thead>
            <tbody>
              {stats("Rise time 10–90 %", r.rises, "s", "burst-rise")}
              {stats("Fall time 90–10 %", r.falls, "s", "burst-fall")}
              {stats("Rising edge to rising edge", r.periods, "s")}
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
            title="Each edge: its 10–90 % time against when it happened (time from the trigger)"
            x={{ min: tMin - (tMax - tMin) * 0.02 - 1e-12, max: tMax + (tMax - tMin) * 0.02 + 1e-12, unit: "s" }}
            y={{ min: 0, max: dMax * 1.15, unit: "s" }}
            series={[
              { x: rises.map((e) => e.t), y: rises.map((e) => e.dur), color: col, width: 0, dots: true, name: "rise" },
              { x: falls.map((e) => e.t), y: falls.map((e) => e.dur), color: token("muted"), width: 0, dots: true, name: "fall" },
            ]}
          />
        </div>
      )}
      {r.edges.length > 0 && (
        <div className="card">
          <div className="card-head">Edges{r.shown < r.counts.rise + r.counts.fall ? ` — first ${r.shown.toLocaleString()} of ${(r.counts.rise + r.counts.fall).toLocaleString()} (all in the CSV)` : ""}</div>
          <div className="table-scroll" style={{ maxHeight: 320 }} tabIndex={0} role="region" aria-label="Edge list">
            <table className="table" data-test="burst-edges">
              <thead><tr><th className="n">#</th><th>Edge</th><th className="n">Time from trigger</th><th className="n">10–90 % / 90–10 %</th><th /></tr></thead>
              <tbody>
                {r.edges.slice(0, 500).map((e, i) => (
                  <tr key={i}>
                    <td className="n">{i + 1}</td>
                    <td>{e.kind === "rise" ? "↑ rising" : "↓ falling"}</td>
                    <td className="n">{fmt(e.t, "s", 6)}</td>
                    <td className="n">{fmt(e.dur, "s", 4)}</td>
                    <td>{e.under && <span className="badge warn" title="Fewer samples across this edge than needed for a trustworthy time">under-sampled</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {r.edges.length > 500 && <p className="body-text" style={{ margin: 8 }}>The table shows the first 500; the plot {r.edges.length.toLocaleString()}; the CSV every edge.</p>}
        </div>
      )}
    </>
  );
}
