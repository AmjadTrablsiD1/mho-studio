// Find oscilloscopes on the local network: every /24 this machine is on is
// probed for an open SCPI port, and anything that answers *IDN? is listed.
// It is a plain connect scan of the user's own subnet, nothing more.

import net from "node:net";
import { networkInterfaces } from "node:os";
import { C } from "../core/src/constants.ts";
import { parseIdn } from "../core/src/scpi/values.ts";

export type Found = { host: string; port: number; idn: string; model: string; serial: string; ms: number };

function probe(host: string, port: number, timeoutMs: number): Promise<Found | null> {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const s = net.connect({ host, port });
    let buf = "";
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
      s.write("*IDN?\n");
    });
    s.on("data", (d) => {
      buf += d.toString("latin1");
      if (buf.includes("\n")) {
        const id = parseIdn(buf.split("\n")[0]);
        done({ host, port, idn: id.raw, model: id.model, serial: id.serial, ms: Date.now() - t0 });
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

export async function discover(port: number = C.instrument.scpi_port, timeoutMs = 350, concurrency = 96): Promise<{ found: Found[]; scanned: string[] }> {
  const nets = subnets();
  const hosts: string[] = [];
  for (const n of nets) for (let i = 1; i < 255; i++) {
    const h = `${n.base}.${i}`;
    if (h !== n.address) hosts.push(h);
  }
  const found: Found[] = [];
  let next = 0;
  const worker = async () => {
    while (next < hosts.length) {
      const h = hosts[next++];
      const r = await probe(h, port, timeoutMs);
      if (r) found.push(r);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, hosts.length) }, worker));
  return { found: found.sort((a, b) => a.host.localeCompare(b.host, undefined, { numeric: true })), scanned: nets.map((n) => `${n.base}.0/24 (${n.iface})`) };
}
