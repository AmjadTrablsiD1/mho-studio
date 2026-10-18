// Find oscilloscopes on the local network. Candidates come from three places:
//  • every /24 this machine has an ordinary address on (a connect scan);
//  • mDNS: LXI instruments, the MHO984 among them, answer a query for
//    _lxi._tcp / _scpi-raw._tcp — this also finds a scope on a direct cable
//    with self-assigned 169.254.x.x addresses, where a scan is hopeless (/16);
//  • the ARP table: hosts this computer has recently exchanged packets with.
// Each candidate is probed on the SCPI port; whatever answers *IDN? is listed.
// On port 1861 the question goes in a VICP frame, the way a LeCroy expects it.

import net from "node:net";
import dgram from "node:dgram";
import { execFile } from "node:child_process";
import { networkInterfaces } from "node:os";
import { C } from "../core/src/constants.ts";
import { parseIdn } from "../core/src/scpi/values.ts";
import { lecroyIdn } from "../core/src/scpi/lecroy.ts";
import { replyOfMessage, vicpMessage, VicpFramer } from "../core/src/scpi/vicp.ts";
import { protocolForPort, type Protocol } from "../core/src/registry/families.ts";

export type Found = { host: string; port: number; idn: string; model: string; serial: string; ms: number; via: string };

export function probe(host: string, port: number, timeoutMs: number, protocol: Protocol = "raw"): Promise<Found | null> {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const s = net.connect({ host, port });
    let buf = "";
    const framer = new VicpFramer();
    const done = (v: Found | null) => {
      clearTimeout(timer);
      s.destroy();
      resolve(v);
    };
    const timer = setTimeout(() => done(null), timeoutMs);
    s.once("error", () => done(null));
    s.once("connect", () => {
      clearTimeout(timer);
      setTimeout(() => done(null), 1500);
      s.write(protocol === "vicp" ? vicpMessage(new TextEncoder().encode("*IDN?"), 1) : "*IDN?\n");
    });
    s.on("data", (d) => {
      if (protocol === "vicp") {
        let m;
        try {
          m = framer.push(new Uint8Array(d.buffer, d.byteOffset, d.length))[0];
        } catch {
          return done(null);
        }
        if (!m) return;
        const r = replyOfMessage(m.data);
        const id = lecroyIdn(r.kind === "line" ? r.text : "");
        return done(id.vendor ? { host, port, idn: id.raw, model: id.model, serial: id.serial, ms: Date.now() - t0, via: "" } : null);
      }
      buf += d.toString("latin1");
      if (buf.includes("\n")) {
        const id = parseIdn(buf.split("\n")[0]);
        done({ host, port, idn: id.raw, model: id.model, serial: id.serial, ms: Date.now() - t0, via: "" });
      }
    });
  });
}

export function subnets(): { iface: string; address: string; base: string }[] {
  const out: { iface: string; address: string; base: string }[] = [];
  for (const [name, addrs] of Object.entries(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family !== "IPv4" || a.internal) continue;
      if (a.address.startsWith("169.254.")) continue;
      out.push({ iface: name, address: a.address, base: a.address.split(".").slice(0, 3).join(".") });
    }
  }
  return out;
}

type Ifaces = ReturnType<typeof networkInterfaces>;
const ipInt = (ip: string) => ip.split(".").reduce((n, b) => (n * 256 + Number(b)) >>> 0, 0);

/**
 * Why a LAN address cannot be reached, when the cause is on this computer: it has no address
 * in the scope's network. The usual case is a direct cable — no router hands out addresses, so
 * the adapter gives itself a 169.254.x.x one while the scope keeps its own static address
 * (seen 2026-10-14 and 2026-10-17). Null when an interface already shares the network.
 */
export function networkHint(host: string, ifaces: Ifaces = networkInterfaces()): string | null {
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return null;
  const ip = ipInt(host);
  const selfAssigned: string[] = [];
  let linkLocalPeers = 0;
  for (const [name, list] of Object.entries(ifaces)) {
    for (const a of list ?? []) {
      if (a.family !== "IPv4" || a.internal) continue;
      const same = ((ipInt(a.address) ^ ip) & ipInt(a.netmask)) === 0;
      if (a.address.startsWith("169.254.")) {
        selfAssigned.push(`${name} (${a.address})`);
        if (same) linkLocalPeers++;
        continue;
      }
      if (same) return null;
    }
  }
  const manual = (base: string) =>
    `give the cable adapter a fixed address in the scope's network — macOS: System Settings → Network → the Ethernet / USB-C LAN adapter → Details → TCP/IP → Configure IPv4: Manually, IP address ${base}, subnet mask 255.255.255.0, router empty; Windows: Settings → Network → Ethernet → IP assignment → Edit → Manual.`;
  const parts = host.split(".").map(Number);
  if (host.startsWith("169.254.")) {
    if (!linkLocalPeers) return `${host} is a self-assigned address, but no adapter of this computer has one: ${manual("169.254.10.1 (mask 255.255.0.0)")}`;
    // Both sides self-assigned: it can work, but macOS sends 169.254 traffic out of the main service (often Wi-Fi).
    return `Both ends have self-assigned addresses, which macOS may route out of Wi-Fi instead of the cable. Switch Wi-Fi off and try again, or set fixed addresses on both: on the scope 192.168.10.2 / 255.255.255.0, and ${manual("192.168.10.1")}`;
  }
  const mine = `${parts[0]}.${parts[1]}.${parts[2]}.${parts[3] === 10 ? 11 : 10}`;
  return `This computer has no address in ${parts.slice(0, 3).join(".")}.x, so it cannot reach ${host}.${selfAssigned.length ? ` Its adapter ${selfAssigned.join(", ")} gave itself a 169.254 address: nothing on that cable hands out addresses (a direct cable has no router).` : ""} Fix: ${manual(mine)} Then connect to ${host} again.`;
}

// ------------------------------------------------------------------ mDNS

/** A DNS query (id 0, no flags) with one PTR question per service name. */
export function mdnsQuery(names: string[]): Uint8Array {
  const parts: number[] = [0, 0, 0, 0, 0, names.length, 0, 0, 0, 0, 0, 0];
  for (const n of names) {
    for (const label of n.split(".").filter(Boolean)) {
      parts.push(label.length, ...Array.from(label, (c) => c.charCodeAt(0)));
    }
    parts.push(0, 0, 12, 0, 1); // end of name, QTYPE PTR, QCLASS IN
  }
  return Uint8Array.from(parts);
}

/** IPv4 addresses in the A records of a DNS message (answers and additionals). */
export function aRecords(msg: Uint8Array): string[] {
  const dv = new DataView(msg.buffer, msg.byteOffset, msg.length);
  if (msg.length < 12) return [];
  const qd = dv.getUint16(4);
  const rr = dv.getUint16(6) + dv.getUint16(8) + dv.getUint16(10);
  let o = 12;
  const skipName = () => {
    while (o < msg.length) {
      const l = msg[o];
      if (l === 0) return void o++;
      if ((l & 0xc0) === 0xc0) return void (o += 2);
      o += l + 1;
    }
  };
  for (let i = 0; i < qd; i++) {
    skipName();
    o += 4;
  }
  const out: string[] = [];
  for (let i = 0; i < rr && o + 10 <= msg.length; i++) {
    skipName();
    if (o + 10 > msg.length) break;
    const type = dv.getUint16(o);
    const len = dv.getUint16(o + 8);
    o += 10;
    if (type === 1 && len === 4 && o + 4 <= msg.length) out.push(`${msg[o]}.${msg[o + 1]}.${msg[o + 2]}.${msg[o + 3]}`);
    o += len;
  }
  return out;
}

function mdns(waitMs = 1500): Promise<string[]> {
  return new Promise((resolve) => {
    const found = new Set<string>();
    let sock: dgram.Socket;
    try {
      sock = dgram.createSocket({ type: "udp4", reuseAddr: true });
    } catch {
      return resolve([]);
    }
    const finish = () => {
      try {
        sock.close();
      } catch {
        /* closed */
      }
      resolve([...found]);
    };
    sock.on("error", finish);
    sock.on("message", (m, rinfo) => {
      // Anyone answering an LXI/SCPI service query is a candidate; its A records name it too.
      found.add(rinfo.address);
      for (const a of aRecords(new Uint8Array(m))) found.add(a);
    });
    // An ephemeral source port makes this a "legacy unicast" query: responders answer us directly (RFC 6762 §6.7).
    sock.bind(0, () => {
      const q = mdnsQuery(["_lxi._tcp.local", "_scpi-raw._tcp.local", "_vxi-11._tcp.local"]);
      for (const n of Object.values(networkInterfaces()).flat()) {
        if (!n || n.family !== "IPv4" || n.internal) continue;
        try {
          sock.setMulticastInterface(n.address);
          sock.send(q, 5353, "224.0.0.251");
        } catch {
          /* interface without multicast */
        }
      }
      setTimeout(finish, waitMs);
    });
  });
}

// ------------------------------------------------------------------- ARP

/** "? (169.254.12.3) at 0:19:af:1:2:3 on en7 [ethernet]" (macOS/Linux) or "  169.254.12.3   00-19-af-..." (Windows). */
export function parseArp(text: string): string[] {
  const out = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    if (/incomplete|ff:ff:ff:ff:ff:ff|ff-ff-ff-ff-ff-ff/i.test(line)) continue;
    const m = /(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})/.exec(line);
    if (!m) continue;
    const ip = m[1];
    const first = Number(ip.split(".")[0]);
    if (first >= 224 || ip.endsWith(".255") || first === 127) continue;
    out.add(ip);
  }
  return [...out];
}

function arpTable(): Promise<string[]> {
  return new Promise((resolve) => {
    execFile(process.platform === "win32" ? "arp" : "/usr/sbin/arp", process.platform === "win32" ? ["-a"] : ["-an"], { timeout: 3000, windowsHide: true }, (err, stdout) => resolve(err ? [] : parseArp(stdout)));
  });
}

export async function discover(port: number = C.instrument.scpi_port, protocol: Protocol = protocolForPort(port), timeoutMs = 350, concurrency = 96): Promise<{ found: Found[]; scanned: string[] }> {
  const nets = subnets();
  const via = new Map<string, string>();
  for (const n of nets) for (let i = 1; i < 255; i++) {
    const h = `${n.base}.${i}`;
    if (h !== n.address) via.set(h, "scan");
  }
  const [fromMdns, fromArp] = await Promise.all([mdns(), arpTable()]);
  const own = new Set(Object.values(networkInterfaces()).flat().map((n) => n?.address));
  for (const h of fromArp) if (!own.has(h) && !via.has(h)) via.set(h, "arp");
  for (const h of fromMdns) if (!own.has(h)) via.set(h, "mdns");
  const hosts = [...via.keys()];
  const found: Found[] = [];
  let next = 0;
  const worker = async () => {
    while (next < hosts.length) {
      const h = hosts[next++];
      const r = await probe(h, port, timeoutMs, protocol);
      if (r) found.push({ ...r, via: via.get(h) ?? "" });
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, hosts.length) }, worker));
  const scanned = [...nets.map((n) => `${n.base}.0/24 (${n.iface})`), `mDNS (${fromMdns.length} answered)`, `ARP table (${fromArp.length} hosts)`];
  return { found: found.sort((a, b) => a.host.localeCompare(b.host, undefined, { numeric: true })), scanned };
}
