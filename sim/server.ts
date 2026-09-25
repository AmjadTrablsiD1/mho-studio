// The simulated MHO984 on a TCP socket: the same raw-SCPI transport the real
// instrument offers on port 5555, so the app's client cannot tell them apart.

import net from "node:net";
import { C } from "../core/src/constants.ts";
import { makeBlock } from "../core/src/scpi/block.ts";
import { SimScope } from "./instrument.ts";

export type SimHandle = { port: number; scope: SimScope; close: () => Promise<void> };

/** Split incoming bytes into program messages: "\n"-terminated, but never inside a #N block. */
export function frameMessages(buf: Buffer): { messages: string[]; rest: Buffer } {
  const messages: string[] = [];
  let start = 0;
  let i = 0;
  while (i < buf.length) {
    const b = buf[i];
    if (b === 0x23 && i + 1 < buf.length && buf[i + 1] >= 0x31 && buf[i + 1] <= 0x39) {
      const n = buf[i + 1] - 0x30;
      if (i + 2 + n > buf.length) break;
      const len = Number(buf.subarray(i + 2, i + 2 + n).toString("latin1"));
      if (!Number.isFinite(len)) {
        i++;
        continue;
      }
      if (i + 2 + n + len > buf.length) break;
      i += 2 + n + len;
      continue;
    }
    if (b === 0x0a) {
      messages.push(buf.subarray(start, i).toString("latin1").replace(/\r$/, ""));
      start = i + 1;
    }
    i++;
  }
  return { messages, rest: buf.subarray(start) };
}

export function startSim(port = 0, host = "127.0.0.1", scope = new SimScope()): Promise<SimHandle> {
  const sockets = new Set<net.Socket>();
  const server = net.createServer((sock) => {
    sockets.add(sock);
    sock.setNoDelay(true);
    let pending = Buffer.alloc(0);
    let chain = Promise.resolve();
    sock.on("data", (d) => {
      pending = Buffer.concat([pending, d]);
      const { messages, rest } = frameMessages(pending);
      pending = Buffer.from(rest);
      for (const m of messages) {
        if (!m.trim()) continue;
        // Answer in order, with a little latency like a real LAN instrument.
        chain = chain.then(
          () =>
            new Promise<void>((resolve) => {
              const replies = scope.exec(m);
              setTimeout(() => {
                if (!sock.destroyed) {
                  const text: string[] = [];
                  for (const r of replies) {
                    if (typeof r === "string") text.push(r);
                    else {
                      if (text.length) sock.write(`${text.splice(0).join(";")}\n`);
                      sock.write(makeBlock(r));
                    }
                  }
                  if (text.length) sock.write(`${text.join(";")}\n`);
                }
                resolve();
              }, C.sim.latency_ms);
            }),
        );
      }
    });
    sock.on("close", () => sockets.delete(sock));
    sock.on("error", () => sockets.delete(sock));
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      const p = (server.address() as net.AddressInfo).port;
      resolve({
        port: p,
        scope,
        close: () =>
          new Promise((r) => {
            for (const s of sockets) s.destroy();
            server.close(() => r());
          }),
      });
    });
  });
}
