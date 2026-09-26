// The instrument itself: identity and options, the link and how data is
// decoded, presets and setup files, system settings, and the actions that
// reset things (each behind a confirmation).

import { useEffect, useRef, useState } from "react";
import { C } from "../../../core/src/constants.ts";
import { fmt } from "../../../core/src/format.ts";
import { action, attempt, linkAddress, post, postBytes, readGroup, useLive } from "../api.ts";
import { Ctl, GroupPanel } from "../components/Controls.tsx";

export function InstrumentView() {
  const link = useLive((s) => s.link);
  const options = useLive((s) => s.options);
  const stats = useLive((s) => s.stats);
  const presets = useLive((s) => s.presets);
  const [name, setName] = useState("");
  const file = useRef<HTMLInputElement>(null);
  const connected = link?.state === "connected";
  useEffect(() => {
    if (connected) void readGroup("system").catch(() => {});
  }, [connected]);
  return (
    <>
      <div className="toolbar">
        <h1>Instrument</h1>
        <span className="hint">{link?.idn?.raw}</span>
      </div>
      <div className="pane scroll">
        <div className="settings-list">
          <div className="card">
            <div className="card-head">Identity</div>
            <div className="card-body">
              <div className="hero">{link?.idn?.model ?? "—"}<small>{link?.sim ? "simulated" : link?.idn?.vendor}</small></div>
              <div className="metric-row"><span>Serial</span><strong>{link?.idn?.serial}</strong></div>
              <div className="metric-row"><span>Firmware</span><strong>{link?.idn?.firmware}</strong></div>
              <Ctl id="system.version" label="SCPI version" />
              {link?.modelWarning && <p className="body-text" style={{ color: "var(--gold)" }}>{link.modelWarning}</p>}
              <div className="section-title" style={{ marginTop: 12 }}>Options (:SYSTem:OPTion:STATus?)</div>
              <div className="opt-grid">
                {C.instrument.options.map((o) => (
                  <div key={o} className="opt"><span className="mono">{o}</span><span className={`badge ${options[o] ? "ok" : "neutral"}`}>{options[o] ? "installed" : "no"}</span></div>
                ))}
              </div>
            </div>
          </div>
          <div className="card">
            <div className="card-head">Link</div>
            <div className="card-body">
              <div className="metric-row"><span>Address</span><strong>{linkAddress(link)}</strong></div>
              {link?.kind === "usb" && link.usb && <div className="metric-row"><span>USB device</span><strong>{link.usb.vendorId.toString(16).padStart(4, "0")}:{link.usb.productId.toString(16).padStart(4, "0")} {link.usb.product ?? ""}</strong></div>}
              <div className="metric-row"><span>Transport</span><strong>{link?.transport ?? "tcp"}</strong></div>
              <div className="metric-row"><span>Round trip</span><strong>{stats?.rttMs === null || !stats ? "—" : `${stats.rttMs.toFixed(1)} ms`}</strong></div>
              <div className="metric-row"><span>Screens read</span><strong>{stats?.frames ?? 0} · {stats?.fps.toFixed(1) ?? "0"}/s</strong></div>
              <div className="metric-row"><span>Commands</span><strong>{stats?.commands ?? 0}</strong></div>
              <div className="metric-row"><span>Received</span><strong>{fmt(stats?.bytesIn ?? 0, "B", 3)}</strong></div>
              <div className="metric-row"><span>WORD byte order</span><strong>{link?.wordOrder} {link?.wordOrderLocked ? <span className="badge ok">measured</span> : <span className="badge warn">not yet measured</span>}</strong></div>
              <p className="body-text">
                {link?.kind === "usb" ? "Over USB the same SCPI travels in USB-TMC bulk transfers (USB488). " : ""}Waveforms are read as 16-bit words so all 12 bits survive. The guide does not state the byte order, so the app reads it from the data (the right order gives a smooth trace, the wrong one jumps by hundreds of codes) and locks it after three confident screens.
              </p>
            </div>
          </div>
          <div className="card">
            <div className="card-head">Presets (instrument setup files)</div>
            <div className="card-body">
              <form className="row" onSubmit={(e) => (e.preventDefault(), void attempt(() => post("presets/save", { name }), `Saved "${name}"`).then(() => setName("")))}>
                <input className="input" placeholder="Preset name" value={name} onChange={(e) => setName(e.target.value)} aria-label="Preset name" />
                <button className="btn primary" disabled={!name.trim()} type="submit">Save current</button>
              </form>
              <div style={{ marginTop: 8 }}>
                {presets.length === 0 && <p className="body-text">None saved. A preset is the instrument's own :SYSTem:SETup? file, kept in {C.paths.presets_dir}.</p>}
                {presets.map((p) => (
                  <div key={p.name} className="metric-row">
                    <span>{p.name} <span className="muted">· {new Date(p.savedAt).toLocaleString()} · {p.model}</span></span>
                    <span className="row" style={{ gap: 4 }}>
                      <button className="btn small" onClick={() => void attempt(() => post("presets/recall", { name: p.name }), `Recalled "${p.name}"`)}>Recall</button>
                      <button className="btn small danger" onClick={() => void attempt(() => post("presets/delete", { name: p.name }))}>Delete</button>
                    </span>
                  </div>
                ))}
              </div>
              <div className="row" style={{ marginTop: 10 }}>
                <a className="btn small" href="./api/setup">Download setup file</a>
                <button className="btn small" onClick={() => file.current?.click()}>Load setup file…</button>
                <input ref={file} type="file" hidden onChange={async (e) => {
                  const f = e.target.files?.[0];
                  e.target.value = "";
                  if (!f) return;
                  const bytes = new Uint8Array(await f.arrayBuffer());
                  await attempt(() => postBytes("setup", bytes, "confirmed=1"), "Setup loaded");
                }} />
              </div>
            </div>
          </div>
          <div className="card">
            <div className="card-head">System</div>
            <div className="card-body">
              <Ctl id="system.beeper" />
              <Ctl id="system.language" />
              <Ctl id="system.pon" label="Power-on setup" />
              <Ctl id="system.pstatus" label="Power-on state" />
              <Ctl id="system.aoutput" label="Rear AUX OUT" />
              <Ctl id="system.locked" />
              <div className="row wrap" style={{ marginTop: 8 }}>
                <button className="btn small" onClick={() => void attempt(() => post<{ date: string; time: string }>("clock"), "Instrument clock set from this computer")}>Set clock from this PC</button>
                <button className="btn small" onClick={() => void attempt(() => action("common.cls"), "Status cleared")}>Clear status (*CLS)</button>
              </div>
            </div>
          </div>
          {([["autoset", "Autoset behaviour"], ["display", "Display"], ["lan", "LAN (read-only here)"]] as const).map(([g, t]) => (
            <div className="card" key={g}>
              <div className="card-body"><GroupPanel group={g} title={t} /></div>
            </div>
          ))}
          {link?.sim && (
            <div className="card">
              <div className="card-head">Simulated bench</div>
              <div className="card-body">
                <p className="body-text" style={{ marginTop: 0 }}>
                  GEN OUT 1 → CH1 directly and → CH2 through a second-order low-pass ({fmt(C.sim.filter_fc_hz, "Hz", 3)}, Q {C.sim.filter_q}). CH3: {fmt(C.sim.clock_hz, "Hz", 3)} {C.sim.clock_v} V clock with ringing. CH4: UART {C.sim.uart_baud} baud sending "{C.sim.uart_text.trim()}". Noise ≈ {fmt(C.sim.noise_vrms, "V", 2)} rms.
                </p>
                <p className="body-text">Modelled: the whole command set as stored values, 1-2-5 snapping and range limits, acquisition and triggering on the edge source, WORD/BYTE/ASCII transfer, RAW memory reads, measurements, counter, voltmeter, the generator, a UART bus table, arithmetic math, screenshots. Not modelled: other trigger types' conditions, protocol triggers, digital channels, mask/record/search results, filters and logic math.</p>
              </div>
            </div>
          )}
          <div className="card">
            <div className="card-head" style={{ color: "var(--coral)" }}>Reset</div>
            <div className="card-body">
              <p className="body-text" style={{ marginTop: 0 }}>Each asks first. Save a preset before a factory reset.</p>
              <div className="row wrap">
                <button className="btn small danger" onClick={() => void attempt(() => action("common.rst"), "Factory setup restored")}>Factory reset (*RST)</button>
                <button className="btn small danger" onClick={() => void attempt(() => action("system.reset"))}>Restart instrument</button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
