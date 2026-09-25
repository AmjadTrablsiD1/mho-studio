// Getting to an instrument: an address, a network scan, or the simulator.

import { useState } from "react";
import { C } from "../../../core/src/constants.ts";
import { attempt, post, useLive, type Link } from "../api.ts";
import { Icon } from "./Icons.tsx";

type Found = { host: string; port: number; idn: string; model: string; serial: string; ms: number };

export function ConnectPanel() {
  const settings = useLive((s) => s.settings);
  const link = useLive((s) => s.link);
  const [host, setHost] = useState(settings?.host ?? "");
  const [port, setPort] = useState(String(settings?.port ?? C.instrument.scpi_port));
  const [busy, setBusy] = useState<"connect" | "scan" | "sim" | null>(null);
  const [found, setFound] = useState<{ found: Found[]; scanned: string[] } | null>(null);
  const connect = async (body: Record<string, unknown>, which: "connect" | "sim") => {
    setBusy(which);
    await attempt(() => post<Link>("connect", body));
    setBusy(null);
  };
  return (
    <div className="pane">
      <div className="empty">
        <div className="connect-card" data-test="connect-card">
          <div>
            <h3>Connect to the {C.instrument.model}</h3>
            <p className="body-text">
              Over LAN, raw SCPI on port {C.instrument.scpi_port}. On the scope: <b>Utility → I/O → LAN</b> shows its IP address; DHCP or a fixed address both work.
            </p>
          </div>
          {link?.error && <div className="code" style={{ color: "var(--coral)" }} role="alert">{link.error}</div>}
          <form
            className="row"
            onSubmit={(e) => {
              e.preventDefault();
              void connect({ host, port: Number(port) }, "connect");
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
          <div className="row">
            <button
              className="btn"
              disabled={busy !== null}
              onClick={async () => {
                setBusy("scan");
                setFound(await attempt(() => post<{ found: Found[]; scanned: string[] }>("discover", { port: Number(port) })));
                setBusy(null);
              }}
            >
              {busy === "scan" ? "Scanning the local network…" : "Find instruments on this network"}
            </button>
            {found && <span className="muted" style={{ fontSize: 10 }}>scanned {found.scanned.join(", ") || "no IPv4 network"}</span>}
          </div>
          {found && (
            <div className="found">
              {found.found.length === 0 && <span className="muted" style={{ fontSize: 11 }}>Nothing answered *IDN? on port {port}. Is the scope on this subnet, with LAN enabled?</span>}
              {found.found.map((f) => (
                <button key={f.host} onClick={() => (setHost(f.host), void connect({ host: f.host, port: f.port }, "connect"))}>
                  <span><b>{f.model || "?"}</b> <span className="mono">{f.host}</span></span>
                  <span className="muted mono">{f.serial} · {f.ms} ms</span>
                </button>
              ))}
            </div>
          )}
          <div className="or">or</div>
          <div className="row">
            <button className="btn" data-test="use-sim" disabled={busy !== null} onClick={() => void connect({ sim: true }, "sim")}>
              {busy === "sim" ? "Starting…" : "Use the simulated MHO984"}
            </button>
            <span className="muted" style={{ fontSize: 10.5, lineHeight: 1.5 }}>
              A model of the scope on a simulated bench (generator → filter, a clock, a UART), over the same SCPI. For trying the app with no instrument.
            </span>
          </div>
        </div>
      </div>
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
            <div className="metric-row"><span>Address</span><strong>{link.sim ? "simulated bench (127.0.0.1)" : `${link.host}:${link.port}`}</strong></div>
            {link.idn && <div className="metric-row"><span>*IDN?</span><strong style={{ fontSize: 10 }}>{link.idn.raw}</strong></div>}
            <div className="metric-row"><span>Transport</span><strong>{link.transport ?? "—"}</strong></div>
            {stats && <div className="metric-row"><span>Commands / bytes in</span><strong>{stats.commands} / {(stats.bytesIn / 1e6).toFixed(1)} MB</strong></div>}
            <div className="metric-row"><span>Options</span><strong>{Object.entries(options).filter(([, v]) => v).map(([k]) => k).join(", ") || "none reported"}</strong></div>
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
