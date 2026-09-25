// The scope screen, drawn imperatively. React owns the chrome around it; this
// module owns two canvases: the traces (with optional persistence) and an
// overlay for graticule markers, cursors and drag handles. It reads the
// latest frame and the mirrored settings every animation frame and never goes
// through React state (E_GUI rule 5).

import { C } from "../../../core/src/constants.ts";
import { key } from "../../../core/src/registry/controls.ts";
import type { Value } from "../../../core/src/scpi/values.ts";
import type { Frame } from "../api.ts";
import { sourceColor, token } from "../theme.ts";

export const GUTTER = { left: 30, right: 28, top: 16, bottom: 4 };

export type Geometry = { gx: number; gy: number; gw: number; gh: number; w: number; h: number; dpr: number };

export type Marker = { kind: "ground"; ch: number; y: number } | { kind: "level"; y: number } | { kind: "tpos"; x: number } | { kind: "cursor"; which: "ca" | "cb" | "va" | "vb"; x?: number; y?: number };

export type ScreenState = {
  values: Record<string, Value>;
  frame: Frame | null;
  selected: number;
  cursors: "off" | "time" | "volt" | "both";
  ca: number;
  cb: number;
  va: number;
  vb: number;
  persistence: boolean;
  /** Marker being dragged, drawn at its provisional position. */
  drag: { marker: Marker; pos: number } | null;
};

const DIVX = C.instrument.divisions_x;
const DIVY = C.instrument.divisions_y;

export function geometry(w: number, h: number, dpr: number): Geometry {
  return { gx: GUTTER.left, gy: GUTTER.top, gw: w - GUTTER.left - GUTTER.right, gh: h - GUTTER.top - GUTTER.bottom, w, h, dpr };
}

const num = (v: Value | undefined, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);

/** Time ↔ x and volts ↔ y for the current settings. */
export function mapping(g: Geometry, values: Record<string, Value>) {
  const tb = num(values["timebase.scale"], 1e-3);
  const toff = num(values["timebase.offset"], 0);
  const left = toff - (DIVX / 2) * tb;
  const span = DIVX * tb;
  return {
    tb,
    toff,
    left,
    x: (t: number) => g.gx + ((t - left) / span) * g.gw,
    t: (x: number) => left + ((x - g.gx) / g.gw) * span,
    y: (ch: number, v: number, math = false) => {
      const s = num(values[key(math ? "math.scale" : "channel.scale", ch)], 1);
      const o = num(values[key(math ? "math.offset" : "channel.offset", ch)], 0);
      return g.gy + g.gh / 2 - ((v + o) / s) * (g.gh / DIVY);
    },
    v: (ch: number, y: number) => {
      const s = num(values[key("channel.scale", ch)], 1);
      const o = num(values[key("channel.offset", ch)], 0);
      return ((g.gy + g.gh / 2 - y) / (g.gh / DIVY)) * s - o;
    },
    /** Offset that puts 0 V at y. */
    offsetAt: (ch: number, y: number) => ((g.gy + g.gh / 2 - y) / (g.gh / DIVY)) * num(values[key("channel.scale", ch)], 1),
  };
}

export function triggerChannel(values: Record<string, Value>): number | null {
  const m = /(\d)$/.exec(String(values["trigger.edge.source"] ?? ""));
  return m && /^CHAN/i.test(String(values["trigger.edge.source"])) ? Number(m[1]) : null;
}

function drawGrid(ctx: CanvasRenderingContext2D, g: Geometry): void {
  const grid = token("grid");
  const major = token("grid-major");
  ctx.save();
  ctx.lineWidth = 1;
  ctx.strokeStyle = grid;
  ctx.setLineDash([1, 3]);
  ctx.beginPath();
  for (let i = 1; i < DIVX; i++) {
    const x = Math.round(g.gx + (i * g.gw) / DIVX) + 0.5;
    ctx.moveTo(x, g.gy);
    ctx.lineTo(x, g.gy + g.gh);
  }
  for (let j = 1; j < DIVY; j++) {
    const y = Math.round(g.gy + (j * g.gh) / DIVY) + 0.5;
    ctx.moveTo(g.gx, y);
    ctx.lineTo(g.gx + g.gw, y);
  }
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.strokeStyle = major;
  ctx.strokeRect(g.gx + 0.5, g.gy + 0.5, g.gw - 1, g.gh - 1);
  // centre axes with minor ticks, five per division
  const cx = Math.round(g.gx + g.gw / 2) + 0.5;
  const cy = Math.round(g.gy + g.gh / 2) + 0.5;
  ctx.beginPath();
  ctx.moveTo(cx, g.gy);
  ctx.lineTo(cx, g.gy + g.gh);
  ctx.moveTo(g.gx, cy);
  ctx.lineTo(g.gx + g.gw, cy);
  for (let i = 0; i <= DIVX * 5; i++) {
    const x = Math.round(g.gx + (i * g.gw) / (DIVX * 5)) + 0.5;
    const l = i % 5 === 0 ? 5 : 3;
    ctx.moveTo(x, cy - l);
    ctx.lineTo(x, cy + l);
  }
  for (let j = 0; j <= DIVY * 5; j++) {
    const y = Math.round(g.gy + (j * g.gh) / (DIVY * 5)) + 0.5;
    const l = j % 5 === 0 ? 5 : 3;
    ctx.moveTo(cx - l, y);
    ctx.lineTo(cx + l, y);
  }
  ctx.stroke();
  ctx.restore();
}

export function drawTraces(ctx: CanvasRenderingContext2D, g: Geometry, s: ScreenState): void {
  if (!s.frame) return;
  const m = mapping(g, s.values);
  ctx.save();
  ctx.beginPath();
  ctx.rect(g.gx, g.gy, g.gw, g.gh);
  ctx.clip();
  ctx.lineJoin = "round";
  for (const tr of s.frame.traces) {
    const math = /^MATH/i.test(tr.src);
    const ch = Number(/(\d)$/.exec(tr.src)?.[1] ?? 1);
    ctx.strokeStyle = sourceColor(tr.src);
    ctx.lineWidth = ch === s.selected && !math ? 1.6 : 1.25;
    ctx.globalAlpha = 0.95;
    ctx.beginPath();
    const v = tr.volts;
    const n = v.length;
    // More points than pixels: draw a min/max column per pixel so nothing is lost.
    if (n > g.gw * 1.5) {
      const cols = Math.ceil(g.gw);
      for (let c = 0; c < cols; c++) {
        const i0 = Math.floor((c * n) / cols);
        const i1 = Math.max(i0 + 1, Math.floor(((c + 1) * n) / cols));
        let lo = Infinity;
        let hi = -Infinity;
        for (let i = i0; i < i1; i++) {
          if (v[i] < lo) lo = v[i];
          if (v[i] > hi) hi = v[i];
        }
        // one continuous zig-zag: consecutive columns stay joined, steep edges stay solid
        const x = m.x(tr.xorigin + i0 * tr.xinc);
        if (c === 0) ctx.moveTo(x, m.y(ch, hi, math));
        else ctx.lineTo(x, m.y(ch, hi, math));
        ctx.lineTo(x, m.y(ch, lo, math) + 0.5);
      }
    } else {
      for (let i = 0; i < n; i++) {
        const x = m.x(tr.xorigin + i * tr.xinc);
        const y = m.y(ch, v[i], math);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
    }
    ctx.stroke();
  }
  ctx.restore();
}

function tag(ctx: CanvasRenderingContext2D, x: number, y: number, dir: "right" | "left" | "down", color: string, text: string, fg: string): void {
  ctx.save();
  ctx.fillStyle = color;
  ctx.beginPath();
  if (dir === "right") {
    ctx.moveTo(x - 22, y - 8);
    ctx.lineTo(x - 7, y - 8);
    ctx.lineTo(x, y);
    ctx.lineTo(x - 7, y + 8);
    ctx.lineTo(x - 22, y + 8);
  } else if (dir === "left") {
    ctx.moveTo(x + 22, y - 8);
    ctx.lineTo(x + 7, y - 8);
    ctx.lineTo(x, y);
    ctx.lineTo(x + 7, y + 8);
    ctx.lineTo(x + 22, y + 8);
  } else {
    ctx.moveTo(x - 8, y - 14);
    ctx.lineTo(x + 8, y - 14);
    ctx.lineTo(x + 8, y - 5);
    ctx.lineTo(x, y);
    ctx.lineTo(x - 8, y - 5);
  }
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = fg;
  ctx.font = `600 10px "JetBrains Mono Variable", monospace`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  if (dir === "right") ctx.fillText(text, x - 13, y + 0.5);
  else if (dir === "left") ctx.fillText(text, x + 13, y + 0.5);
  else ctx.fillText(text, x, y - 9);
  ctx.restore();
}

/** Where each draggable marker is, in CSS pixels (for hit testing and drawing). */
export function markers(g: Geometry, s: ScreenState): Marker[] {
  const m = mapping(g, s.values);
  const out: Marker[] = [];
  for (let ch = 1; ch <= C.instrument.analog_channels; ch++) {
    if (s.values[key("channel.display", ch)] !== true) continue;
    out.push({ kind: "ground", ch, y: clampY(g, m.y(ch, 0)) });
  }
  const tch = triggerChannel(s.values);
  if (tch && String(s.values["trigger.mode"] ?? "EDGE").toUpperCase().startsWith("EDGE")) out.push({ kind: "level", y: clampY(g, m.y(tch, num(s.values["trigger.edge.level"], 0))) });
  out.push({ kind: "tpos", x: Math.min(g.gx + g.gw, Math.max(g.gx, m.x(0))) });
  if (s.cursors === "time" || s.cursors === "both") {
    out.push({ kind: "cursor", which: "ca", x: m.x(s.ca) });
    out.push({ kind: "cursor", which: "cb", x: m.x(s.cb) });
  }
  if (s.cursors === "volt" || s.cursors === "both") {
    out.push({ kind: "cursor", which: "va", y: m.y(s.selected, s.va) });
    out.push({ kind: "cursor", which: "vb", y: m.y(s.selected, s.vb) });
  }
  return out;
}

const clampY = (g: Geometry, y: number) => Math.min(g.gy + g.gh, Math.max(g.gy, y));

export function drawOverlay(ctx: CanvasRenderingContext2D, g: Geometry, s: ScreenState): void {
  drawGrid(ctx, g);
  const fg = token("screen");
  const ms = markers(g, s);
  for (const mk of ms) {
    const dragging = s.drag && sameMarker(s.drag.marker, mk);
    if (mk.kind === "ground") {
      const y = dragging ? s.drag!.pos : mk.y;
      tag(ctx, g.gx, y, "right", token(`ch${mk.ch}`), String(mk.ch), fg);
    } else if (mk.kind === "level") {
      const y = dragging ? s.drag!.pos : mk.y;
      const tch = triggerChannel(s.values)!;
      tag(ctx, g.gx + g.gw, y, "left", token(`ch${tch}`), "T", fg);
      if (dragging) {
        ctx.save();
        ctx.strokeStyle = token(`ch${tch}`);
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(g.gx, y + 0.5);
        ctx.lineTo(g.gx + g.gw, y + 0.5);
        ctx.stroke();
        ctx.restore();
      }
    } else if (mk.kind === "tpos") {
      const x = dragging ? s.drag!.pos : mk.x;
      tag(ctx, x, g.gy, "down", token("trigger"), "T", fg);
    } else {
      const col = token(mk.which === "ca" || mk.which === "va" ? "cursor-a" : "cursor-b");
      ctx.save();
      ctx.strokeStyle = col;
      ctx.setLineDash([6, 4]);
      ctx.lineWidth = 1;
      ctx.beginPath();
      if (mk.x !== undefined) {
        const x = Math.round(dragging ? s.drag!.pos : mk.x) + 0.5;
        ctx.moveTo(x, g.gy);
        ctx.lineTo(x, g.gy + g.gh);
      } else {
        const y = Math.round(dragging ? s.drag!.pos : mk.y!) + 0.5;
        ctx.moveTo(g.gx, y);
        ctx.lineTo(g.gx + g.gw, y);
      }
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = col;
      ctx.font = `600 10px "JetBrains Mono Variable", monospace`;
      const label = mk.which.toUpperCase().replace("C", "").replace("V", "");
      if (mk.x !== undefined) ctx.fillText(label, (dragging ? s.drag!.pos : mk.x) + 4, g.gy + g.gh - 6);
      else ctx.fillText(label, g.gx + 6, (dragging ? s.drag!.pos : mk.y!) - 4);
      ctx.restore();
    }
  }
}

export function sameMarker(a: Marker, b: Marker): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "ground" && b.kind === "ground") return a.ch === b.ch;
  if (a.kind === "cursor" && b.kind === "cursor") return a.which === b.which;
  return true;
}

/** The marker under the pointer, if any (generous targets: 9 px). */
export function hit(g: Geometry, s: ScreenState, x: number, y: number): Marker | null {
  const ms = markers(g, s);
  for (const mk of ms) {
    if (mk.kind === "ground" && x <= g.gx + 2 && Math.abs(y - mk.y) <= 9) return mk;
    if (mk.kind === "level" && x >= g.gx + g.gw - 2 && Math.abs(y - mk.y) <= 9) return mk;
    if (mk.kind === "tpos" && y <= g.gy + 2 && Math.abs(x - mk.x) <= 9) return mk;
  }
  for (const mk of ms) {
    if (mk.kind !== "cursor") continue;
    if (mk.x !== undefined && Math.abs(x - mk.x) <= 6 && y > g.gy) return mk;
    if (mk.y !== undefined && Math.abs(y - mk.y) <= 6 && x > g.gx) return mk;
  }
  return null;
}

/** Linear interpolation of a trace at time t. */
export function sampleAt(fr: Frame | null, src: string, t: number): number | null {
  const tr = fr?.traces.find((x) => x.src === src);
  if (!tr) return null;
  const f = (t - tr.xorigin) / tr.xinc;
  const i = Math.floor(f);
  if (i < 0 || i >= tr.volts.length - 1) return null;
  return tr.volts[i] + (tr.volts[i + 1] - tr.volts[i]) * (f - i);
}
