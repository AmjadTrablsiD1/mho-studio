// USB-TMC framing (USB Test & Measurement Class, rev 1.0, with the USB488
// subclass the MHO984 uses). SCPI travels in bulk transfers, each starting
// with a 12-byte header:
//
//   byte 0      MsgID: 1 DEV_DEP_MSG_OUT (host → scope, a command)
//                      2 REQUEST_DEV_DEP_MSG_IN (host asks for up to N bytes)
//                      2 DEV_DEP_MSG_IN (scope → host, on the bulk-IN pipe)
//   byte 1      bTag, 1..255, echoed by the device
//   byte 2      ~bTag
//   byte 3      0
//   bytes 4–7   TransferSize, little-endian (payload bytes, header excluded)
//   byte 8      bmTransferAttributes: bit 0 = EOM (end of message)
//   bytes 9–11  0 (OUT) / TermChar settings (REQUEST)
//
// then the payload, padded with zeros to a multiple of 4. A DEV_DEP_MSG_IN
// may be longer than one USB transfer: only the first carries the header.
// Nothing here touches USB; server/usbtmc.ts moves the bytes.

export const TMC = {
  interfaceClass: 0xfe,
  interfaceSubclass: 0x03,
  header: 12,
  devDepMsgOut: 1,
  requestDevDepMsgIn: 2,
  devDepMsgIn: 2,
  // class-specific control requests (bRequest), recipient interface
  initiateClear: 5,
  checkClearStatus: 6,
  getCapabilities: 7,
  statusSuccess: 0x01,
  statusPending: 0x02,
  rigolVendorId: 0x1ab1,
} as const;

/** The next bTag: 1..255, never 0. */
export const nextTag = (t: number) => (t % 255) + 1;

function header(msgId: number, tag: number, size: number, attr: number): Uint8Array {
  const h = new Uint8Array(TMC.header);
  h[0] = msgId;
  h[1] = tag;
  h[2] = ~tag & 0xff;
  h[3] = 0;
  new DataView(h.buffer).setUint32(4, size, true);
  h[8] = attr;
  return h;
}

/** A command (or part of one) for the bulk-OUT pipe. */
export function msgOut(tag: number, data: Uint8Array, eom = true): Uint8Array {
  const padded = TMC.header + data.length + ((4 - (data.length % 4)) % 4);
  const out = new Uint8Array(padded);
  out.set(header(TMC.devDepMsgOut, tag, data.length, eom ? 1 : 0), 0);
  out.set(data, TMC.header);
  return out;
}

/** Ask the device to send up to `maxSize` bytes of its reply. */
export function requestIn(tag: number, maxSize: number): Uint8Array {
  return header(TMC.requestDevDepMsgIn, tag, maxSize, 0);
}

export type InHeader = { msgId: number; tag: number; size: number; eom: boolean };

export function parseInHeader(b: Uint8Array): InHeader {
  if (b.length < TMC.header) throw new Error(`USB-TMC: a ${b.length}-byte transfer is shorter than the 12-byte header`);
  const tag = b[1];
  if ((b[2] ^ 0xff) !== tag) throw new Error(`USB-TMC: header tag ${tag} does not match its complement ${b[2]}`);
  if (b[0] !== TMC.devDepMsgIn) throw new Error(`USB-TMC: expected DEV_DEP_MSG_IN (2), got MsgID ${b[0]}`);
  return { msgId: b[0], tag, size: new DataView(b.buffer, b.byteOffset, b.length).getUint32(4, true), eom: (b[8] & 1) === 1 };
}

/** Parse a bulk-OUT message on the device side (used by the virtual device in tests). */
export function parseOut(b: Uint8Array): { msgId: number; tag: number; size: number; eom: boolean; data: Uint8Array } {
  if (b.length < TMC.header) throw new Error("short USB-TMC message");
  const size = new DataView(b.buffer, b.byteOffset, b.length).getUint32(4, true);
  return { msgId: b[0], tag: b[1], size, eom: (b[8] & 1) === 1, data: b.subarray(TMC.header, TMC.header + (b[0] === TMC.devDepMsgOut ? size : 0)) };
}

/** Device side: the first transfer of a reply chunk (header + as much payload as the caller sends in it). */
export function msgIn(tag: number, data: Uint8Array, eom: boolean): Uint8Array {
  const padded = TMC.header + data.length + ((4 - (data.length % 4)) % 4);
  const out = new Uint8Array(padded);
  out.set(header(TMC.devDepMsgIn, tag, data.length, eom ? 1 : 0), 0);
  out.set(data, TMC.header);
  return out;
}

/**
 * Does a program message expect a reply? Only its header part is looked at, so
 * a binary block argument that happens to contain '?' does not count.
 */
export function expectsReply(msg: Uint8Array): boolean {
  let text = new TextDecoder("latin1").decode(msg.subarray(0, Math.min(msg.length, 4096)));
  const block = /#[1-9]/.exec(text);
  if (block) text = text.slice(0, block.index); // what follows is binary data
  return text.split(";").some((unit) => (unit.trim().split(/\s/)[0] ?? "").includes("?"));
}

/**
 * Is `data` already a complete reply, whatever the EOM bit says? A line that
 * ends in "\n", or a #N block with all its bytes. Some instruments leave EOM
 * clear on the last transfer of a block; this lets the reader stop anyway
 * instead of asking for bytes that will never come.
 */
export function replyComplete(data: Uint8Array): boolean {
  if (!data.length) return false;
  if (data[0] === 0x23 && data.length >= 2 && data[1] >= 0x31 && data[1] <= 0x39) {
    const n = data[1] - 0x30;
    if (data.length < 2 + n) return false;
    let len = 0;
    for (let i = 0; i < n; i++) len = len * 10 + (data[2 + i] - 0x30);
    return data.length >= 2 + n + len;
  }
  return data[data.length - 1] === 0x0a;
}

/** Round a length up to whole USB packets (bulk-IN reads must be). */
export const wholePackets = (n: number, packet: number) => Math.ceil(n / packet) * packet;
