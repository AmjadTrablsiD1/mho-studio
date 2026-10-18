// The in-app updater against a fake GitHub: a check finds the commits this copy
// lacks; Update downloads that commit, refuses anything that is not this app,
// and runs its installer in a process of its own with the branch and commit.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.MHO_STUDIO_HOME = mkdtempSync(join(tmpdir(), "mho-studio-update-"));
const { Updater, newerVersion } = await import("../update.ts");
const { C } = await import("../../core/src/constants.ts");

const OLD = "a".repeat(40);
const NEW = "b".repeat(40);
const ODD = "c".repeat(40);
const work = mkdtempSync(join(tmpdir(), "mho-studio-gh-"));
const marker = join(work, "installed.txt");

/** A tarball as codeload serves it: one top folder, the repo inside. */
function tarball(sha: string, appId: string): string {
  const root = join(work, `src-${sha}`);
  const top = join(root, `mho-studio-${sha}`);
  mkdirSync(join(top, "shared"), { recursive: true });
  writeFileSync(join(top, "shared", "constants.json"), JSON.stringify({ app: { id: appId, version: "9.9.9" } }));
  writeFileSync(join(top, "install.sh"), `echo "$MHO_STUDIO_UPDATE_BRANCH $MHO_STUDIO_UPDATE_COMMIT $(pwd)" > "${marker}"\n`);
  writeFileSync(join(top, "install-windows.ps1"), `Set-Content "${marker}" "$env:MHO_STUDIO_UPDATE_BRANCH $env:MHO_STUDIO_UPDATE_COMMIT"\n`);
  const file = join(work, `${sha}.tar.gz`);
  execFileSync("tar", ["-czf", file, "-C", root, `mho-studio-${sha}`]);
  return file;
}
const tars: Record<string, string> = { [NEW]: tarball(NEW, C.app.id), [ODD]: tarball(ODD, "something-else") };
const commit = (sha: string, message: string) => ({ sha, commit: { message, author: { date: "2026-10-18T08:00:00Z", name: "Amjad" } } });

const gh = createServer((req, res) => {
  const u = req.url ?? "";
  const send = (body: unknown) => (res.writeHead(200, { "Content-Type": "application/json" }), res.end(JSON.stringify(body)));
  if (u.includes("/commits/lecroy-and-windows")) return send(commit(NEW, "Spectrum: memory depth raised for a full-rate span\n\nbody"));
  if (u.includes("/commits/odd")) return send(commit(ODD, "not this app"));
  if (u.includes(`/compare/${OLD}...${NEW}`)) return send({ ahead_by: 2, behind_by: 0, commits: [commit("d".repeat(40), "first"), commit(NEW, "Spectrum: memory depth raised for a full-rate span")] });
  if (u.includes("/branches")) return send([{ name: "main" }, { name: "lecroy-and-windows" }]);
  if (u.endsWith("/shared/constants.json")) return send({ app: { id: C.app.id, version: "0.5.2" } });
  const t = /\/tar\.gz\/([0-9a-f]{40})$/.exec(u);
  if (t && tars[t[1]]) {
    res.writeHead(200, { "Content-Type": "application/gzip" });
    return res.end(readFileSync(tars[t[1]]));
  }
  res.writeHead(404);
  res.end("{}");
});
await new Promise<void>((r) => gh.listen(0, "127.0.0.1", () => r()));
const base = `http://127.0.0.1:${(gh.address() as { port: number }).port}`;
process.env.MHO_STUDIO_UPDATE_API = base;
process.env.MHO_STUDIO_UPDATE_RAW = base;
process.env.MHO_STUDIO_UPDATE_CODELOAD = base;
after(() => gh.close());

/** An installed copy: a folder with build.json, as the installers leave it. */
function installed(commitSha: string): string {
  const root = mkdtempSync(join(tmpdir(), "mho-studio-installed-"));
  writeFileSync(join(root, "build.json"), `﻿${JSON.stringify({ branch: "lecroy-and-windows", commit: commitSha, dirty: false, from: "git", installedAt: "2026-10-17T10:00:00Z" })}`);
  return root;
}

test("versions compare by number, not by text", () => {
  assert.equal(newerVersion("0.5.10", "0.5.9"), true);
  assert.equal(newerVersion("0.5.1", "0.5.1"), false);
  assert.equal(newerVersion("0.6", "0.5.9"), true);
  assert.equal(newerVersion("0.4.6", "0.5.0"), false);
});

test("a check lists what the installed copy lacks (build.json with a byte-order mark, as PowerShell writes it)", async () => {
  const u = new Updater(() => {}, installed(OLD));
  assert.equal(u.state.where, "installed");
  assert.equal(u.state.branch, "lecroy-and-windows");
  const st = await u.check();
  assert.equal(st.available, true);
  assert.equal(st.newerCount, 2);
  assert.deepEqual(st.newer.map((c) => c.message), ["Spectrum: memory depth raised for a full-rate span", "first"]);
  assert.equal(st.latest?.version, "0.5.2");
  assert.equal(st.latest?.sha, NEW);
  // Up to date: nothing offered.
  assert.equal((await new Updater(() => {}, installed(NEW)).check()).available, false);
  assert.deepEqual(await u.branches(), ["main", "lecroy-and-windows"]);
});

test("an installed copy newer than the branch (local changes not pushed) is not offered the older one", async () => {
  // The fake branch's constants say 0.5.2; pretend this app is newer by checking against a version below it.
  const u = new Updater(() => {}, installed("e".repeat(40))); // a commit GitHub does not know
  const real = C.app.version;
  (C.app as { version: string }).version = "0.6.0";
  try {
    const st = await u.check();
    assert.equal(st.available, false);
    assert.match(st.note ?? "", /This copy \(0\.6\.0\) is newer than lecroy-and-windows on GitHub \(0\.5\.2\): push your changes/);
  } finally {
    (C.app as { version: string }).version = real;
  }
});

test("update: downloads the commit and runs its installer with the branch and commit", async () => {
  const u = new Updater(() => {}, installed(OLD));
  u.restart = false;
  let stopped = 0;
  u.onLaunched = () => stopped++;
  await u.check();
  const st = await u.install(NEW, "lecroy-and-windows");
  assert.equal(stopped, 1, "the server is told to stop once the installer runs");
  assert.match(st.installing ?? "", /installing 9\.9\.9/);
  for (let i = 0; i < 100 && !existsSync(marker); i++) await new Promise((r) => setTimeout(r, 50));
  const line = readFileSync(marker, "utf8");
  assert.match(line, new RegExp(`^lecroy-and-windows ${NEW}`));
  assert.match(line, new RegExp(`mho-studio-${NEW}`), "ran inside the downloaded folder");
});

test("refused: a download that is not this app, a copy run from its source folder, a running job", async () => {
  const u = new Updater(() => {}, installed(OLD));
  u.restart = false;
  await assert.rejects(u.install(ODD, "odd"), /is not MHO Studio/);
  assert.match(u.state.error ?? "", /not MHO Studio/);
  assert.equal(u.state.installing, null);
  const source = new Updater(() => {}, mkdtempSync(join(tmpdir(), "mho-studio-src-")));
  assert.equal(source.state.where, "source");
  await assert.rejects(source.install(NEW), /source folder: update it with git pull/);
  await assert.rejects(new Updater(() => {}, installed(OLD)).install(NEW, "lecroy-and-windows", "Bode sweep"), /Bode sweep is running/);
  await assert.rejects(u.install("not-a-sha"), /not a commit/);
});
