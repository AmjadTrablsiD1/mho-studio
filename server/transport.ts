// How the server reaches the oscilloscope: a plain TCP socket, or -- when macOS's
// Local Network privacy blocks this Node binary (seen 2026-09-19 in Pluto Studio:
// node got EHOSTUNREACH to a LAN device while Apple's own /usr/bin/nc connected
// fine) -- a pipe through /usr/bin/nc, which as a platform binary is exempt. Both
// look like a Duplex to the SCPI client. Copied from pluto-studio/server/transport.ts.

import net from "node:net";
import { spawn } from "node:child_process";
import { Duplex } from "node:stream";
import { existsSync } from "node:fs";

export type Transport = "tcp" | "nc";

export type TransportStatus = {
  /** What the last successful connection used. */
  active: Transport | null;
  /** True once a direct socket was refused in the way macOS Local Network privacy refuses it. */
  localNetworkBlocked: boolean;
  lastError: string | null;
};

const NC = "/usr/bin/nc";
const status: TransportStatus = { active: null, localNetworkBlocked: false, lastError: null };
export const transportStatus = (): TransportStatus => ({ ...status });

/** The errors a Local Network denial produces on macOS (the route exists; the process may not use it). */
const BLOCKED = new Set(["EHOSTUNREACH", "ENETUNREACH", "EPERM", "EACCES"]);

export type Conn = Duplex & { setNoDelay?: (on: boolean) => unknown };

function tcp(host: string, port: number, timeoutMs: number): Promise<Conn> {
  return new Promise((resolve, reject) => {
    const s = net.connect({ host, port });
    const t = setTimeout(() => {
      s.destroy();
      reject(Object.assign(new Error(`no answer from ${host}:${port} within ${timeoutMs} ms`), { code: "ETIMEDOUT" }));
    }, timeoutMs);
    s.once("error", (e) => {
      clearTimeout(t);
      s.destroy();
      reject(e);
    });
    s.once("connect", () => {
      clearTimeout(t);
      s.removeAllListeners("error");
      resolve(s);
    });
  });
}

/**
 * nc's stdin/stdout as a Duplex. nc gives no "connected" signal, so wait until
 * it has either exited (refused/unreachable) or stayed up for a moment.
 */
function viaNc(host: string, port: number, timeoutMs: number): Promise<Conn> {
  return new Promise((resolve, reject) => {
    const secs = String(Math.max(1, Math.ceil(timeoutMs / 1000)));
    const child = spawn(NC, ["-G", secs, host, String(port)], { stdio: ["pipe", "pipe", "pipe"] });
    let err = "";
    child.stderr.on("data", (d) => (err += d.toString()));
    const early = (code: number | null) => reject(new Error(`nc could not reach ${host}:${port}${err ? ` — ${err.trim()}` : ` (exit ${code})`}`));
    child.once("exit", early);
    child.once("error", (e) => reject(e));
    setTimeout(() => {
      if (child.exitCode !== null) return;
      child.off("exit", early);
      const d = Duplex.from({ readable: child.stdout, writable: child.stdin }) as Conn;
      // destroy() must end the TCP connection fully (a half-close can leave the instrument holding the socket): kill nc.
      const destroy = d.destroy.bind(d);
      d.destroy = (e?: Error) => {
        child.kill();
        return destroy(e);
      };
      child.once("exit", () => d.destroy());
      resolve(d);
    }, Math.min(400, timeoutMs));
  });
}

export async function connectTo(host: string, port: number, timeoutMs: number): Promise<Conn> {
  // Once we know the direct path is blocked, go straight to nc.
  let directRefused = false;
  if (!status.localNetworkBlocked) {
    try {
      const s = await tcp(host, port, timeoutMs);
      status.active = "tcp";
      status.lastError = null;
      return s;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code ?? "";
      status.lastError = (e as Error).message;
      if (!(process.platform === "darwin" && BLOCKED.has(code) && existsSync(NC))) throw e;
      directRefused = true;
    }
  }
  try {
    const s = await viaNc(host, port, timeoutMs);
    // Only now is it proven: the route works for nc but not for us — a Local Network denial,
    // not an unplugged instrument (which fails both ways).
    if (directRefused) status.localNetworkBlocked = true;
    status.active = "nc";
    status.lastError = null;
    return s;
  } catch (e) {
    status.lastError = (e as Error).message;
    throw e;
  }
}

/** Forget what was learned (after the user changes the Local Network setting). */
export function resetTransport(): void {
  status.localNetworkBlocked = false;
  status.active = null;
}
