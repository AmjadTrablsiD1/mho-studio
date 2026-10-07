// A canvas XY plot: linear or log axes with 1-2-5 ticks, line series,
// min/max envelopes, vertical markers, hover read-out, drag-to-select and
// wheel zoom. Chrome scales with the container, not the screen.

import { useEffect, useRef, useState } from "react";
import { fmt } from "../../../core/src/format.ts";
import { onThemeChange, token } from "../theme.ts";

export type Axis = { min: number; max: number; log?: boolean; unit: string; label?: string };
export type Series = { x: ArrayLike<number>; y: ArrayLike<number>; y2?: ArrayLike<number>; color: string; width?: number; name?: string; dots?: boolean };
export type PlotMarker = { x: number; color: string; label: string };
export type PlotProps = {
  x: Axis;
  y: Axis;
  series: Series[];
  markers?: PlotMarker[];
  title?: string;
  onSelect?: (x0: number, x1: number) => void;
  onZoom?: (centre: number, factor: number) => void;
  hoverText?: (x: number) => string | null;
  testId?: string;
};

function niceTicks(min: number, max: number, target: number): number[] {
  const span = max - min;
  if (!(span > 0)) return [min];
  const raw = span / target;
  const e = 10 ** Math.floor(Math.log10(raw));
  const m = raw / e;
  const step = (m >= 5 ? 10 : m >= 2 ? 5 : m >= 1 ? 2 : 1) * e;
  const out: number[] = [];
  for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-9; v += step) out.push(Math.abs(v) < step * 1e-9 ? 0 : v);
  return out;
}

function logTicks(min: number, max: number): { major: number[]; minor: number[] } {
  const major: number[] = [];
  const minor: number[] = [];
  for (let e = Math.floor(Math.log10(min)); e <= Math.ceil(Math.log10(max)); e++) {
    for (const m of [1, 2, 3, 4, 5, 6, 7, 8, 9]) {
      const v = m * 10 ** e;
      if (v < min * 0.9999 || v > max * 1.0001) continue;
      (m === 1 ? major : minor).push(v);
    }
  }
  return { major, minor };
}

export function Plot(p: PlotProps) {
  const host = useRef<HTMLDivElement>(null);
  const cv = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0, dpr: 1 });
  const [theme, setTheme] = useState(0);
  const [hover, setHover] = useState<{ px: number; x: number } | null>(null);
  const [sel, setSel] = useState<{ a: number; b: number } | null>(null);

  useEffect(() => {
    const h = host.current!;
    const ro = new ResizeObserver(() => {
      const r = h.getBoundingClientRect();
      setSize({ w: r.width, h: r.height, dpr: Math.min(2, window.devicePixelRatio || 1) });
    });
    ro.observe(h);
    const off = onThemeChange(() => setTheme((t) => t + 1));
    return () => {
      ro.disconnect();
      off();
    };
  }, []);

  // Chrome scales with the container width (build-app visualise rule).
  const k = Math.max(0.8, Math.min(1.25, size.w / 900));
  const pad = { l: 58 * k, r: 16 * k, t: (p.title ? 28 : 12) * k, b: 30 * k };
  const pw = Math.max(1, size.w - pad.l - pad.r);
  const ph = Math.max(1, size.h - pad.t - pad.b);
  const xs = (v: number) => (p.x.log ? (Math.log10(v) - Math.log10(p.x.min)) / (Math.log10(p.x.max) - Math.log10(p.x.min)) : (v - p.x.min) / (p.x.max - p.x.min)) * pw + pad.l;
  const xinv = (px: number) => {
    const f = (px - pad.l) / pw;
    return p.x.log ? 10 ** (Math.log10(p.x.min) + f * (Math.log10(p.x.max) - Math.log10(p.x.min))) : p.x.min + f * (p.x.max - p.x.min);
  };
  const ys = (v: number) => pad.t + ph - (p.y.log ? (Math.log10(v) - Math.log10(p.y.min)) / (Math.log10(p.y.max) - Math.log10(p.y.min)) : (v - p.y.min) / (p.y.max - p.y.min)) * ph;

  useEffect(() => {
    const c = cv.current;
    if (!c || !size.w) return;
    c.width = Math.round(size.w * size.dpr);
    c.height = Math.round(size.h * size.dpr);
    const ctx = c.getContext("2d")!;
    ctx.setTransform(size.dpr, 0, 0, size.dpr, 0, 0);
    ctx.clearRect(0, 0, size.w, size.h);
    const grid = token("grid");
    const major = token("grid-major");
    const text = token("grid-text");
    ctx.font = `${10 * k}px "JetBrains Mono Variable", monospace`;
    ctx.lineWidth = 1;
    // x grid
    const xt = p.x.log ? logTicks(p.x.min, p.x.max) : { major: niceTicks(p.x.min, p.x.max, Math.max(3, Math.round(pw / (90 * k)))), minor: [] };
    ctx.strokeStyle = grid;
    ctx.beginPath();
    for (const v of xt.minor) {
      const x = Math.round(xs(v)) + 0.5;
      ctx.moveTo(x, pad.t);
      ctx.lineTo(x, pad.t + ph);
    }
    ctx.stroke();
    ctx.strokeStyle = major;
    ctx.fillStyle = text;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.beginPath();
    for (const v of xt.major) {
      const x = Math.round(xs(v)) + 0.5;
      ctx.moveTo(x, pad.t);
      ctx.lineTo(x, pad.t + ph);
      // keep the end labels inside the canvas
      const label = fmt(v, p.x.unit, 3);
      const half = ctx.measureText(label).width / 2;
      ctx.fillText(label, Math.min(size.w - half - 2, Math.max(half + 2, x)), pad.t + ph + 7 * k);
    }
    ctx.stroke();
    // y grid
    const yt = niceTicks(p.y.min, p.y.max, Math.max(3, Math.round(ph / (46 * k))));
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    ctx.beginPath();
    for (const v of yt) {
      const y = Math.round(ys(v)) + 0.5;
      ctx.moveTo(pad.l, y);
      ctx.lineTo(pad.l + pw, y);
      ctx.fillText(fmt(v, p.y.unit, 3), pad.l - 6 * k, y);
    }
    ctx.stroke();
    ctx.strokeRect(pad.l + 0.5, pad.t + 0.5, pw - 1, ph - 1);
    if (p.title) {
      ctx.fillStyle = token("muted");
      ctx.font = `500 ${9 * k}px "Inter Variable", sans-serif`;
      ctx.textAlign = "left";
      ctx.textBaseline = "top";
      ctx.fillText(p.title.toUpperCase(), pad.l, 9 * k);
    }
    // series
    ctx.save();
    ctx.beginPath();
    ctx.rect(pad.l, pad.t, pw, ph);
    ctx.clip();
    for (const s of p.series) {
      ctx.strokeStyle = s.color;
      ctx.fillStyle = s.color;
      ctx.lineWidth = (s.width ?? 1.4) * k;
      ctx.lineJoin = "round";
      ctx.beginPath();
      const n = Math.min(s.x.length, s.y.length);
      if (s.y2) {
        for (let i = 0; i < n; i++) {
          const x = Math.round(xs(s.x[i])) + 0.5;
          ctx.moveTo(x, ys(s.y2[i]));
          ctx.lineTo(x, ys(s.y[i]) + 0.75);
        }
      } else {
        let started = false;
        for (let i = 0; i < n; i++) {
          const xv = s.x[i];
          const yv = s.y[i];
          if (!Number.isFinite(yv) || (p.x.log && xv <= 0)) {
            started = false;
            continue;
          }
          const x = xs(xv);
          const y = ys(yv);
          if (!started) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
          started = true;
        }
      }
      if (s.width !== 0) ctx.stroke(); // width 0: dots only (a scatter)
      if (s.dots) for (let i = 0; i < n; i++) {
        if (!Number.isFinite(s.y[i])) continue;
        ctx.beginPath();
        ctx.arc(xs(s.x[i]), ys(s.y[i]), 2.4 * k, 0, 2 * Math.PI);
        ctx.fill();
      }
    }
    for (const m of p.markers ?? []) {
      const x = Math.round(xs(m.x)) + 0.5;
      ctx.strokeStyle = m.color;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(x, pad.t);
      ctx.lineTo(x, pad.t + ph);
      ctx.stroke();
      ctx.setLineDash([]);
      if (!m.label) continue;
      ctx.fillStyle = m.color;
      ctx.font = `600 ${10 * k}px "JetBrains Mono Variable", monospace`;
      ctx.textAlign = x > pad.l + pw - 120 ? "right" : "left";
      ctx.textBaseline = "top";
      ctx.fillText(m.label, x + (ctx.textAlign === "right" ? -5 : 5), pad.t + 6 * k);
    }
    if (sel) {
      ctx.fillStyle = token("blue");
      ctx.globalAlpha = 0.15;
      ctx.fillRect(Math.min(sel.a, sel.b), pad.t, Math.abs(sel.b - sel.a), ph);
      ctx.globalAlpha = 1;
    }
    ctx.restore();
  }, [p, size, theme, sel]);

  const inside = (px: number) => px >= pad.l && px <= pad.l + pw;
  const local = (e: React.PointerEvent | React.WheelEvent) => e.clientX - host.current!.getBoundingClientRect().left;
  const ht = hover && p.hoverText ? p.hoverText(hover.x) : null;
  return (
    <div
      ref={host}
      className="plot-host"
      data-test={p.testId}
      onPointerMove={(e) => {
        const px = local(e);
        if (sel) setSel({ ...sel, b: Math.max(pad.l, Math.min(pad.l + pw, px)) });
        setHover(inside(px) ? { px, x: xinv(px) } : null);
      }}
      onPointerLeave={() => setHover(null)}
      onPointerDown={(e) => {
        if (!p.onSelect) return;
        const px = local(e);
        if (!inside(px)) return;
        (e.target as Element).setPointerCapture(e.pointerId);
        setSel({ a: px, b: px });
      }}
      onPointerUp={() => {
        if (sel && Math.abs(sel.b - sel.a) > 6 && p.onSelect) {
          const a = xinv(Math.min(sel.a, sel.b));
          const b = xinv(Math.max(sel.a, sel.b));
          p.onSelect(a, b);
        }
        setSel(null);
      }}
      onWheel={(e) => {
        if (!p.onZoom) return;
        const px = local(e);
        if (inside(px)) p.onZoom(xinv(px), e.deltaY < 0 ? 0.8 : 1.25);
      }}
    >
      <canvas ref={cv} role="img" aria-label={p.title ?? "plot"} />
      {ht && hover && (
        <div className="hover-read" style={{ left: Math.min(hover.px + 10, size.w - 190), top: pad.t + 4 }}>
          {ht}
        </div>
      )}
    </div>
  );
}
