#!/usr/bin/env node
// MHO Studio's local server. HTTP only: routes, auth, static files, SSE.
// Instrument logic is in scope.ts / deep.ts / bode.ts, maths in core/.
//
// Binds 127.0.0.1 on an OS-chosen port and writes the port to a file, so a
// second launch opens the running instance instead of starting another.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { C } from "../core/src/constants.ts";
import type { WindowName } from "../core/src/dsp/window.ts";
import { HttpError, ScopeService } from "./scope.ts";
import { DeepStore } from "./deep.ts";
import { BodeRunner, checkConfig } from "./bode.ts";
import { BurstRunner, checkBurst } from "./burst.ts";
import { discover } from "./discover.ts";
import { listUsb } from "./usbtmc.ts";
import { deletePreset, expand, listPresets, loadSettings, readPreset, savePreset } from "./store.ts";
import { resetTransport } from "./transport.ts";
import { log } from "./log.ts";

// A stray error in a callback must not take the instrument link down with the process.
// It is logged; the request that caused it (if any) has already answered with an error.
process.on("unhandledRejection", (e) => log(`unhandled rejection: ${(e as Error)?.stack ?? e}`));
process.on("uncaughtException", (e) => log(`uncaught exception: ${e.stack ?? e}`));

// Inside the Windows .exe the server is one CommonJS bundle: there is no import.meta.url, and the
// exe unpacks the interface itself and says where (MHO_STUDIO_DIST; packaging/build-exe.mjs).
const self = import.meta.url ? fileURLToPath(import.meta.url) : process.execPath;
const here = dirname(self);
const root = resolve(here, "..");
const DIST = process.env.MHO_STUDIO_DIST || join(root, "ui", "dist");
const PORT_FILE = expand(C.paths.port_file);
const TOKEN = randomBytes(24).toString("hex");

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const value = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
};

function openBrowser(url: string): void {
  const [cmd, argv] = process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
  try {
    spawn(cmd, argv, { detached: true, stdio: "ignore", windowsHide: true }).unref();
  } catch {
    /* headless */
  }
}

const mtime = (f: string) => (existsSync(f) ? Math.round(statSync(f).mtimeMs) : 0);
const BUILD = [join(DIST, "index.html"), self, join(here, "scope.ts")].map(mtime).join("-");

async function whoami(port: number): Promise<{ token: string; build?: string; pid?: number } | null> {
  try {
    const res = await fetch(`http://${C.server.host}:${port}/api/whoami`, { signal: AbortSignal.timeout(1200) });
    const w = (res.ok ? await res.json() : null) as { token?: string; build?: string; pid?: number } | null;
    return w?.token === C.server.whoami_token ? (w as { token: string; build?: string; pid?: number }) : null;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ reuse

const explicitPort = value("port");

/** A copy of this build already running: bring it forward and stop here. An older build: replace it. */
async function replacePrevious(): Promise<void> {
  if (explicitPort || flag("no-reuse") || !existsSync(PORT_FILE)) return;
  const previous = Number(readFileSync(PORT_FILE, "utf8").trim());
  const running = Number.isInteger(previous) && previous > 0 ? await whoami(previous) : null;
  if (running && running.build === BUILD) {
    const url = `http://${C.server.host}:${previous}/`;
    console.log(`${C.app.name} is already running at ${url}`);
    if (!flag("no-open")) openBrowser(url);
    process.exit(0);
  }
  if (running?.pid) {
    console.log(`${C.app.name}: replacing the older instance on port ${previous}`);
    try {
      process.kill(running.pid, "SIGTERM");
    } catch {
      /* already gone */
    }
    for (let i = 0; i < 30 && (await whoami(previous)); i++) await new Promise((r) => setTimeout(r, 100));
  }
}

if (!flag("api-only") && !existsSync(join(DIST, "index.html"))) {
  console.error(`No built interface at ${DIST}. Run ./install.sh, or: cd ui && npm install && npm run build`);
  process.exit(1);
}

// ------------------------------------------------------------ subscribers

const clients = new Set<ServerResponse>();
function broadcast(type: string, data: unknown): void {
  const frame = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(frame);
}

const scope = new ScopeService(broadcast);
const deep = new DeepStore();
const bode = new BodeRunner();
const burst = new BurstRunner(deep);

// ------------------------------------------------------------------- http

const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
};

async function rawBody(req: IncomingMessage): Promise<Buffer> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > C.server.max_body_bytes) throw new HttpError(413, "request too large");
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks);
}

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  const b = await rawBody(req);
  if (!b.length) return {};
  try {
    return JSON.parse(b.toString("utf8"));
  } catch {
    throw new HttpError(400, "body is not JSON");
  }
}

/** Same-origin and token: a page on another site cannot read the token, so it cannot drive the instrument. */
function authorised(req: IncomingMessage, port: number): boolean {
  const host = req.headers.host;
  const allowedHosts = [`${C.server.host}:${port}`, `localhost:${port}`];
  if (!host || !allowedHosts.includes(host)) return false;
  const origin = req.headers.origin;
  if (origin && !allowedHosts.map((h) => `http://${h}`).includes(origin)) return false;
  return req.headers[C.server.token_header] === TOKEN;
}

const stamp = () => new Date().toISOString().replace(/[:T]/g, "-").slice(0, 19);
const num = (v: unknown, d: number) => (v === undefined || v === null || v === "" ? d : Number(v));

type Route = (req: IncomingMessage, res: ServerResponse, params: string[], url: URL) => Promise<void>;
/** What a screen dump is, from its first bytes: X-Stream scopes may send BMP or JPEG where PNG was not accepted. */
function imageType(b: Uint8Array): { mime: string; ext: string } {
  if (b[0] === 0x89 && b[1] === 0x50) return { mime: "image/png", ext: "png" };
  if (b[0] === 0xff && b[1] === 0xd8) return { mime: "image/jpeg", ext: "jpg" };
  if (b[0] === 0x42 && b[1] === 0x4d) return { mime: "image/bmp", ext: "bmp" };
  if ((b[0] === 0x49 && b[1] === 0x49) || (b[0] === 0x4d && b[1] === 0x4d)) return { mime: "image/tiff", ext: "tif" };
  return { mime: "application/octet-stream", ext: "bin" };
}

const routes: { method: string; path: RegExp; mutate: boolean; handler: Route }[] = [
  {
    method: "GET", path: /^\/api\/whoami$/, mutate: false,
    handler: async (_q, res) => json(res, 200, { token: C.server.whoami_token, app: C.app.id, version: C.app.version, build: BUILD, pid: process.pid }),
  },
  {
    method: "GET", path: /^\/api\/session$/, mutate: false,
    handler: async (req, res) => {
      if (req.headers["sec-fetch-site"] && req.headers["sec-fetch-site"] !== "same-origin") return json(res, 403, { error: "cross-site" });
      json(res, 200, { token: TOKEN, header: C.server.token_header });
    },
  },
  { method: "GET", path: /^\/api\/state$/, mutate: false, handler: async (_q, res) => json(res, 200, { ...scope.snapshot(), bode: bode.state, burst: burst.state, deep: deep.meta, presets: listPresets() }) },
  {
    method: "GET", path: /^\/api\/stream$/, mutate: false,
    handler: async (req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
      res.write(`retry: ${C.ui.sse_retry_ms}\n\n`);
      clients.add(res);
      scope.viewers = clients.size;
      req.on("close", () => {
        clients.delete(res);
        scope.viewers = clients.size;
      });
    },
  },
  // --------------------------------------------------------------- link
  {
    method: "POST", path: /^\/api\/connect$/, mutate: true,
    handler: async (req, res) => {
      const b = await body(req);
      json(res, 200, await scope.connect({
        host: String(b.host ?? ""),
        port: num(b.port, C.instrument.scpi_port),
        protocol: b.protocol === "vicp" ? "vicp" : b.protocol === "raw" ? "raw" : undefined,
        sim: b.sim === true,
        simModel: b.simModel === "lecroy" ? "lecroy" : "rigol",
        usb: b.usb === true,
        usbId: b.usbId ? String(b.usbId) : null,
      }));
    },
  },
  { method: "POST", path: /^\/api\/disconnect$/, mutate: true, handler: async (_q, res) => json(res, 200, await scope.disconnect()) },
  { method: "POST", path: /^\/api\/usb$/, mutate: true, handler: async (_q, res) => json(res, 200, await listUsb()) },
  { method: "POST", path: /^\/api\/discover$/, mutate: true, handler: async (req, res) => {
      const b = await body(req);
      json(res, 200, await discover(num(b.port, C.instrument.scpi_port), b.protocol === "vicp" ? "vicp" : b.protocol === "raw" ? "raw" : undefined));
    } },
  { method: "POST", path: /^\/api\/transport\/reset$/, mutate: true, handler: async (_q, res) => (resetTransport(), json(res, 200, { ok: true })) },
  // ------------------------------------------------------------ settings
  {
    method: "POST", path: /^\/api\/control$/, mutate: true,
    handler: async (req, res) => {
      const b = await body(req);
      json(res, 200, await scope.write(String(b.key), b.value as never, b.confirmed === true));
    },
  },
  {
    method: "POST", path: /^\/api\/action$/, mutate: true,
    handler: async (req, res) => {
      const b = await body(req);
      json(res, 200, await scope.action(String(b.id), b.n === undefined || b.n === null ? null : Number(b.n), b.confirmed === true));
    },
  },
  {
    // Read every value of a group (and optional sub-group / suffix) back from the instrument.
    method: "POST", path: /^\/api\/read$/, mutate: true,
    handler: async (req, res) => {
      const b = await body(req);
      const keys = Array.isArray(b.keys) ? (b.keys as string[]) : scope.groupKeys(String(b.group), b.sub === undefined ? undefined : (b.sub as string | null), b.n ? Number(b.n) : undefined);
      if (!scope.ready) throw new HttpError(409, "not connected to an oscilloscope");
      json(res, 200, await scope.readKeys(keys.slice(0, 400)));
    },
  },
  { method: "POST", path: /^\/api\/clock$/, mutate: true, handler: async (_q, res) => json(res, 200, await scope.syncClock()) },
  {
    method: "POST", path: /^\/api\/digital$/, mutate: true,
    handler: async (req, res) => {
      const b = await body(req);
      json(res, 200, await scope.digital(Number(b.ch), { enable: b.enable === undefined ? undefined : b.enable === true, label: b.label === undefined ? undefined : String(b.label) }));
    },
  },
  // -------------------------------------------------------- measurements
  {
    method: "POST", path: /^\/api\/measure\/add$/, mutate: true,
    handler: async (req, res) => {
      const b = await body(req);
      json(res, 200, await scope.addMeasurement(String(b.item), String(b.src1), b.src2 ? String(b.src2) : undefined));
    },
  },
  {
    method: "POST", path: /^\/api\/measure\/update$/, mutate: true,
    handler: async (req, res) => {
      const b = await body(req);
      const str = (x: unknown) => (x === undefined || x === null || x === "" ? undefined : String(x));
      json(res, 200, await scope.updateMeasurement(String(b.id), { item: str(b.item), src1: str(b.src1), src2: str(b.src2) }));
    },
  },
  { method: "POST", path: /^\/api\/measure\/remove$/, mutate: true, handler: async (req, res) => json(res, 200, await scope.removeMeasurement(String((await body(req)).id))) },
  { method: "POST", path: /^\/api\/measure\/reset$/, mutate: true, handler: async (_q, res) => json(res, 200, scope.resetStats()) },
  // --------------------------------------------------------- one-shots
  {
    method: "GET", path: /^\/api\/screenshot\.png$/, mutate: false,
    handler: async (_q, res, _p, url) => {
      const png = await scope.screenshot();
      const img = imageType(png);
      res.writeHead(200, {
        "Content-Type": img.mime,
        "Cache-Control": "no-store",
        ...(url.searchParams.has("download") ? { "Content-Disposition": `attachment; filename="${(scope.link.idn?.model || "scope").replace(/[^\w.-]/g, "_")}-${stamp()}.${img.ext}"` } : {}),
      });
      res.end(png);
    },
  },
  {
    method: "GET", path: /^\/api\/bus\/(\d)$/, mutate: false,
    handler: async (_q, res, [n]) => json(res, 200, await scope.busTable(Number(n))),
  },
  { method: "POST", path: /^\/api\/console$/, mutate: true, handler: async (req, res) => json(res, 200, await scope.console(String((await body(req)).cmd ?? ""))) },
  // ------------------------------------------------------ setups/presets
  {
    method: "GET", path: /^\/api\/setup$/, mutate: false,
    handler: async (_q, res) => {
      const blob = await scope.setupBlob();
      res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Disposition": `attachment; filename="MHO984-setup-${stamp()}.stp"`, "Cache-Control": "no-store" });
      res.end(blob);
    },
  },
  {
    method: "POST", path: /^\/api\/setup$/, mutate: true,
    handler: async (req, res, _p, url) => {
      if (url.searchParams.get("confirmed") !== "1") throw new HttpError(409, "Loading a setup file replaces every setting on the oscilloscope. Continue?");
      const b = await rawBody(req);
      if (!b.length) throw new HttpError(400, "empty setup file");
      json(res, 200, await scope.restoreSetup(new Uint8Array(b)));
    },
  },
  { method: "GET", path: /^\/api\/presets$/, mutate: false, handler: async (_q, res) => json(res, 200, listPresets()) },
  {
    method: "POST", path: /^\/api\/presets\/save$/, mutate: true,
    handler: async (req, res) => {
      const b = await body(req);
      const blob = await scope.setupBlob();
      savePreset(String(b.name ?? ""), blob, scope.link.idn?.model ?? "", scope.link.idn?.firmware ?? "");
      const list = listPresets();
      broadcast("presets", list);
      json(res, 200, list);
    },
  },
  {
    method: "POST", path: /^\/api\/presets\/recall$/, mutate: true,
    handler: async (req, res) => {
      const b = await body(req);
      const meta = listPresets().find((p) => p.name === String(b.name));
      const model = scope.link.idn?.model ?? "";
      // A setup file only means something to the kind of instrument that wrote it (a RIGOL file sent to a LeCroy is gibberish).
      if (meta && model && meta.model && meta.model !== model) throw new HttpError(400, `"${b.name}" was saved on a ${meta.model}; this is a ${model}. Setup files load only on the model that wrote them.`);
      if (b.confirmed !== true) throw new HttpError(409, `Recall "${b.name}"? It replaces every setting on the oscilloscope.`);
      json(res, 200, await scope.restoreSetup(readPreset(String(b.name))));
    },
  },
  {
    method: "POST", path: /^\/api\/presets\/delete$/, mutate: true,
    handler: async (req, res) => {
      deletePreset(String((await body(req)).name));
      const list = listPresets();
      broadcast("presets", list);
      json(res, 200, list);
    },
  },
  // -------------------------------------------------------- deep memory
  {
    method: "POST", path: /^\/api\/deep\/capture$/, mutate: true,
    handler: async (req, res) => {
      const b = await body(req);
      const srcs = (Array.isArray(b.channels) ? b.channels : []).map(String);
      let last = 0;
      const meta = await deep.capture(scope, srcs, num(b.maxPoints, C.deep.max_points_per_channel), b.resume !== false, (p) => {
        if (Date.now() - last > 150 || p.done === p.total) {
          last = Date.now();
          broadcast("deep-progress", p);
        }
      });
      broadcast("deep", meta);
      json(res, 200, meta);
    },
  },
  { method: "POST", path: /^\/api\/deep\/cancel$/, mutate: true, handler: async (_q, res) => (deep.cancel(), json(res, 200, { ok: true })) },
  {
    method: "GET", path: /^\/api\/deep\/view$/, mutate: false,
    handler: async (_q, res, _p, url) => {
      const s = url.searchParams;
      json(res, 200, deep.view(String(s.get("src")), num(s.get("from"), 0), num(s.get("to"), deep.meta?.points ?? 0), Math.min(8000, num(s.get("cols"), C.deep.view_columns))));
    },
  },
  {
    method: "GET", path: /^\/api\/deep\/spectrum$/, mutate: false,
    handler: async (_q, res, _p, url) => {
      const s = url.searchParams;
      const w = (s.get("window") ?? C.spectrum.default_window) as WindowName;
      if (!C.spectrum.windows.includes(w)) throw new HttpError(400, "unknown window");
      json(res, 200, deep.analyse(String(s.get("src")), num(s.get("from"), 0), num(s.get("to"), deep.meta?.points ?? 0), w));
    },
  },
  {
    method: "GET", path: /^\/api\/scope-fft$/, mutate: false,
    handler: async (_q, res, _p, url) => {
      const w = (url.searchParams.get("window") ?? C.spectrum.default_window) as WindowName;
      if (!C.spectrum.windows.includes(w)) throw new HttpError(400, "unknown window");
      json(res, 200, await scope.scopeFft(String(url.searchParams.get("src") ?? "CHANnel1"), w));
    },
  },
  { method: "POST", path: /^\/api\/scope-fft\/stop$/, mutate: true, handler: async (_q, res) => json(res, 200, await scope.scopeFftStop()) },
  {
    method: "GET", path: /^\/api\/deep\/export\.csv$/, mutate: false,
    handler: async (_q, res, _p, url) => {
      const s = url.searchParams;
      const gen = deep.csv(num(s.get("from"), 0), num(s.get("to"), deep.meta?.points ?? 0));
      res.writeHead(200, { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="MHO984-deep-${stamp()}.csv"`, "Cache-Control": "no-store" });
      for (const chunk of gen) if (!res.write(chunk)) await new Promise((r) => res.once("drain", r));
      res.end();
    },
  },
  // -------------------------------------------------------- edge capture
  {
    method: "POST", path: /^\/api\/burst\/start$/, mutate: true,
    handler: async (req, res) => {
      const cfg = checkBurst(await body(req));
      if (!scope.ready) throw new HttpError(409, "not connected to an oscilloscope");
      if (burst.state.running) throw new HttpError(409, "an edge capture is already running");
      void burst.run(scope, cfg, (s) => broadcast("burst", s)).then((s) => {
        if (s.phase === "done") broadcast("deep", deep.meta);
      });
      json(res, 200, { started: true });
    },
  },
  { method: "POST", path: /^\/api\/burst\/stop$/, mutate: true, handler: async (_q, res) => (burst.stop(), json(res, 200, { stopping: true })) },
  {
    method: "GET", path: /^\/api\/burst\/edges\.csv$/, mutate: false,
    handler: async (_q, res) => {
      res.writeHead(200, { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="edges-${stamp()}.csv"`, "Cache-Control": "no-store" });
      for (const chunk of burst.csv()) if (!res.write(chunk)) await new Promise((r) => res.once("drain", r));
      res.end();
    },
  },
  // ---------------------------------------------------------------- bode
  {
    method: "POST", path: /^\/api\/bode\/start$/, mutate: true,
    handler: async (req, res) => {
      const cfg = checkConfig(await body(req));
      if (bode.state.running) throw new HttpError(409, "a sweep is already running");
      void bode.run(scope, cfg, (s) => broadcast("bode", s));
      json(res, 202, { started: true, config: cfg });
    },
  },
  { method: "POST", path: /^\/api\/bode\/stop$/, mutate: true, handler: async (_q, res) => (bode.stop(), json(res, 200, { stopping: true })) },
  {
    method: "GET", path: /^\/api\/bode\/export\.csv$/, mutate: false,
    handler: async (_q, res) => {
      res.writeHead(200, { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="MHO984-bode-${stamp()}.csv"` });
      res.end(bode.csv());
    },
  },
  {
    method: "POST", path: /^\/api\/quit$/, mutate: true,
    handler: async (_q, res) => {
      json(res, 200, { quitting: true });
      setTimeout(shutdown, 50);
    },
  },
];

function serveStatic(req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url ?? "/", "http://x");
  let path = decodeURIComponent(url.pathname);
  if (path.endsWith("/")) path += "index.html";
  const target = join(DIST, normalize(path).replace(/^(\.\.[/\\])+/, ""));
  if (!target.startsWith(DIST)) {
    res.writeHead(403).end();
    return;
  }
  const file = existsSync(target) && statSync(target).isFile() ? target : join(DIST, "index.html");
  res.writeHead(200, {
    "Content-Type": TYPES[extname(file).toLowerCase()] ?? "application/octet-stream",
    "Cache-Control": file.includes(`${join("", "assets", "")}`) ? "public, max-age=31536000, immutable" : "no-cache",
    "X-Content-Type-Options": "nosniff",
  });
  createReadStream(file).pipe(res);
}

const server = createServer(async (req, res) => {
  const port = (server.address() as { port: number }).port;
  const url = new URL(req.url ?? "/", "http://x");
  if (!url.pathname.startsWith("/api/")) return serveStatic(req, res);
  const route = routes.find((r) => r.method === req.method && r.path.test(url.pathname));
  if (!route) return json(res, 404, { error: "no such endpoint" });
  if (route.mutate && !authorised(req, port)) return json(res, 403, { error: "not authorised" });
  try {
    await route.handler(req, res, route.path.exec(url.pathname)!.slice(1), url);
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 502;
    if (!res.headersSent) json(res, status, { error: (e as Error).message, needsConfirm: status === 409 && !/busy|already|not connected/.test((e as Error).message) });
    else res.end();
  }
});

void replacePrevious().then(() => server.listen(Number(explicitPort ?? C.server.port), C.server.host, async () => {
  const port = (server.address() as { port: number }).port;
  const url = `http://${C.server.host}:${port}/`;
  if (!explicitPort) {
    mkdirSync(dirname(PORT_FILE), { recursive: true });
    writeFileSync(PORT_FILE, String(port));
  }
  console.log(`${C.app.name} ${C.app.version} — ${url}`);
  log(`started ${C.app.version} on ${url} (pid ${process.pid})`);
  console.log("Press Control-C to stop.");
  if (!flag("no-open")) openBrowser(url);
  // Reconnect to where we were last time, without blocking the window.
  const s = loadSettings();
  if (flag("sim")) void scope.connect({ sim: true, simModel: flag("lecroy") ? "lecroy" : "rigol" }).catch(() => {});
  else if (flag("no-autoconnect")) return;
  else if (s.lastKind === "sim") void scope.connect({ sim: true, simModel: s.simModel }).catch(() => {});
  else if (s.lastKind === "usb") void scope.connect({ usb: true, usbId: s.usbId }).catch(() => {});
  else if (s.lastKind === "tcp" && s.host) void scope.connect({ host: s.host, port: s.port, protocol: s.protocol }).catch(() => {});
}));

let shuttingDown = false;
const shutdown = () => {
  if (shuttingDown) return;
  shuttingDown = true;
  setTimeout(() => process.exit(0), C.server.shutdown_grace_ms).unref();
  bode.stop();
  burst.stop();
  deep.cancel();
  void scope.stop().finally(() => {
    for (const c of clients) c.end();
    server.close(() => process.exit(0));
  });
  try {
    if (!explicitPort && existsSync(PORT_FILE)) unlinkSync(PORT_FILE);
  } catch {
    /* already gone */
  }
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.on("SIGHUP", shutdown);
