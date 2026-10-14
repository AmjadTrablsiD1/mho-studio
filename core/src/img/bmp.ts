// Windows BMP images: what a Siglent-made scope sends for a screenshot (SCDP).
// The T3DSO1204 sends 800×480, 16 bits per pixel, BI_BITFIELDS with masks
// F800 / 07E0 / 001F (RGB565), stored top-down (negative height). The reader
// also takes 24- and 32-bit and bottom-up images; the app turns them into PNG.

export type Rgb = { w: number; h: number; rgb: Uint8Array };

/** Length of a BMP from its own header (bytes 2–5), or null when `b` does not start with "BM" and a full size field. */
export function bmpLength(b: Uint8Array): number | null {
  if (b.length < 6 || b[0] !== 0x42 || b[1] !== 0x4d) return null;
  return (b[2] | (b[3] << 8) | (b[4] << 16) | (b[5] << 24)) >>> 0;
}

/** Shift and width of a contiguous bit mask, for scaling a channel to 8 bits. */
function maskInfo(m: number): { shift: number; bits: number } {
  if (!m) return { shift: 0, bits: 0 };
  let shift = 0;
  while (!((m >>> shift) & 1)) shift++;
  let bits = 0;
  while ((m >>> (shift + bits)) & 1) bits++;
  return { shift, bits };
}

export function decodeBmp(b: Uint8Array): Rgb {
  if (bmpLength(b) === null) throw new Error("not a BMP image");
  const dv = new DataView(b.buffer, b.byteOffset, b.length);
  const off = dv.getUint32(10, true);
  const hdr = dv.getUint32(14, true);
  const w = dv.getInt32(18, true);
  const hs = dv.getInt32(22, true);
  const bpp = dv.getUint16(28, true);
  const comp = dv.getUint32(30, true);
  const h = Math.abs(hs);
  const topDown = hs < 0;
  if (!(w > 0 && h > 0) || ![16, 24, 32].includes(bpp)) throw new Error(`BMP of ${bpp} bits per pixel is not supported`);
  // Masks: after a 40-byte header for BI_BITFIELDS (3), or inside a longer header; defaults otherwise.
  let masks = bpp === 16 ? [0x7c00, 0x03e0, 0x001f] : [0xff0000, 0x00ff00, 0x0000ff];
  if (comp === 3) masks = [0, 1, 2].map((k) => dv.getUint32(14 + (hdr >= 52 ? 40 : hdr) + 4 * k, true));
  const ch = masks.map(maskInfo);
  const stride = Math.ceil((w * bpp) / 32) * 4;
  const rgb = new Uint8Array(w * h * 3);
  for (let y = 0; y < h; y++) {
    const row = off + (topDown ? y : h - 1 - y) * stride;
    for (let x = 0; x < w; x++) {
      const p = row + (x * bpp) / 8;
      if (p + bpp / 8 > b.length) continue;
      const v = bpp === 16 ? dv.getUint16(p, true) : bpp === 24 ? b[p] | (b[p + 1] << 8) | (b[p + 2] << 16) : dv.getUint32(p, true);
      for (let k = 0; k < 3; k++) {
        const { shift, bits } = ch[k];
        const raw = bits ? ((v & masks[k]) >>> shift) : 0;
        rgb[(y * w + x) * 3 + k] = bits ? Math.round((raw * 255) / ((1 << bits) - 1)) : 0;
      }
    }
  }
  return { w, h, rgb };
}

/** A top-down RGB565 BMP, the way the T3DSO1204 sends one (the simulator uses it; tests check the round trip). */
export function encodeBmp565(img: Rgb): Uint8Array {
  const { w, h, rgb } = img;
  const stride = Math.ceil((w * 16) / 32) * 4;
  const off = 66;
  const out = new Uint8Array(off + stride * h);
  const dv = new DataView(out.buffer);
  out[0] = 0x42;
  out[1] = 0x4d;
  dv.setUint32(2, out.length, true);
  dv.setUint32(10, off, true);
  dv.setUint32(14, 40, true);
  dv.setInt32(18, w, true);
  dv.setInt32(22, -h, true);
  dv.setUint16(26, 1, true);
  dv.setUint16(28, 16, true);
  dv.setUint32(30, 3, true);
  dv.setUint32(34, stride * h, true);
  dv.setUint32(54, 0xf800, true);
  dv.setUint32(58, 0x07e0, true);
  dv.setUint32(62, 0x001f, true);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3;
      const v = ((rgb[i] >> 3) << 11) | ((rgb[i + 1] >> 2) << 5) | (rgb[i + 2] >> 3);
      dv.setUint16(off + y * stride + 2 * x, v, true);
    }
  }
  return out;
}
