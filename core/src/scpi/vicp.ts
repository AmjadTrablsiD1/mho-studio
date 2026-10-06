// VICP, Teledyne LeCroy's "Versatile Instrument Control Protocol": GPIB
// messages carried over TCP port 1861. Every block has an 8-byte header
//
//   byte 0  operation bits: 0x80 DATA, 0x40 REMOTE, 0x20 LOCKOUT, 0x10 CLEAR,
//                           0x08 SRQ, 0x04 SERIALPOLL, 0x01 EOI (end of message)
//   byte 1  header version, 1
//   byte 2  sequence number 1..255 (0 from instruments older than June 2003)
//   byte 3  unused
//   bytes 4-7  length of the data that follows, big-endian
//
// A message is one or more blocks, the last with EOI. The instrument answers
// a query with the sequence number of that query, so an answer that arrives
// after we gave up on it can be recognised and dropped (VICP "version 1a").
// Layout from the open-source VICP clients (pyvicp, LeCroy's own VICP client
// library) and Wireshark's dissector.

import type { Reply } from "./block.ts";

export const VICP = { DATA: 0x80, REMOTE: 0x40, LOCKOUT: 0x20, CLEAR: 0x10, SRQ: 0x08, SERIALPOLL: 0x04, EOI: 0x01, VERSION: 1, HEADER: 8 } as const;

export type VicpHeader = { op: number; version: number; seq: number; length: number };

export function vicpHeader(op: number, seq: number, length: number): Uint8Array {
  const h = new Uint8Array(VICP.HEADER);
  h[0] = op;
  h[1] = VICP.VERSION;
  h[2] = seq & 0xff;
  new DataView(h.buffer).setUint32(4, length, false);
  return h;
}

export function parseVicpHeader(b: Uint8Array): VicpHeader {
  return { op: b[0], version: b[1], seq: b[2], length: new DataView(b.buffer, b.byteOffset, 8).getUint32(4, false) };
}

/** One whole message as the instrument expects it: DATA|EOI (|REMOTE), with this sequence number. */
export function vicpMessage(payload: Uint8Array, seq: number, remote = true): Uint8Array {
  const out = new Uint8Array(VICP.HEADER + payload.length);
  out.set(vicpHeader(VICP.DATA | VICP.EOI | (remote ? VICP.REMOTE : 0), seq, payload.length), 0);
  out.set(payload, VICP.HEADER);
  return out;
}

/** The next sequence number: 1..255, never 0 (0 means "this side does not number"). */
export function nextSeq(seq: number): number {
  return seq >= 255 ? 1 : seq + 1;
}

export type VicpMessage = { seq: number; data: Uint8Array; srq: boolean };

/**
 * Turns a byte stream into whole messages. Bytes arrive split anywhere; a
 * message may span several blocks; only the block with EOI ends it. A header
 * that is not a VICP header (version ≠ 1 or no DATA bit) is a framing error:
 * the stream is out of step and cannot be trusted any more.
 */
export class VicpFramer {
  private buf: Uint8Array[] = [];
  private have = 0;
  private parts: Uint8Array[] = [];
  private partBytes = 0;
  private head: VicpHeader | null = null;
  /** Bytes of the message being assembled, for progress bars. */
  get pending(): number {
    return this.partBytes + (this.head ? this.have : 0);
  }
  /** The length of the block being received, if its header has arrived. */
  get blockLength(): number | null {
    return this.head ? this.head.length : null;
  }

  push(chunk: Uint8Array): VicpMessage[] {
    if (chunk.length) {
      this.buf.push(chunk);
      this.have += chunk.length;
    }
    const out: VicpMessage[] = [];
    for (;;) {
      if (!this.head) {
        if (this.have < VICP.HEADER) break;
        const h = parseVicpHeader(this.take(VICP.HEADER));
        if (h.version !== VICP.VERSION || !(h.op & VICP.DATA)) throw new Error(`not a VICP header (op 0x${h.op.toString(16)}, version ${h.version})`);
        this.head = h;
      }
      if (this.have < this.head.length) break;
      const data = this.take(this.head.length);
      const h = this.head;
      this.head = null;
      if (h.op & VICP.SRQ) continue; // a service-request notice, not part of any reply
      this.parts.push(data);
      this.partBytes += data.length;
      if (h.op & VICP.EOI) {
        out.push({ seq: h.seq, data: concat(this.parts, this.partBytes), srq: false });
        this.parts = [];
        this.partBytes = 0;
      }
    }
    return out;
  }

  clear(): void {
    this.buf = [];
    this.have = 0;
    this.parts = [];
    this.partBytes = 0;
    this.head = null;
  }

  private take(n: number): Uint8Array {
    const out = new Uint8Array(n);
    let off = 0;
    while (off < n) {
      const c = this.buf[0];
      const k = Math.min(c.length, n - off);
      out.set(c.subarray(0, k), off);
      off += k;
      if (k === c.length) this.buf.shift();
      else this.buf[0] = c.subarray(k);
    }
    this.have -= n;
    return out;
  }
}

function concat(parts: Uint8Array[], total: number): Uint8Array {
  if (parts.length === 1) return parts[0];
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

const decoder = new TextDecoder("latin1");
const printable = (b: number) => b === 9 || b === 10 || b === 13 || (b >= 32 && b < 127);

/**
 * What a whole message is, now that EOI has told us where it ends:
 *  • text with an IEEE 488.2 block in it ("ALL,#9000000400<bytes>") → the block's bytes;
 *    the block must end the message (a closing newline aside);
 *  • plain text ("50E-3 V\n") → a line, without the trailing newline;
 *  • anything else (a screen dump is raw image bytes) → those bytes.
 * So a "#" inside ordinary text cannot fool it.
 */
export function replyOfMessage(m: Uint8Array): Reply {
  const scan = Math.min(m.length - 2, 64);
  for (let i = 0; i < scan; i++) {
    const b = m[i];
    if (b === 0x23 && m[i + 1] >= 0x31 && m[i + 1] <= 0x39) {
      const n = m[i + 1] - 0x30;
      let len = 0;
      let ok = i + 2 + n <= m.length;
      for (let k = 0; ok && k < n; k++) {
        const d = m[i + 2 + k];
        if (d < 0x30 || d > 0x39) ok = false;
        else len = len * 10 + (d - 0x30);
      }
      const start = i + 2 + n;
      const end = start + len;
      // After the block only a closing newline may follow.
      const tailOk = end <= m.length && m.length - end <= 2 && m.subarray(end).every((x) => x === 0x0a || x === 0x0d);
      if (ok && tailOk) return { kind: "block", data: m.subarray(start, end) };
      break;
    }
    if (!printable(b)) break;
  }
  let end = m.length;
  while (end > 0 && (m[end - 1] === 0x0a || m[end - 1] === 0x0d)) end--;
  for (let i = 0; i < end; i++) if (!printable(m[i])) return { kind: "block", data: m };
  return { kind: "line", text: decoder.decode(m.subarray(0, end)) };
}
