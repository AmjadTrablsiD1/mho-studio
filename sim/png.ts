// A minimal RGB PNG encoder and a tiny rasteriser, so the simulated scope can
// answer :DISPlay:DATA? with a real image of its own screen.

import { deflateSync } from "node:zlib";

const CRC = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

export class Raster {
  readonly w: number;
  readonly h: number;
  readonly px: Uint8Array;
  constructor(w: number, h: number, bg: [number, number, number]) {
    this.w = w;
    this.h = h;
    this.px = new Uint8Array(w * h * 3);
    for (let i = 0; i < w * h; i++) this.px.set(bg, i * 3);
  }
  set(x: number, y: number, c: [number, number, number], alpha = 1): void {
    x = Math.round(x);
    y = Math.round(y);
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    const i = (y * this.w + x) * 3;
    for (let k = 0; k < 3; k++) this.px[i + k] = Math.round(this.px[i + k] * (1 - alpha) + c[k] * alpha);
  }
  hline(y: number, x0: number, x1: number, c: [number, number, number], alpha = 1): void {
    for (let x = x0; x <= x1; x++) this.set(x, y, c, alpha);
  }
  vline(x: number, y0: number, y1: number, c: [number, number, number], alpha = 1): void {
    for (let y = y0; y <= y1; y++) this.set(x, y, c, alpha);
  }
  /** A vertical span per column joins consecutive samples, so steep edges stay solid. */
  trace(ys: number[], x0: number, width: number, c: [number, number, number]): void {
    const n = ys.length;
    let prev = ys[0];
    for (let i = 0; i < n; i++) {
      const x = x0 + (i / (n - 1)) * width;
      const y = ys[i];
      const lo = Math.min(prev, y);
      const hi = Math.max(prev, y);
      for (let yy = Math.floor(lo); yy <= Math.ceil(hi); yy++) this.set(x, yy, c);
      prev = y;
    }
  }
  png(): Uint8Array {
    const raw = new Uint8Array((this.w * 3 + 1) * this.h);
    for (let y = 0; y < this.h; y++) {
      raw[y * (this.w * 3 + 1)] = 0;
      raw.set(this.px.subarray(y * this.w * 3, (y + 1) * this.w * 3), y * (this.w * 3 + 1) + 1);
    }
    const ihdr = new Uint8Array(13);
    const dv = new DataView(ihdr.buffer);
    dv.setUint32(0, this.w);
    dv.setUint32(4, this.h);
    ihdr[8] = 8; // bit depth
    ihdr[9] = 2; // RGB
    const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    const parts = [sig, chunk("IHDR", ihdr), chunk("IDAT", new Uint8Array(deflateSync(raw))), chunk("IEND", new Uint8Array(0))];
    const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
    let o = 0;
    for (const p of parts) {
      out.set(p, o);
      o += p.length;
    }
    return out;
  }
}

export function hex(c: string): [number, number, number] {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(c);
  return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : [255, 255, 255];
}
