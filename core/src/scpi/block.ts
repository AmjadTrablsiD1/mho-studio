// Framing of what comes back from the instrument over a byte stream.
//
// A reply is either a line ending in "\n", or an IEEE 488.2 definite-length
// block: "#" + one digit N + N digits of length + that many bytes (+ "\n").
// Waveforms, screenshots, setup files and bus tables all arrive as blocks and
// may contain "\n" bytes, so a block must be framed by its length, never by
// a newline. Chunks arrive split anywhere; this reader does not care where.

export type Reply = { kind: "line"; text: string } | { kind: "block"; data: Uint8Array };

const HASH = 0x23;
const NL = 0x0a;
const CR = 0x0d;
const decoder = new TextDecoder("latin1");

export class ReplyReader {
  private chunks: Uint8Array[] = [];
  private length = 0;
  /** Set when the start of a block has been seen: how many bytes the whole reply needs. */
  private need = 0;
  /** A block's trailing newline had not arrived when the block was handed out. */
  private owesTerminator = false;

  push(chunk: Uint8Array): void {
    if (!chunk.length) return;
    this.chunks.push(chunk);
    this.length += chunk.length;
  }

  get buffered(): number {
    return this.length;
  }

  /** Bytes of the block currently arriving, and how many it will have, for progress bars. */
  progress(): { have: number; need: number } | null {
    return this.need ? { have: this.length, need: this.need } : null;
  }

  private byte(i: number): number {
    for (const c of this.chunks) {
      if (i < c.length) return c[i];
      i -= c.length;
    }
    return -1;
  }

  private take(n: number): Uint8Array {
    const out = new Uint8Array(n);
    let off = 0;
    while (off < n) {
      const c = this.chunks[0];
      const k = Math.min(c.length, n - off);
      out.set(c.subarray(0, k), off);
      off += k;
      if (k === c.length) this.chunks.shift();
      else this.chunks[0] = c.subarray(k);
    }
    this.length -= n;
    return out;
  }

  private indexOf(b: number, from = 0): number {
    let base = 0;
    for (const c of this.chunks) {
      const start = Math.max(0, from - base);
      if (start < c.length) {
        const i = c.indexOf(b, start);
        if (i >= 0) return base + i;
      }
      base += c.length;
    }
    return -1;
  }

  /** The next complete reply, or null if more bytes are needed. */
  next(): Reply | null {
    if (this.owesTerminator && this.length) this.dropTerminator();
    if (!this.length) return null;
    if (this.byte(0) === HASH) {
      const d = this.byte(1);
      if (d < 0) return null;
      if (d >= 0x31 && d <= 0x39) {
        const n = d - 0x30;
        if (this.length < 2 + n) return null;
        let len = 0;
        for (let i = 0; i < n; i++) {
          const c = this.byte(2 + i);
          if (c < 0x30 || c > 0x39) return this.line();
          len = len * 10 + (c - 0x30);
        }
        const total = 2 + n + len;
        this.need = total;
        if (this.length < total) return null;
        this.take(2 + n);
        const data = this.take(len);
        this.need = 0;
        this.dropTerminator();
        return { kind: "block", data };
      }
      if (d === 0x30) {
        // "#0": indefinite length, ends at the newline.
        const r = this.line();
        if (!r || r.kind !== "line") return r;
        return { kind: "block", data: new TextEncoder().encode(r.text.slice(2)) };
      }
    }
    return this.line();
  }

  private line(): Reply | null {
    const i = this.indexOf(NL);
    if (i < 0) return null;
    const raw = this.take(i + 1);
    let end = raw.length - 1;
    if (end > 0 && raw[end - 1] === CR) end--;
    return { kind: "line", text: decoder.decode(raw.subarray(0, end)) };
  }

  /** The "\n" (or "\r\n") that follows a block, if it has arrived. */
  private dropTerminator(): void {
    this.owesTerminator = false;
    if (this.byte(0) === CR && this.byte(1) === NL) this.take(2);
    else if (this.byte(0) === NL) this.take(1);
    else if (this.byte(0) === CR && this.length === 1) this.owesTerminator = true;
    else if (this.length === 0) this.owesTerminator = true;
  }

  clear(): void {
    this.chunks = [];
    this.length = 0;
    this.need = 0;
    this.owesTerminator = false;
  }
}

/** Wrap bytes as a definite-length block the way the instrument sends one. */
export function makeBlock(data: Uint8Array, digits = 9): Uint8Array {
  const len = String(data.length).padStart(digits, "0");
  const head = new TextEncoder().encode(`#${digits}${len}`);
  const out = new Uint8Array(head.length + data.length + 1);
  out.set(head, 0);
  out.set(data, head.length);
  out[out.length - 1] = NL;
  return out;
}

/** Parse the block argument of a command we receive (":SYSTem:SETup #9000000012..."). */
export function parseBlockArg(arg: string): Uint8Array | null {
  const m = /^#([1-9])/.exec(arg);
  if (!m) return null;
  const n = Number(m[1]);
  const len = Number(arg.slice(2, 2 + n));
  const body = arg.slice(2 + n, 2 + n + len);
  return Uint8Array.from(body, (c) => c.charCodeAt(0) & 0xff);
}
