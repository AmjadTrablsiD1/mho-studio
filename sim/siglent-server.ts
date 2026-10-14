// The simulated T3DSO1204 on a TCP socket: raw SCPI as the real one offers on
// port 5025. Replies go out exactly as the simulator built them (block
// prefixes, double newlines, raw BMP screenshots), so the app's framing is
// tested against the same bytes the instrument sends.

import net from "node:net";
import { C } from "../core/src/constants.ts";
import { frameMessages } from "./server.ts";
import { SiglentSim } from "./siglent.ts";

export type SiglentSimHandle = { port: number; scope: SiglentSim; close: () => Promise<void> };

export function startSiglentSim(port = 0, host = "127.0.0.1", scope = new SiglentSim()): Promise<SiglentSimHandle> {
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
        chain = chain.then(
          () =>
            new Promise<void>((resolve) => {
              const replies = scope.exec(m);
              setTimeout(() => {
                if (!sock.destroyed) for (const r of replies) sock.write(r);
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
