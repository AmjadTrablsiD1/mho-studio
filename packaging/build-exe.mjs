// Build MHO Studio as one executable file that carries its own Node.js:
// "MHO Studio.exe" on Windows (the point of this script), "MHO Studio" on
// macOS/Linux (so the same steps can be checked on a Mac).
//
//   cd ui && npm run build          (the interface must be built first)
//   cd packaging && npm install && npm run exe
//
// How (Node's "single executable application" feature):
//  1. esbuild bundles server/main.ts and everything it imports into one
//     CommonJS file. The optional `usb` package stays out (a native module
//     cannot live inside the file), so the .exe reaches scopes over LAN —
//     LeCroy VICP and RIGOL raw SCPI — and the simulators, not RIGOL USB.
//  2. The built interface (ui/dist) goes in as assets. On start the exe
//     unpacks it once into %LOCALAPPDATA%\mho-studio\ui-<hash> and tells the
//     server where (MHO_STUDIO_DIST).
//  3. Node writes the "preparation blob"; postject injects it into a copy of
//     this node binary; on Windows rcedit gives the copy the app's icon first.
// The result runs on a PC with no Node.js installed. It is unsigned, so
// Windows SmartScreen may ask once ("More info" → "Run anyway").

import { build } from "esbuild";
import { inject } from "postject";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(repo, "ui", "dist");
const work = join(repo, "packaging", "build");
const outDir = join(repo, "packaging", "out");
const C = JSON.parse(readFileSync(join(repo, "shared", "constants.json"), "utf8"));
const win = process.platform === "win32";
const exe = join(outDir, win ? `${C.app.name}.exe` : C.app.name);

const step = (s) => console.log(`\n== ${s}`);

if (!existsSync(join(dist, "index.html"))) {
  console.error("Build the interface first: cd ui && npm install && npm run build");
  process.exit(1);
}
const [maj, min] = process.versions.node.split(".").map(Number);
if (maj < 22 || (maj === 22 && min < 18)) {
  console.error(`Node ${process.versions.node} is too old to build the executable (22.18+ needed).`);
  process.exit(1);
}

rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });
mkdirSync(outDir, { recursive: true });

// ---------------------------------------------------------------- 1. bundle
step("Bundling the server");
const unpack = `
(() => {
  // Runs before the app: unpack the interface from the executable (once per build).
  let sea;
  try { sea = require("node:sea"); } catch { return; }
  if (!sea.isSea()) return;
  const fs = require("node:fs"), path = require("node:path"), os = require("node:os");
  const m = JSON.parse(sea.getAsset("manifest.json", "utf8"));
  const base = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), ".local", "share"), "mho-studio", "ui-" + m.id);
  if (!fs.existsSync(path.join(base, ".complete"))) {
    for (const f of m.files) {
      const out = path.join(base, ...f.split("/"));
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, new Uint8Array(sea.getAsset("ui/" + f)));
    }
    fs.writeFileSync(path.join(base, ".complete"), "");
  }
  process.env.MHO_STUDIO_DIST = base;
})();`;
const bundle = join(work, "app.cjs");
await build({
  entryPoints: [join(repo, "server", "main.ts")],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  outfile: bundle,
  external: ["usb"],
  banner: { js: unpack },
  logLevel: "warning",
  // import.meta has no meaning in CommonJS; main.ts falls back to process.execPath.
  logOverride: { "empty-import-meta": "silent" },
});

// ---------------------------------------------------------------- 2. assets
step("Packing the interface");
const files = [];
const walk = (d) => {
  for (const name of readdirSync(d)) {
    const p = join(d, name);
    if (statSync(p).isDirectory()) walk(p);
    else files.push(relative(dist, p).split(sep).join("/"));
  }
};
walk(dist);
const hash = createHash("sha256");
for (const f of files.sort()) hash.update(f).update(readFileSync(join(dist, f)));
const manifest = { id: hash.digest("hex").slice(0, 12), files };
writeFileSync(join(work, "manifest.json"), JSON.stringify(manifest));
const assets = { "manifest.json": join(work, "manifest.json") };
for (const f of files) assets[`ui/${f}`] = join(dist, f);
console.log(`${files.length} files, id ${manifest.id}`);

// ---------------------------------------------------------------- 3. blob + inject
step("Building the executable");
const blob = join(work, "sea-prep.blob");
const config = join(work, "sea-config.json");
writeFileSync(config, JSON.stringify({ main: bundle, output: blob, disableExperimentalSEAWarning: true, useCodeCache: false, useSnapshot: false, assets }, null, 2));
execFileSync(process.execPath, ["--experimental-sea-config", config], { stdio: "inherit" });
rmSync(exe, { force: true });
copyFileSync(process.execPath, exe);
chmodSync(exe, 0o755); // the installed node binary may be read-only, and the copy keeps that
if (win) {
  const { rcedit } = await import("rcedit");
  await rcedit(exe, {
    icon: join(repo, "branding", "icon.ico"),
    "version-string": { ProductName: C.app.name, FileDescription: C.app.tagline, CompanyName: "", LegalCopyright: "" },
    "product-version": C.app.version,
    "file-version": C.app.version,
  });
} else if (process.platform === "darwin") {
  execFileSync("codesign", ["--remove-signature", exe]);
}
await inject(exe, "NODE_SEA_BLOB", readFileSync(blob), {
  sentinelFuse: "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2",
  ...(process.platform === "darwin" ? { machoSegmentName: "NODE_SEA" } : {}),
});
if (process.platform === "darwin") execFileSync("codesign", ["--sign", "-", exe]);
console.log(`\n${exe}  (${(statSync(exe).size / 1e6).toFixed(0)} MB, Node ${process.versions.node} inside)`);
