// Getting to an instrument: over LAN (an address or a scan; raw SCPI for a
// RIGOL, VICP for a Teledyne LeCroy), over USB (USB-TMC on the rear USB
// Device port), or one of the simulators.

import { useEffect, useState } from "react";
import { C } from "../../../core/src/constants.ts";
import { attempt, linkAddress, post, useLive, type Link, type UsbInfo } from "../api.ts";
import { Icon } from "./Icons.tsx";

type Found = { host: string; port: number; idn: string; model: string; serial: string; ms: number; via: string };
type UsbList = { available: boolean; error: string | null; platformNote: string; devices: UsbInfo[] };
type Tab = "lan" | "usb" | "sim";

const hex4 = (n: number) => n.toString(16).padStart(4, "0");

export function ConnectPanel() {
  const settings = useLive((s) => s.settings);
  const link = useLive((s) => s.link);
  const [tab, setTab] = useState<Tab>(settings?.lastKind === "usb" ? "usb" : settings?.lastKind === "sim" ? "sim" : "lan");
  const [busy, setBusy] = useState<string | null>(null);
  const connect = async (body: Record<string, unknown>, which: string) => {
    setBusy(which);
    await attempt(() => post<Link>("connect", body));
    setBusy(null);
  };
  return (
    <>
      <div className="toolbar">
        <h1>Connect</h1>
        <span className="hint">LAN · USB · simulators</span>
      </div>
      <div className="pane scroll">
      <div className="empty" style={{ position: "relative", minHeight: "100%" }}>
        <div className="connect-card" data-test="connect-card">
          <div>
            <h3>Connect to an oscilloscope</h3>
            <p className="body-text">A RIGOL MHO900 over the network or USB, a Teledyne LeCroy X-Stream scope (WaveRunner, WavePro, WaveMaster, SDA…) over the network, or try the app on a simulated one. The app recognises which it is from its answer to *IDN?.</p>
          </div>
          <div className="segmented" role="tablist" aria-label="Connection" style={{ justifySelf: "start" }}>
            {([["lan", "LAN"], ["usb", "USB"], ["sim", "Simulator"]] as [Tab, string][]).map(([t, l]) => (
              <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? "active" : ""} onClick={() => setTab(t)} data-test={`tab-${t}`}>{l}</button>
            ))}
          </div>
          {link?.error && <div className="code" style={{ color: "var(--coral)" }} role="alert">{link.error}</div>}
          {tab === "lan" && <LanTab busy={busy} setBusy={setBusy} connect={connect} />}
          {tab === "usb" && <UsbTab busy={busy} connect={connect} />}
          {tab === "sim" && (
            <div style={{ display: "grid", gap: 14 }}>
              <div style={{ display: "grid", gap: 8 }}>
                <p className="body-text" style={{ margin: 0 }}>
                  <b>RIGOL MHO984</b> on a simulated bench — generator into CH1 and through a 20 kHz low-pass into CH2, a 1 MHz clock on CH3, a UART on CH4 — answering the same SCPI on a raw socket.
                </p>
                <button className="btn primary" style={{ justifySelf: "start" }} data-test="use-sim" disabled={busy !== null} onClick={() => void connect({ sim: true, simModel: "rigol" }, "sim")}>
                  {busy === "sim" ? "Starting…" : "Use the simulated MHO984"}
                </button>
              </div>
              <div style={{ display: "grid", gap: 8 }}>
                <p className="body-text" style={{ margin: 0 }}>
                  <b>Teledyne LeCroy X-Stream</b> (a stand-in for an unknown 40 GS/s model) speaking VICP — a 10 MHz sine on CH1, a 1 MHz clock on CH2, a 100 kHz square on CH3, a UART on CH4.
                </p>
                <button className="btn" style={{ justifySelf: "start" }} data-test="use-sim-lecroy" disabled={busy !== null} onClick={() => void connect({ sim: true, simModel: "lecroy" }, "sim-lecroy")}>
                  {busy === "sim-lecroy" ? "Starting…" : "Use the simulated LeCroy"}
                </button>
              </div>
              <p className="body-text" style={{ margin: 0, fontSize: 10.5 }}>For trying the app with no instrument; everything they show is labelled "Simulated".</p>
            </div>
          )}
        </div>
      </div>
      </div>
    </>
  );
}

type Brand = "rigol" | "lecroy";
const PORT: Record<Brand, number> = { rigol: C.instrument.scpi_port, lecroy: C.lecroy.vicp_port };
const PROTOCOL: Record<Brand, "raw" | "vicp"> = { rigol: "raw", lecroy: "vicp" };

function LanTab({ busy, setBusy, connect }: { busy: string | null; setBusy: (b: string | null) => void; connect: (b: Record<string, unknown>, w: string) => Promise<void> }) {
  const settings = useLive((s) => s.settings);
  const [brand, setBrand] = useState<Brand>(settings?.protocol === "vicp" ? "lecroy" : "rigol");
  const [host, setHost] = useState(settings?.host ?? "");
  const [port, setPort] = useState(String(settings?.port ?? PORT[brand]));
  const [found, setFound] = useState<{ found: Found[]; scanned: string[] } | null>(null);
  const pick = (b: Brand) => {
    setBrand(b);
    setPort(String(PORT[b]));
    setFound(null);
  };
  return (
    <div style={{ display: "grid", gap: 12 }}>
      <div className="segmented" role="radiogroup" aria-label="Instrument family" style={{ justifySelf: "start" }}>
        <button role="radio" aria-checked={brand === "rigol"} className={brand === "rigol" ? "active" : ""} onClick={() => pick("rigol")} data-test="brand-rigol">RIGOL · raw SCPI</button>
        <button role="radio" aria-checked={brand === "lecroy"} className={brand === "lecroy" ? "active" : ""} onClick={() => pick("lecroy")} data-test="brand-lecroy">LeCroy · VICP</button>
      </div>
      {brand === "rigol" ? (
        <p className="body-text" style={{ margin: 0 }}>
          Raw SCPI on port {C.instrument.scpi_port}. On the scope, <b>Utility → I/O → LAN</b> shows its address. A router is not needed: a cable straight from the scope to this computer works too.
        </p>
      ) : (
        <p className="body-text" style={{ margin: 0 }}>
          VICP on port {C.lecroy.vicp_port}. On the scope, <b>Utilities → Utilities Setup → Remote</b> must say <b>TCPIP (VICP)</b>; that page also shows its IP address (or see the network settings of its Windows). The Windows firewall on the scope must let port {C.lecroy.vicp_port} in. A cable straight from the scope to this computer works, with both given addresses in one subnet.
        </p>
      )}
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          void connect({ host, port: Number(port), protocol: PROTOCOL[brand] }, "connect");
        }}
      >
        <div className="field grow">
          <label htmlFor="host">IP address or hostname</label>
          <input id="host" className="input" value={host} placeholder="192.168.1.50" list="recent-hosts" onChange={(e) => setHost(e.target.value)} autoComplete="off" />
          <datalist id="recent-hosts">{settings?.recent.map((h) => <option key={h} value={h} />)}</datalist>
        </div>
        <div className="field" style={{ width: 84 }}>
          <label htmlFor="port">Port</label>
          <input id="port" className="input" value={port} onChange={(e) => setPort(e.target.value)} />
        </div>
        <button className="btn primary" style={{ alignSelf: "end", height: 29 }} disabled={!host.trim() || busy !== null} type="submit">
          {busy === "connect" ? "Connecting…" : "Connect"}
        </button>
      </form>
      <div className="row wrap">
        <button
          className="btn"
          disabled={busy !== null}
          onClick={async () => {
            setBusy("scan");
            setFound(await attempt(() => post<{ found: Found[]; scanned: string[] }>("discover", { port: Number(port), protocol: PROTOCOL[brand] })));
            setBusy(null);
          }}
        >
          {busy === "scan" ? "Searching…" : "Find instruments on this network"}
        </button>
        {found && <span className="muted" style={{ fontSize: 10 }}>looked at {found.scanned.join(" · ") || "nothing (no IPv4 network)"}</span>}
      </div>
      {found && (
        <div className="found">
          {found.found.length === 0 && <span className="muted" style={{ fontSize: 11 }}>Nothing answered *IDN? on port {port}. Check the cable and that {brand === "lecroy" ? "Remote is set to TCPIP (VICP) on the scope" : "LAN is enabled on the scope"}; on a direct cable, give both ends addresses in the same subnet (e.g. 192.168.10.2 and .1).</span>}
          {found.found.map((f) => (
            <button key={f.host} onClick={() => (setHost(f.host), void connect({ host: f.host, port: f.port, protocol: PROTOCOL[brand] }, "connect"))}>
              <span><b>{f.model || "?"}</b> <span className="mono">{f.host}</span></span>
              <span className="muted mono">{f.serial} · {f.via} · {f.ms} ms</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function UsbTab({ busy, connect }: { busy: string | null; connect: (b: Record<string, unknown>, w: string) => Promise<void> }) {
  const [list, setList] = useState<UsbList | null>(null);
  const [scanning, setScanning] = useState(false);
  const scan = async () => {
    setScanning(true);
    setList(await attempt(() => post<UsbList>("usb")));
    setScanning(false);
  };
  useEffect(() => {
    void scan();
  }, []);
  return (
    <div style={{ display: "grid", gap: 12 }} data-test="usb-tab">
      <p className="body-text" style={{ margin: 0 }}>
        USB-TMC on the rear <b>USB Device</b> port (the square type-B socket) with a data cable. The front USB port is for memory sticks only.
        A Windows-based LeCroy is reached over LAN (VICP): its USB sockets are for mice and memory sticks.
      </p>
      <div className="row wrap">
        <button className="btn" disabled={scanning || busy !== null} onClick={() => void scan()} data-test="usb-scan">{scanning ? "Looking…" : "Look for USB instruments"}</button>
        <button className="btn primary" disabled={busy !== null || !list?.available} onClick={() => void connect({ usb: true }, "usb")} data-test="usb-connect-first">
          {busy === "usb" ? "Connecting…" : "Connect to the first RIGOL on USB"}
        </button>
      </div>
      {list && !list.available && <div className="code" style={{ color: "var(--gold)" }}>{list.error}</div>}
      {list?.available && (
        <div className="found">
          {list.devices.length === 0 && <span className="muted" style={{ fontSize: 11 }}>No RIGOL or USB-TMC device is connected. Plug the scope's rear USB Device port into this computer and look again.</span>}
          {list.devices.map((d) => (
            <button key={d.id} onClick={() => void connect({ usb: true, usbId: d.id }, "usb")} disabled={busy !== null}>
              <span><b>{d.product ?? "USB instrument"}</b> <span className="muted">{d.manufacturer ?? ""}</span></span>
              <span className="muted mono">{hex4(d.vendorId)}:{hex4(d.productId)} · {d.serial ?? "no serial"}{d.usbtmc === false ? " · not USB-TMC" : ""}</span>
            </button>
          ))}
        </div>
      )}
      {list && <p className="body-text" style={{ margin: 0, fontSize: 10.5 }}>{list.platformNote}</p>}
    </div>
  );
}

export function ConnectionModal({ onClose }: { onClose: () => void }) {
  const link = useLive((s) => s.link);
  const stats = useLive((s) => s.stats);
  const options = useLive((s) => s.options);
  const connected = link?.state === "connected";
  return (
    <div className="modal-back" role="dialog" aria-modal="true" aria-labelledby="link-title" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="title-row" style={{ marginBottom: 0 }}>
          <h2 id="link-title">Connection</h2>
          <button className="icon-btn" aria-label="Close" onClick={onClose}><Icon.x /></button>
        </div>
        {link && (
          <div>
            <div className="metric-row"><span>State</span><strong>{link.state}</strong></div>
            <div className="metric-row"><span>Link</span><strong>{link.kind === "usb" ? "USB-TMC" : link.kind === "sim" ? `simulator (${link.protocol === "vicp" ? "VICP" : "raw SCPI"})` : link.protocol === "vicp" ? "LAN · VICP" : "LAN · raw SCPI"}</strong></div>
            <div className="metric-row"><span>Driver</span><strong>{link.family === "lecroy" ? "Teledyne LeCroy X-Stream" : "RIGOL MHO900"}</strong></div>
            <div className="metric-row"><span>Address</span><strong>{linkAddress(link)}</strong></div>
            {link.idn && <div className="metric-row"><span>*IDN?</span><strong style={{ fontSize: 10 }}>{link.idn.raw}</strong></div>}
            <div className="metric-row"><span>Transport</span><strong>{link.transport ?? "—"}</strong></div>
            {stats && <div className="metric-row"><span>Commands / bytes in</span><strong>{stats.commands} / {(stats.bytesIn / 1e6).toFixed(1)} MB</strong></div>}
            {link.family === "rigol" && <div className="metric-row"><span>Options</span><strong>{Object.entries(options).filter(([, v]) => v).map(([k]) => k).join(", ") || "none reported"}</strong></div>}
            {link.modelWarning && <p className="body-text" style={{ color: "var(--gold)" }}>{link.modelWarning}</p>}
            {link.error && <p className="body-text" style={{ color: "var(--coral)" }}>{link.error}</p>}
          </div>
        )}
        <div className="actions">
          {connected && <button className="btn danger" onClick={() => void attempt(() => post("disconnect")).then(onClose)}>Disconnect</button>}
          <button className="btn" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
