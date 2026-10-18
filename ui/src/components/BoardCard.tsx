// The STM32H743 board as a Bode generator: pick its serial port, connect,
// see what the firmware, the Si5351 and the DAC report. MHO Studio holds the port only
// while connected — Board Test GUI cannot have it at the same time.

import { useEffect, useState } from "react";
import { C } from "../../../core/src/constants.ts";
import { fmt } from "../../../core/src/format.ts";
import { attempt, post, useLive, type BoardPortInfo } from "../api.ts";

type PortList = { available: boolean; error: string | null; ports: BoardPortInfo[] };

const LOADS: [number, string][] = [[2, "10 pF"], [1, "8 pF"], [0, "6 pF"]];
const DRIVE_MA = [2, 4, 6, 8];

export function BoardCard() {
  const board = useLive((s) => s.board);
  const [list, setList] = useState<PortList | null>(null);
  const [path, setPath] = useState<string>("");
  const [xtal, setXtal] = useState(String(C.board.si5351.xtal_hz));
  const [load, setLoad] = useState(String(C.board.si5351.load));
  const [working, setWorking] = useState<string | null>(null);

  const scan = async () => {
    const l = await attempt(() => post<PortList>("board/ports"));
    if (!l) return;
    setList(l);
    if (!l.ports.some((p) => p.path === path)) setPath((l.ports.find((p) => p.likely) ?? l.ports[0])?.path ?? "");
  };
  useEffect(() => {
    void scan();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const run = async (what: string, f: () => Promise<unknown>) => {
    setWorking(what);
    try {
      await attempt(f);
    } finally {
      setWorking(null);
    }
  };
  const connected = board?.state === "connected";
  const held = !!board?.busy;
  const si = board?.si5351;

  return (
    <div className="card" data-test="board-card">
      <div className="card-head">STM32 board · Si5351 · DAC</div>
      <div className="card-body" style={{ display: "grid", gap: 9 }}>
        {!connected ? (
          <>
            <div className="field">
              <label htmlFor="board-port">Serial port</label>
              <div style={{ display: "flex", gap: 6 }}>
                <select id="board-port" data-test="board-port" className="input" style={{ flex: 1, minWidth: 0 }} value={path} onChange={(e) => setPath(e.target.value)}>
                  {(list?.ports ?? []).map((p) => <option key={p.path} value={p.path}>{p.label}</option>)}
                </select>
                <button className="btn" onClick={() => void scan()} title="Look for serial ports again">↻</button>
              </div>
            </div>
            {list && !list.available && <p className="body-text muted" style={{ margin: 0 }}>{list.error}</p>}
            {list?.available && !list.ports.some((p) => p.likely) && <p className="body-text muted" style={{ margin: 0 }}>No CH340 found. Plug the board's COM port (not the USB-C OTG port) into this computer, then ↻.</p>}
            <button className="btn primary" data-test="board-connect" disabled={!path || working !== null || board?.state === "connecting"} onClick={() => void run("connect", () => post("board/connect", { path }))}>
              {working === "connect" || board?.state === "connecting" ? "Connecting…" : "Connect to the board"}
            </button>
          </>
        ) : (
          <>
            <div className="metric-row" data-test="board-status"><span><span className="dot ok" style={{ display: "inline-block", marginRight: 6 }} />{board.sim ? "Simulated board" : board.port}</span><strong>{board.baud} baud</strong></div>
            <div className="metric-row"><span>Firmware</span><strong>{board.version ? `v${board.version.firmware}, protocol ${board.version.protocol} · ${board.version.built}` : "—"}</strong></div>
            <div className="metric-row" data-test="board-si5351">
              <span>Si5351</span>
              <strong style={{ color: si && !si.present ? "var(--coral)" : undefined }}>
                {!si ? "not checked yet" : si.present ? `found at 0x${si.address.toString(16)}${si.xtalHz ? ` · ${fmt(si.xtalHz, "Hz")} crystal` : ""}` : "not found"}
              </strong>
            </div>
            {board.clk.map((c) => (
              <div key={c.ch} className="metric-row" data-test={`board-clk${c.ch}`}>
                <span>CLK{c.ch}</span>
                <strong className="num">{c.hz > 0 ? fmt(c.hz, "Hz", 7) : "—"} · {c.on ? "on" : "off"} · {DRIVE_MA[c.drive]} mA{c.sweeping ? " · sweeping" : ""}{c.unreachable ? " · unreachable" : ""}</strong>
              </div>
            ))}
            {board.dac && (
              <div className="metric-row" data-test="board-dac">
                <span>DAC ({C.board.dac.pin}, PA5)</span>
                <strong className="num">{!board.dac.running ? "idle" : board.dac.source === 2 ? `sine ${board.dac.hz ? fmt(board.dac.hz, "Hz", 6) : ""}` : board.dac.source === 1 ? "FDM waveform" : `stored waveform ${board.dac.source - 0x10}`}</strong>
              </div>
            )}
            <div className="form-grid" style={{ gridTemplateColumns: "1fr 1fr auto", alignItems: "end" }}>
              <div className="field">
                <label htmlFor="board-xtal">Crystal</label>
                <select id="board-xtal" className="input" value={xtal} disabled={held} onChange={(e) => setXtal(e.target.value)}>
                  {C.board.si5351.xtals_hz.map((x) => <option key={x} value={x}>{fmt(x, "Hz")}</option>)}
                </select>
              </div>
              <div className="field">
                <label htmlFor="board-load">Load</label>
                <select id="board-load" className="input" value={load} disabled={held} onChange={(e) => setLoad(e.target.value)}>
                  {LOADS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select>
              </div>
              <button className="btn" data-test="board-detect" disabled={held || working !== null} title="Probe the Si5351 and re-apply every output (ClkInit)" onClick={() => void run("detect", () => post("board/detect", { xtalHz: Number(xtal), load: Number(load) }))}>
                {working === "detect" ? "…" : "Detect"}
              </button>
            </div>
            <button className="btn" data-test="board-disconnect" disabled={held || working !== null} onClick={() => void run("disconnect", () => post("board/disconnect"))}>
              Disconnect (frees the port for Board Test GUI)
            </button>
            {board.log.length > 0 && (
              <div className="mono muted" style={{ fontSize: 10, lineHeight: 1.45, overflowWrap: "anywhere" }} title="The firmware's own log, which shares the serial line">
                {board.log.slice(-3).map((l, i) => <div key={i}>{l}</div>)}
              </div>
            )}
          </>
        )}
        {board?.error && <p className="body-text" style={{ color: "var(--coral)", margin: 0 }} data-test="board-error">{board.error}</p>}
        <p className="body-text muted" style={{ margin: 0 }}>
          Wire the Si5351 module's CLKx (a 0–3.3 V square) or the DAC's {C.board.dac.pin} (a sine on {C.board.dac.offset_v} V, buffered by OPAMP1; P1 header) to the circuit's input and, with a tee, to the input channel; ground to ground. For a small-signal circuit put a divider after CLKx and take the input channel after it — the ratio does not care how large the drive is.
        </p>
      </div>
    </div>
  );
}
