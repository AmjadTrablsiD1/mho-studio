// The simulated LeCroy on a TCP socket speaking VICP, as a real X-Stream
// scope does on port 1861: each message arrives in DATA|EOI blocks, and each
// reply goes back as one message carrying the sequence number of the query.

import net from "node:net";
import { C } from "../core/src/constants.ts";
import { vicpMessage, VicpFramer } from "../core/src/scpi/vicp.ts";
import { LecroySim } from "./lecroy.ts";

export type LecroySimHandle = { port: number; scope: LecroySim; close: () => Promise<void> };

const enc = new TextEncoder();

export function startLecroySim(port = 0, host = "127.0.0.1", scope = new LecroySim()): Promise<LecroySimHandle> {
  const sockets = new Set<net.Socket>();
  const server = net.createServer((sock) => {
    sockets.add(sock);
    sock.setNoDelay(true);
    const framer = new VicpFramer();
    let chain = Promise.resolve();
    sock.on("data", (d) => {
      let messages;
      try {
        messages = framer.push(new Uint8Array(d.buffer, d.byteOffset, d.length));
      } catch {
        sock.destroy();
        return;
      }
      for (const m of messages) {
        const text = new TextDecoder("latin1").decode(m.data);
        chain = chain.then(
          () =>
            new Promise<void>((resolve) => {
              const replies = scope.exec(text);
              setTimeout(() => {
                if (!sock.destroyed) for (const r of replies) sock.write(vicpMessage(typeof r === "string" ? enc.encode(`${r}\n`) : r, m.seq, false));
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
