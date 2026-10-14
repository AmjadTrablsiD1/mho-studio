// The instrument itself: identity and options, the link and how data is
// decoded, presets and setup files, system settings, and the actions that
// reset things (each behind a confirmation).

import { useEffect, useRef, useState } from "react";
import { C } from "../../../core/src/constants.ts";
import { registryFor } from "../../../core/src/registry/families.ts";
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
  const lecroy = link?.family === "lecroy";
  const siglent = link?.family === "siglent";
  const rigol = !lecroy && !siglent;
  useEffect(() => {
    if (connected && rigol) void readGroup("system").catch(() => {});
  }, [connected, rigol]);
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
              <div className="metric-row"><span>Driver</span><strong>{registryFor(link?.family).label}</strong></div>
              <Ctl id="system.version" label="SCPI version" />
              {link?.modelWarning && <p className="body-text" style={{ color: "var(--gold)" }}>{link.modelWarning}</p>}
              {rigol && (
                <>
                  <div className="section-title" style={{ marginTop: 12 }}>Options (:SYSTem:OPTion:STATus?)</div>
                  <div className="opt-grid">
                    {C.instrument.options.map((o) => (
                      <div key={o} className="opt"><span className="mono">{o}</span><span className={`badge ${options[o] ? "ok" : "neutral"}`}>{options[o] ? "installed" : "no"}</span></div>
                    ))}
                  </div>
                </>
              )}
              {lecroy && <p className="body-text">Installed options are listed on the instrument (Utilities → Utilities Setup → Options). Anything the app has no panel for can be reached from the console with a VBS line.</p>}
              {siglent && <p className="body-text">Installed options are listed on the instrument (Utility → System Status). It does not answer *OPT?. Anything the app has no panel for can be reached from the console with the Siglent command set.</p>}
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
              {lecroy ? (
                <p className="body-text">
                  Messages travel in VICP frames on port {C.lecroy.vicp_port}; each reply carries the number of the query it answers, so a late reply is recognised and dropped. Waveforms come as a WAVEDESC descriptor plus 16-bit little-endian words (CFMT DEF9,WORD,BIN; CORD LO); volts = VERTICAL_GAIN × code − VERTICAL_OFFSET. The live screen asks for every Nth point (about {C.lecroy.screen_points} per channel); Deep memory reads them all.
                </p>
              ) : siglent ? (
                <p className="body-text">
                  {link?.kind === "usb" ? "USB-TMC bulk transfers (USB488); the instrument follows each data block with an empty transfer, which is skipped. " : `Raw SCPI on port ${C.siglent.scpi_port}. `}Headers are off (CHDR OFF). Waveforms come as signed 8-bit codes after "DAT2," with two newlines at the end; volts = code × V/div / {C.siglent.codes_per_div} − offset, the first point {C.siglent.divisions_x / 2} divisions before the screen centre. The live screen asks for every Nth point (about {C.siglent.screen_points} per channel); Deep memory reads them all. Screenshots come as a BMP and are kept as PNG.
                </p>
              ) : (
                <>
                  <div className="metric-row"><span>WORD byte order</span><strong>{link?.wordOrder} {link?.wordOrderLocked ? <span className="badge ok">measured</span> : <span className="badge warn">not yet measured</span>}</strong></div>
                  <p className="body-text">
                    {link?.kind === "usb" ? "Over USB the same SCPI travels in USB-TMC bulk transfers (USB488). " : ""}Waveforms are read as 16-bit words so all 12 bits survive. The guide does not state the byte order, so the app reads it from the data (the right order gives a smooth trace, the wrong one jumps by hundreds of codes) and locks it after three confident screens.
                  </p>
                </>
              )}
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
                {presets.length === 0 && <p className="body-text">None saved. A preset is the instrument's own setup file (:SYSTem:SETup? on a RIGOL, PNSU? on a LeCroy or a T3DSO), kept in {C.paths.presets_dir}.</p>}
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
          {rigol && (
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
          )}
          {rigol && ([["autoset", "Autoset behaviour"], ["display", "Display"], ["lan", "LAN (read-only here)"]] as const).map(([g, t]) => (
            <div className="card" key={g}>
              <div className="card-body"><GroupPanel group={g} title={t} /></div>
            </div>
          ))}
          {link?.sim && lecroy && (
            <div className="card">
              <div className="card-head">Simulated LeCroy</div>
              <div className="card-body">
                <p className="body-text" style={{ marginTop: 0 }}>
                  A stand-in for an unknown X-Stream model: up to {fmt(C.lecroy.sim.max_sample_rate, "Sa/s", 3)}, 8-bit codes sent as 16-bit words. CH1: {fmt(C.lecroy.sim.ch1_sine_hz, "Hz", 3)} sine, {C.lecroy.sim.ch1_vpp} Vpp. CH2: {fmt(C.sim.clock_hz, "Hz", 3)} {C.sim.clock_v} V clock with ringing. CH3: {fmt(C.lecroy.sim.ch3_square_hz, "Hz", 3)} square. CH4: UART. Noise ≈ {fmt(C.lecroy.sim.noise_vrms, "V", 2)} rms.
                </p>
                <p className="body-text">Modelled: VICP framing and sequence numbers, CHDR, the channel/timebase/trigger commands the app uses, WFSU sparsing and chunked reads, WAVEDESC, PAVA, CMR/EXR/INR, SCDP, PNSU, a few VBS properties, and silence plus a CMR error for unknown queries. Not modelled: everything else a real X-Stream scope does — math, zoom, other trigger types, sequence mode, RIS — and its real timing.</p>
              </div>
            </div>
          )}
          {link?.sim && siglent && (
            <div className="card">
              <div className="card-head">Simulated T3DSO1204</div>
              <div className="card-body">
                <p className="body-text" style={{ marginTop: 0 }}>
                  Answers in the formats the real T3DSO1204 used (fw 8.3.6.1.37R8): *IDN? "Lecroy,T3DSO1204 ,…", numbers without units after CHDR OFF, "DAT2,#9…" + bytes + two newlines, PAVA with "****", raw BMP screenshots, PNSU as XML, *ESR? errors. {C.siglent.divisions_x} divisions; CH1/CH2 and CH3/CH4 share {fmt(C.siglent.sim.max_sample_rate, "Sa/s", 3)}. CH1: {fmt(C.siglent.sim.ch1_sine_hz, "Hz", 3)} sine, {C.siglent.sim.ch1_vpp} Vpp. CH2: {fmt(C.sim.clock_hz, "Hz", 3)} {C.sim.clock_v} V clock. CH3: {fmt(C.siglent.sim.ch3_square_hz, "Hz", 3)} square. CH4: UART.
                </p>
              </div>
            </div>
          )}
          {link?.sim && rigol && (
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
                {rigol && <button className="btn small danger" onClick={() => void attempt(() => action("system.reset"))}>Restart instrument</button>}
              </div>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
