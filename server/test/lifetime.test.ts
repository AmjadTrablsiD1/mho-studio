// The app is its windows: the real server process, started as the tile starts
// it (on the simulated MHO984), stops — scope disconnected — when its last
// window has been closed for a while, or at once on Quit. Not before a window
// ever opened, not while a reload brings one back, and not with --stay.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, request } from "node:http";
import { fileURLToPath } from "node:url";

const MAIN = fileURLToPath(new URL("../main.ts", import.meta.url));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => resolve(p));
    });
  });
}

async function start(extra: string[] = []): Promise<{ proc: ChildProcess; port: number; exited: Promise<number | null>; log: () => string }> {
  const port = await freePort();
  const home = mkdtempSync(join(tmpdir(), "mho-studio-life-"));
  const proc = spawn(process.execPath, [MAIN, "--port", String(port), "--no-open", "--no-reuse", "--api-only", "--sim", "--idle-stop-s", "1", ...extra], {
    env: { ...process.env, MHO_STUDIO_HOME: home, MHO_STUDIO_NO_USB: "1", MHO_STUDIO_NO_SERIAL: "1" },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let out = "";
  proc.stdout!.on("data", (d) => (out += d));
  proc.stderr!.on("data", (d) => (out += d));
  const exited = new Promise<number | null>((r) => proc.on("exit", (c) => r(c)));
  for (let i = 0; i < 100; i++) {
    const s = await state(port).catch(() => null);
    if (s?.link?.state === "connected") break;
    await sleep(100);
  }
  const logFile = join(home, ".local", "state", "mho-studio", "server.log");
  return { proc, port, exited, log: () => out + (() => { try { return readFileSync(logFile, "utf8"); } catch { return ""; } })() };
}

function get(port: number, path: string, headers: Record<string, string> = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = request({ host: "127.0.0.1", port, path, headers: { Host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      let b = "";
      res.on("data", (d) => (b += d));
      res.on("end", () => resolve(b));
    });
    r.on("error", reject);
    r.end();
  });
}
const state = async (port: number) => JSON.parse(await get(port, "/api/state"));

/** An open window, as far as the server can tell: a Server-Sent Events subscriber. */
function window(port: number): { close: () => void } {
  const r = request({ host: "127.0.0.1", port, path: "/api/stream", headers: { Host: `127.0.0.1:${port}` } });
  r.on("error", () => {});
  r.end();
  return { close: () => r.destroy() };
}

async function post(port: number, path: string, body: unknown): Promise<{ status: number; data: Record<string, unknown> }> {
  const { token, header } = JSON.parse(await get(port, "/api/session"));
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const r = request({ host: "127.0.0.1", port, path, method: "POST", headers: { Host: `127.0.0.1:${port}`, [header]: token, "Content-Type": "application/json" } }, (res) => {
      let b = "";
      res.on("data", (d) => (b += d));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, data: b ? JSON.parse(b) : {} }));
    });
    r.on("error", reject);
    r.end(data);
  });
}

const within = (p: Promise<unknown>, ms: number) => Promise.race([p.then(() => true), sleep(ms).then(() => false)]);

test("the last window closed: the scope is disconnected and the server stops; a reload in between keeps it", async () => {
  const app = await start();
  try {
    // No window has ever opened (the browser is still starting): it stays.
    assert.equal(await within(app.exited, 1800), false, "stopped before any window opened");
    const w1 = window(app.port);
    await sleep(200);
    // A reload: the old page goes, the new one comes within the grace time.
    w1.close();
    await sleep(300);
    const w2 = window(app.port);
    assert.equal(await within(app.exited, 1800), false, "stopped during a reload");
    assert.equal((await state(app.port)).link.state, "connected");
    w2.close();
    assert.equal(await within(app.exited, 8000), true, "still running 8 s after the last window closed");
    assert.match(app.log(), /last window closed: disconnecting and stopping/);
  } finally {
    app.proc.kill();
  }
});

test("Quit: disconnects and stops at once", async () => {
  const app = await start();
  try {
    const w = window(app.port);
    await sleep(200);
    const r = await post(app.port, "/api/quit", {});
    assert.equal(r.status, 200);
    assert.equal(await within(app.exited, 6000), true, "still running after Quit");
    w.close();
  } finally {
    app.proc.kill();
  }
});

test("--stay keeps the server without a window (the test suite, development)", async () => {
  const app = await start(["--stay"]);
  try {
    const w = window(app.port);
    await sleep(200);
    w.close();
    assert.equal(await within(app.exited, 2500), false);
  } finally {
    app.proc.kill();
  }
});
