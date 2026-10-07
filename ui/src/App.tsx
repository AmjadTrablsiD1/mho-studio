// The instrument shell: header with the run keys, the rail (views and
// channels), the workspace for the current view, the inspector, the status bar.

import { useEffect, useState } from "react";
import { C } from "../../core/src/constants.ts";
import { key } from "../../core/src/registry/controls.ts";
import { fmt } from "../../core/src/format.ts";
import { action, attempt, dismissToast, getLive, linkAddress, setConfirmer, useLive, useToasts, writeControl } from "./api.ts";
import { getUi, setUi, useUi, type View } from "./uistate.ts";
import { applyTheme, currentTheme } from "./theme.ts";
import { Icon } from "./components/Icons.tsx";
import { Inspector } from "./components/Inspector.tsx";
import { ConnectPanel, ConnectionModal } from "./components/Connect.tsx";
import { ScreenshotModal } from "./components/Screenshot.tsx";
import { ScopeView } from "./views/ScopeView.tsx";
import { SpectrumView } from "./views/SpectrumView.tsx";
import { BodeView } from "./views/BodeView.tsx";
import { DeepView } from "./views/DeepView.tsx";
import { DecodeView } from "./views/DecodeView.tsx";
import { ConsoleView } from "./views/ConsoleView.tsx";
import { InstrumentView } from "./views/InstrumentView.tsx";
import { SettingsView } from "./views/SettingsView.tsx";
import { EdgesView } from "./views/EdgesView.tsx";
import { useReg } from "./registry.ts";
import type { Features } from "../../core/src/registry/families.ts";

/** `needs`: shown only when the instrument on the line has that feature (no Bode sweep without a generator). */
const VIEWS: { id: View; label: string; icon: () => React.JSX.Element; needs?: keyof Features }[] = [
  { id: "scope", label: "Scope", icon: Icon.scope },
  { id: "spectrum", label: "Spectrum", icon: Icon.spectrum },
  { id: "bode", label: "Bode sweep", icon: Icon.bode, needs: "generator" },
  { id: "deep", label: "Deep memory", icon: Icon.deep },
  { id: "edges", label: "Edge capture", icon: Icon.edges },
  { id: "decode", label: "Decode & logic", icon: Icon.decode, needs: "decode" },
  { id: "console", label: "SCPI console", icon: Icon.console },
  { id: "instrument", label: "Instrument", icon: Icon.instrument },
  { id: "settings", label: "All settings", icon: Icon.settings },
];

export function App() {
  const view = useUi((u) => u.view);
  const inspector = useUi((u) => u.inspector);
  const connected = useLive((s) => s.link?.state === "connected");
  const loaded = useLive((s) => s.loaded);
  const [confirmMsg, setConfirmMsg] = useState<{ text: string; resolve: (ok: boolean) => void } | null>(null);
  const [showLink, setShowLink] = useState(false);
  const [shot, setShot] = useState(false);

  useEffect(() => {
    setConfirmer((text) => new Promise((resolve) => setConfirmMsg({ text, resolve })));
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest("input, textarea, select, [contenteditable]") || e.metaKey || e.ctrlKey) return;
      if (e.key === "Escape") {
        setShowLink(false);
        setShot(false);
        return;
      }
      if (!getLive().link || getLive().link!.state !== "connected") return;
      const k = e.key.toLowerCase();
      if (k === " ") {
        e.preventDefault();
        void attempt(() => action(getLive().status === "STOP" ? "root.run" : "root.stop"));
      } else if (k === "s") void attempt(() => action("root.single"));
      else if (k === "f") void attempt(() => action("root.tforce"));
      else if (k === "a") void attempt(() => action("root.autoset"));
      else if (k === "c") setUi((u) => ({ cursors: u.cursors === "off" ? "time" : u.cursors === "time" ? "volt" : u.cursors === "volt" ? "both" : "off" }));
      else if (k === "p") setUi((u) => ({ persistence: !u.persistence }));
      else if (/^[1-4]$/.test(k)) setUi({ channel: Number(k), section: "vertical" });
      else if (k === "t") setUi({ section: "trigger" });
      else if (k === "h") setUi({ section: "horizontal" });
      else if (k === "m") setUi({ section: "measure" });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const wantsInspector = inspector && connected && (view === "scope" || view === "spectrum");
  return (
    <div className={`app${wantsInspector ? "" : " no-inspector"}`}>
      <Header onLink={() => setShowLink(true)} onShot={() => setShot(true)} />
      <Rail />
      <main className="workspace single" style={{ gridColumn: wantsInspector ? undefined : "2 / span 2" }}>
        {!loaded ? (
          <div className="pane"><div className="empty"><p>Starting…</p></div></div>
        ) : !connected && view !== "console" ? (
          <ConnectPanel />
        ) : (
          <ViewHost view={view} />
        )}
      </main>
      {wantsInspector && <Inspector />}
      <StatusBar />
      <Toasts />
      {confirmMsg && (
        <div className="modal-back" role="dialog" aria-modal="true" aria-labelledby="confirm-title">
          <div className="modal">
            <h2 id="confirm-title">Confirm</h2>
            <p className="body-text" style={{ fontSize: 12 }}>{confirmMsg.text}</p>
            <div className="actions">
              <button className="btn" onClick={() => (confirmMsg.resolve(false), setConfirmMsg(null))} autoFocus>Cancel</button>
              <button className="btn primary" data-test="confirm-ok" onClick={() => (confirmMsg.resolve(true), setConfirmMsg(null))}>Continue</button>
            </div>
          </div>
        </div>
      )}
      {showLink && <ConnectionModal onClose={() => setShowLink(false)} />}
      {shot && <ScreenshotModal onClose={() => setShot(false)} />}
    </div>
  );
}

function ViewHost({ view }: { view: View }) {
  const r = useReg();
  const needs = VIEWS.find((v) => v.id === view)?.needs;
  if (needs && !r.features[needs]) return <ScopeView />;
  switch (view) {
    case "spectrum": return <SpectrumView />;
    case "bode": return <BodeView />;
    case "deep": return <DeepView />;
    case "edges": return <EdgesView />;
    case "decode": return <DecodeView />;
    case "console": return <ConsoleView />;
    case "instrument": return <InstrumentView />;
    case "settings": return <SettingsView />;
    default: return <ScopeView />;
  }
}

function Header({ onLink, onShot }: { onLink: () => void; onShot: () => void }) {
  const link = useLive((s) => s.link);
  const status = useLive((s) => s.status);
  const busy = useLive((s) => s.busy);
  const [theme, setTheme] = useState(currentTheme());
  const connected = link?.state === "connected";
  const stateClass = status === "TD" ? "td" : status === "WAIT" ? "wait" : status === "STOP" ? "stop" : "";
  const running = connected && status !== "STOP";
  return (
    <header className="app-header">
      <div className="brand">
        <img src="./favicon.svg" alt="" />
        <div>
          {C.app.name}
          <small>{C.app.tagline}</small>
        </div>
      </div>
      <div className="header-divider" />
      <button className="pill" onClick={onLink} data-test="link-pill" title="Connection">
        <span className={`dot ${connected ? "ok" : link?.state === "lost" ? "alarm" : link?.state === "connecting" ? "warn" : ""}`} />
        {connected ? (
          <>
            <strong>{link!.idn?.model ?? "?"}</strong>
            {!link!.sim && <span className="mono">{link!.kind === "usb" ? "USB" : link!.host}</span>}
          </>
        ) : link?.state === "lost" ? (
          <strong>Reconnecting…</strong>
        ) : link?.state === "connecting" ? (
          <strong>Connecting…</strong>
        ) : (
          <strong>Not connected</strong>
        )}
      </button>
      {link?.sim && connected && <span className="badge info" title="Every waveform comes from the built-in simulated bench, not from hardware">Simulated</span>}
      <div className="header-spacer" />
      {busy && <span className="badge warn">{busy}…</span>}
      <div className="runkeys" role="group" aria-label="Run control">
        <button className={`runkey ${running ? "run" : "stop"}`} disabled={!connected} data-test="runstop" onClick={() => void attempt(() => action(running ? "root.stop" : "root.run"))} title="Run / Stop (Space)">
          <span className="lamp" /> {running ? "RUN" : "STOP"}
        </button>
        <button className="runkey single" disabled={!connected} onClick={() => void attempt(() => action("root.single"))} title="Single (S)">
          <span className="lamp" /> SINGLE
        </button>
        <button className="runkey" disabled={!connected} onClick={() => void attempt(() => action("root.autoset"))} title="Autoset (A)">AUTO</button>
        <button className="runkey" disabled={!connected} onClick={() => void attempt(() => action("root.tforce"))} title="Force trigger (F)">FORCE</button>
      </div>
      <span className={`pill trig-state ${stateClass}`} data-test="trig-status" title={link?.family === "lecroy" ? "Trigger status (TRMD? and INR?)" : "Trigger status (:TRIGger:STATus?)"}>
        {connected ? (C.instrument.trigger_status as Record<string, string>)[status] ?? status : "—"}
      </span>
      <button className="icon-btn" aria-label="Screenshot of the instrument's display" title="Screenshot of the instrument's display" disabled={!connected} onClick={onShot}><Icon.camera /></button>
      <button
        className="icon-btn"
        aria-label="Switch theme"
        title="Switch theme"
        onClick={() => {
          const next = currentTheme() === "midnight" ? "daylight" : "midnight";
          applyTheme(next);
          setTheme(next);
        }}
      >
        {theme === "midnight" ? <Icon.sun /> : <Icon.moon />}
      </button>
      <button className={`icon-btn${getUi().inspector ? " on" : ""}`} aria-label="Show or hide the inspector" title="Inspector" onClick={() => setUi((u) => ({ inspector: !u.inspector }))}><Icon.panel /></button>
    </header>
  );
}

function Rail() {
  const view = useUi((u) => u.view);
  const selected = useUi((u) => u.channel);
  const values = useLive((s) => s.values);
  const connected = useLive((s) => s.link?.state === "connected");
  const measure = useLive((s) => s.measure.length);
  const readings = useLive((s) => s.readings);
  const bode = useLive((s) => s.bode);
  const r = useReg();
  return (
    <nav className="rail" aria-label="Views and channels">
      <div className="eyebrow">Views</div>
      {VIEWS.filter((v) => !v.needs || r.features[v.needs]).map((v) => (
        <button key={v.id} className={`nav-item${view === v.id ? " active" : ""}`} onClick={() => setUi({ view: v.id })} data-test={`nav-${v.id}`}>
          <v.icon />
          {v.label}
          {v.id === "scope" && measure > 0 && <span className="count">{measure}</span>}
          {v.id === "bode" && bode?.running && <span className="count">{bode.step}/{bode.total}</span>}
        </button>
      ))}
      {connected && (
        <>
          <div className="eyebrow">Channels</div>
          {[1, 2, 3, 4].map((n) => {
            const on = values[key("channel.display", n)] === true;
            const scale = values[key("channel.scale", n)];
            const coup = String(values[key("channel.coupling", n)] ?? "");
            const bw = String(values[key("channel.bwlimit", n)] ?? "OFF");
            const imp = String(values[key("channel.impedance", n)] ?? "");
            const probe = values[key("channel.probe", n)];
            const name = String(values[key("channel.label.content", n)] ?? "").trim();
            const s = typeof scale === "number" ? fmt(scale, "V", 3).split(" ") : ["—", ""];
            return (
              <div key={n} className={`chan-card${selected === n ? " selected" : ""}${on ? "" : " off"}`} data-test={`chan-${n}`}>
                <span className="bar" style={{ background: `var(--ch${n})` }} />
                <button style={{ textAlign: "left" }} onClick={() => setUi({ channel: n, section: "vertical", view: getUi().view === "scope" || getUi().view === "spectrum" ? getUi().view : "scope" })} aria-label={`Select channel ${n}`}>
                  <span className="c-name" style={{ color: `var(--ch${n})` }}>CH{n}</span>
                  {name && <span className="muted" title={name} style={{ fontSize: 10, marginLeft: 6, maxWidth: 70, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", display: "inline-block", verticalAlign: "bottom" }} data-test={`chan-name-${n}`}>{name}</span>}
                </button>
                <div className="row" style={{ gap: 6 }}>
                  <span className="c-scale">{s[0]}<small>{s[1]}/div</small></span>
                  <button className="switch" role="switch" aria-checked={on} aria-label={`CH${n} on`} onClick={() => void attempt(() => writeControl(key("channel.display", n), !on))} />
                </div>
                <div className="c-tags">
                  {coup && <span className="tag">{coup === "DC" || coup === "D1M" ? "DC" : coup === "AC" || coup === "A1M" ? "AC" : coup === "D50" ? "DC" : "GND"}</span>}
                  {coup === "D50" && <span className="tag" style={{ color: "var(--gold)" }}>50Ω</span>}
                  {coup === "OVL" && <span className="tag" style={{ color: "var(--coral)" }} title="The 50 Ω input was overloaded and the instrument disconnected it. Reduce the signal, then set the coupling again.">50Ω OVERLOAD</span>}
                  {bw !== "OFF" && <span className="tag">BW {bw}</span>}
                  {imp.startsWith("FIF") && <span className="tag" style={{ color: "var(--gold)" }}>50Ω</span>}
                  {typeof probe === "number" && probe !== 1 && <span className="tag">{probe}×</span>}
                </div>
              </div>
            );
          })}
          <div className="rail-card">
            <div className="r"><span>Sample rate</span><span>{fmt(values["acquire.srate"] as number, "Sa/s", 3)}</span></div>
            <div className="r"><span>Memory</span><span>{typeof values["acquire.mdepth"] === "number" ? fmt(values["acquire.mdepth"], "pts", 3) : String(values["acquire.mdepth"] ?? "—")}</span></div>
            <div className="r"><span>Acquire</span><span>{String(values["acquire.type"] ?? values["acquire.mode"] ?? "—").replace("NORMal", "Normal")}</span></div>
            {readings.counter !== null && <div className="r"><span>Counter</span><span>{fmt(readings.counter, String(values["counter.mode"] ?? "").startsWith("PER") ? "s" : "Hz", 6)}</span></div>}
            {readings.dvm !== null && <div className="r"><span>DVM</span><span>{fmt(readings.dvm, "V", 4)}</span></div>}
          </div>
        </>
      )}
    </nav>
  );
}

function StatusBar() {
  const link = useLive((s) => s.link);
  const stats = useLive((s) => s.stats);
  const stream = useLive((s) => s.streamUp);
  const problem = useLive((s) => s.problem);
  return (
    <footer className="status-bar">
      <span>{stream ? "server connected" : "server not reachable"}</span>
      {link?.state === "connected" && (
        <>
          <span>{link.idn?.serial} · fw <strong>{link.idn?.firmware}</strong></span>
          <span>link <strong>{link.transport ?? "tcp"}</strong> {linkAddress(link)}</span>
          {stats && <span>round trip <strong>{stats.rttMs === null ? "—" : `${stats.rttMs.toFixed(1)} ms`}</strong></span>}
          {stats && <span><strong>{stats.fps.toFixed(1)}</strong> screens/s</span>}
          {link.family === "rigol" && <span title="WORD byte order is detected from the data (see Instrument)">word <strong>{link.wordOrder}{link.wordOrderLocked ? "" : "?"}</strong></span>}
        </>
      )}
      {problem && <span style={{ color: "var(--gold)" }}>{problem}</span>}
      <span className="grow" />
      <span><span className="key">Space</span> run/stop <span className="key">S</span> single <span className="key">A</span> auto <span className="key">1–4</span> channel <span className="key">C</span> cursors <span className="key">P</span> persist</span>
    </footer>
  );
}

function Toasts() {
  const ts = useToasts();
  return (
    <div className="toast-stack" aria-live="polite">
      {ts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`} role={t.kind === "error" ? "alert" : "status"}>
          <span className="grow">{t.text}</span>
          <button className="icon-btn" aria-label="Dismiss" onClick={() => dismissToast(t.id)} style={{ width: 20, height: 20 }}><Icon.x /></button>
        </div>
      ))}
    </div>
  );
}
