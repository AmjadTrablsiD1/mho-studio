// The live screen: canvases, drag handles and wheel knobs. Frames and values
// are read in the animation loop; React renders only the DOM read-outs.

import { useEffect, useRef, useState } from "react";
import { C } from "../../../core/src/constants.ts";
import { key } from "../../../core/src/registry/controls.ts";
import { reg } from "../registry.ts";
import { fmt } from "../../../core/src/format.ts";
import { getLive, latestFrame, onFrame, useLive, writeControl, attempt } from "../api.ts";
import { getUi, setUi, useUi } from "../uistate.ts";
import { nextValue } from "../components/Controls.tsx";
import { onThemeChange } from "../theme.ts";
import { drawOverlay, drawTraces, geometry, hit, mapping, sampleAt, triggerChannel, type Geometry, type Marker, type ScreenState } from "./screen.ts";

type Drag = { marker: Marker; pos: number; lastSent: number; pending: number | null };

export function ScopeScreen() {
  const host = useRef<HTMLDivElement>(null);
  const traces = useRef<HTMLCanvasElement>(null);
  const overlay = useRef<HTMLCanvasElement>(null);
  const trail = useRef<HTMLCanvasElement | null>(null);
  const geo = useRef<Geometry | null>(null);
  const drag = useRef<Drag | null>(null);
  const dirty = useRef(true);
  const lastSeq = useRef(-1);
  const [hover, setHover] = useState<{ x: number; y: number; t: number; v: number | null } | null>(null);
  const [dragging, setDragging] = useState(false);
  const cursors = useUi((u) => u.cursors);
  const stopped = useLive((s) => s.status === "STOP");

  // One render loop for the component's life; it draws only when something changed.
  useEffect(() => {
    const h = host.current!;
    const tc = traces.current!;
    const oc = overlay.current!;
    trail.current = document.createElement("canvas");
    let raf = 0;
    const resize = () => {
      const r = h.getBoundingClientRect();
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      for (const c of [tc, oc, trail.current!]) {
        c.width = Math.max(1, Math.round(r.width * dpr));
        c.height = Math.max(1, Math.round(r.height * dpr));
      }
      geo.current = geometry(r.width, r.height, dpr);
      dirty.current = true;
    };
    const ro = new ResizeObserver(resize);
    ro.observe(h);
    resize();
    const state = (): ScreenState => {
      const u = getUi();
      const d = drag.current;
      return { values: getLive().values, frame: latestFrame(), selected: u.channel, cursors: u.cursors, ca: u.ca, cb: u.cb, va: u.va, vb: u.vb, persistence: u.persistence, drag: d ? { marker: d.marker, pos: d.pos } : null };
    };
    const loop = () => {
      raf = requestAnimationFrame(loop);
      const g = geo.current;
      if (!g) return;
      const fr = latestFrame();
      const newFrame = !!fr && fr.seq !== lastSeq.current;
      if (!newFrame && !dirty.current) return;
      const s = state();
      const tctx = tc.getContext("2d")!;
      tctx.setTransform(1, 0, 0, 1, 0, 0);
      tctx.clearRect(0, 0, tc.width, tc.height);
      if (s.persistence) {
        const pc = trail.current!;
        const p = pc.getContext("2d")!;
        if (newFrame) {
          p.setTransform(1, 0, 0, 1, 0, 0);
          p.globalCompositeOperation = "destination-out";
          p.fillStyle = `rgba(0,0,0,${1 - C.ui.persistence_decay})`;
          p.fillRect(0, 0, pc.width, pc.height);
          p.globalCompositeOperation = "source-over";
          p.setTransform(g.dpr, 0, 0, g.dpr, 0, 0);
          drawTraces(p, g, s);
        }
        tctx.drawImage(pc, 0, 0);
      } else {
        tctx.setTransform(g.dpr, 0, 0, g.dpr, 0, 0);
        drawTraces(tctx, g, s);
      }
      const octx = oc.getContext("2d")!;
      octx.setTransform(1, 0, 0, 1, 0, 0);
      octx.clearRect(0, 0, oc.width, oc.height);
      octx.setTransform(g.dpr, 0, 0, g.dpr, 0, 0);
      drawOverlay(octx, g, s);
      if (fr) lastSeq.current = fr.seq;
      dirty.current = false;
    };
    raf = requestAnimationFrame(loop);
    const offFrame = onFrame(() => undefined);
    const offTheme = onThemeChange(() => {
      const p = trail.current!.getContext("2d")!;
      p.setTransform(1, 0, 0, 1, 0, 0);
      p.clearRect(0, 0, trail.current!.width, trail.current!.height);
      dirty.current = true;
    });
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      offFrame();
      offTheme();
    };
  }, []);

  // Anything that moves markers without a new frame (values, cursors) marks the overlay dirty.
  const values = useLive((s) => s.values);
  const uiDeps = useUi((u) => `${u.channel}|${u.cursors}|${u.ca}|${u.cb}|${u.va}|${u.vb}|${u.persistence}`);
  useEffect(() => {
    dirty.current = true;
  }, [values, uiDeps]);
  useEffect(() => {
    if (!getUi().persistence && trail.current) trail.current.getContext("2d")!.clearRect(0, 0, trail.current.width, trail.current.height);
  }, [uiDeps]);

  const local = (e: { clientX: number; clientY: number }) => {
    const r = overlay.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  /** The value a marker at pixel position `pos` stands for. */
  const valueFor = (mk: Marker, pos: number): { k: string; v: number } | null => {
    const g = geo.current!;
    const m = mapping(g, getLive().values);
    if (mk.kind === "ground") return { k: key("channel.offset", mk.ch), v: m.offsetAt(mk.ch, pos) };
    if (mk.kind === "level") {
      const ch = triggerChannel(getLive().values);
      return ch ? { k: "trigger.edge.level", v: m.v(ch, pos) } : null;
    }
    if (mk.kind === "tpos") {
      if (reg().byId.get("timebase.offset")?.set) return { k: "timebase.offset", v: -(m.t(pos) - m.toff) };
      // LeCroy: the screen centre is read from the record; the trigger position (HorOffset, + = right) moves it.
      // Dropping the marker t seconds right of the trigger moves the trigger t seconds right.
      const d = getLive().values["timebase.delay"];
      return reg().byId.get("timebase.delay")?.set ? { k: "timebase.delay", v: (typeof d === "number" ? d : 0) + m.t(pos) } : null;
    }
    return null;
  };

  const send = (k: string, v: number) => {
    const c = reg().byId.get(k.split("@")[0])!;
    const r = Number(v.toPrecision(4));
    void attempt(() => writeControl(k, c.min !== undefined ? Math.max(c.min, r) : r));
  };

  const onDown = (e: React.PointerEvent) => {
    const g = geo.current;
    if (!g) return;
    const p = local(e);
    const mk = hit(g, { ...stateNow(), drag: null }, p.x, p.y);
    if (!mk) return;
    (e.target as Element).setPointerCapture(e.pointerId);
    const pos = mk.kind === "tpos" || (mk.kind === "cursor" && mk.x !== undefined) ? p.x : p.y;
    drag.current = { marker: mk, pos, lastSent: 0, pending: null };
    setDragging(true);
    dirty.current = true;
  };

  const onMove = (e: React.PointerEvent) => {
    const g = geo.current;
    if (!g) return;
    const p = local(e);
    const d = drag.current;
    if (d) {
      const horizontal = d.marker.kind === "tpos" || (d.marker.kind === "cursor" && d.marker.x !== undefined);
      d.pos = horizontal ? Math.min(g.gx + g.gw, Math.max(g.gx, p.x)) : Math.min(g.gy + g.gh, Math.max(g.gy, p.y));
      dirty.current = true;
      if (d.marker.kind === "cursor") {
        const m = mapping(g, getLive().values);
        const u = getUi();
        if (d.marker.which === "ca" || d.marker.which === "cb") setUi({ [d.marker.which]: m.t(d.pos) });
        else setUi({ [d.marker.which]: m.v(u.channel, d.pos) });
      } else if (Date.now() - d.lastSent > C.ui.drag_write_ms && !(d.marker.kind === "tpos" && reg().family === "lecroy")) {
        // (a LeCroy trigger position is sent once, on release: it is relative, and the screen catches up only with the next record)
        const w = valueFor(d.marker, d.pos);
        if (w) send(w.k, w.v);
        d.lastSent = Date.now();
      }
      return;
    }
    if (p.x < g.gx || p.x > g.gx + g.gw || p.y < g.gy || p.y > g.gy + g.gh) {
      setHover(null);
      return;
    }
    const m = mapping(g, getLive().values);
    const t = m.t(p.x);
    setHover({ x: p.x, y: p.y, t, v: sampleAt(latestFrame(), `CHANnel${getUi().channel}`, t) });
  };

  const onUp = () => {
    const d = drag.current;
    if (d && d.marker.kind !== "cursor") {
      const w = valueFor(d.marker, d.pos);
      if (w) send(w.k, w.v);
    }
    drag.current = null;
    setDragging(false);
    dirty.current = true;
  };

  const wheelAt = useRef(0);
  const onWheel = (e: React.WheelEvent) => {
    if (Date.now() - wheelAt.current < 110) return;
    wheelAt.current = Date.now();
    const dir = e.deltaY < 0 ? -1 : 1; // wheel up = zoom in = smaller scale
    const vals = getLive().values;
    if (e.shiftKey) {
      const ch = getUi().channel;
      const k = key("channel.scale", ch);
      const v = vals[k];
      if (typeof v === "number") void attempt(() => writeControl(k, nextValue(reg().byId.get("channel.scale")!, ch, v, dir as 1 | -1, e.altKey)));
    } else {
      const v = vals["timebase.scale"];
      if (typeof v === "number") void attempt(() => writeControl("timebase.scale", nextValue(reg().byId.get("timebase.scale")!, null, v, dir as 1 | -1, e.altKey)));
    }
  };

  return (
    <div ref={host} className={`scope-frame${dragging ? " dragging" : ""}`} data-test="scope-screen">
      <canvas ref={traces} aria-hidden="true" />
      <canvas
        ref={overlay}
        className="overlay"
        role="img"
        aria-label="Oscilloscope screen. Drag the channel markers on the left, the trigger marker on the right or top; wheel changes the timebase, Shift+wheel the selected channel's scale."
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        onPointerLeave={() => setHover(null)}
        onWheel={onWheel}
      />
      {hover && !dragging && cursors === "off" && (
        <div className="hover-read" style={{ left: Math.min(hover.x + 12, (geo.current?.w ?? 0) - 150), top: Math.max(4, hover.y - 24) }}>
          {fmt(hover.t, "s", 4)} · CH{getUi().channel} {hover.v === null ? "—" : fmt(hover.v, "V", 4)}
        </div>
      )}
      {cursors !== "off" && <CursorBox />}
      {stopped && <span className="stopped-flag badge alarm">Stopped</span>}
    </div>
  );
}

function stateNow(): ScreenState {
  const u = getUi();
  return { values: getLive().values, frame: latestFrame(), selected: u.channel, cursors: u.cursors, ca: u.ca, cb: u.cb, va: u.va, vb: u.vb, persistence: u.persistence, drag: null };
}

/** Cursor read-outs: ΔT, 1/ΔT, ΔV, and the selected trace at each time cursor. */
function CursorBox() {
  const u = useUi((x) => x);
  const [, tick] = useState(0);
  useEffect(() => {
    let last = 0;
    return onFrame(() => {
      if (Date.now() - last > 250) {
        last = Date.now();
        tick((x) => x + 1);
      }
    });
  }, []);
  const src = `CHANnel${u.channel}`;
  const fr = latestFrame();
  const dt = u.cb - u.ca;
  const rows: [string, string][] = [];
  if (u.cursors === "time" || u.cursors === "both") {
    rows.push(["A", fmt(u.ca, "s", 4)], ["B", fmt(u.cb, "s", 4)], ["ΔT", fmt(dt, "s", 4)], ["1/ΔT", dt ? fmt(1 / Math.abs(dt), "Hz", 4) : "—"]);
    rows.push([`CH${u.channel}@A`, fmt(sampleAt(fr, src, u.ca), "V", 4)], [`CH${u.channel}@B`, fmt(sampleAt(fr, src, u.cb), "V", 4)]);
  }
  if (u.cursors === "volt" || u.cursors === "both") rows.push(["VA", fmt(u.va, "V", 4)], ["VB", fmt(u.vb, "V", 4)], ["ΔV", fmt(u.vb - u.va, "V", 4)]);
  return (
    <div className="cursor-box" data-test="cursor-box">
      {rows.flatMap(([a, b]) => [<span key={`${a}l`}>{a}</span>, <span key={`${a}v`}>{b}</span>])}
    </div>
  );
}
