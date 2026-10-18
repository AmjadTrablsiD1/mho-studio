// Updating MHO Studio from its GitHub repository, from inside the app.
//
// The installers write build.json into the installed copy: the branch and the
// commit it was built from (and whether the source folder had changes not in
// any commit). A check asks GitHub for the newest commit of a branch and the
// commits between the two; Update downloads that exact commit as a tarball,
// checks it is this app, and runs the platform's own installer on it in a
// detached process — the installer stops this server, installs, and the
// runner starts the new copy, which opens a new window.
//
// Nothing runs that the person did not ask for: the background check only
// reads (and can be switched off); installing is a button with a confirmation.

import { spawn } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { C } from "../core/src/constants.ts";
import { HttpError } from "./errors.ts";
import { log } from "./log.ts";
import { expand } from "./store.ts";

export type Build = { branch: string; commit: string; dirty: boolean; installedAt: string; from: "git" | "update" | "folder" };
export type Commit = { sha: string; date: string; message: string; author: string };

export type UpdateState = {
  version: string;
  /** What is installed; null when this copy runs from a source folder or the .exe (they are not updated in place). */
  build: Build | null;
  where: "installed" | "source" | "exe";
  branch: string;
  checking: boolean;
  checkedAt: string | null;
  /** The newest commit of the branch on GitHub. */
  latest: (Commit & { version: string | null }) | null;
  /** Commits on GitHub that this copy does not have, newest first (at most C.update.list_commits). */
  newer: Commit[];
  newerCount: number;
  available: boolean;
  /** The installed copy has commits the branch does not (installed from a newer local checkout). */
  ahead: number;
  /** Why no update is offered although the commits differ, in words. */
  note: string | null;
  installing: string | null;
  error: string | null;
  autoCheck: boolean;
};

const host = (k: "api" | "raw" | "codeload") => process.env[`MHO_STUDIO_UPDATE_${k.toUpperCase()}`] || C.update[k];
const prefsFile = () => expand(`${C.paths.config_dir}/update.json`);
const stateDir = () => expand(C.paths.state_dir);

/** "0.5.1" > "0.5.0"; missing parts count as 0. */
export function newerVersion(a: string, b: string): boolean {
  const pa = a.split(".").map((x) => parseInt(x, 10) || 0);
  const pb = b.split(".").map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0);
  return false;
}

/** Where this server's files are, and whether that is an installed copy. */
function here(): { root: string | null; where: UpdateState["where"] } {
  if (!import.meta.url) return { root: null, where: "exe" };
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  return { root, where: existsSync(join(root, "build.json")) ? "installed" : "source" };
}

export function readBuild(root: string | null): Build | null {
  if (!root) return null;
  try {
    // Windows PowerShell writes UTF-8 with a byte-order mark.
    const b = JSON.parse(readFileSync(join(root, "build.json"), "utf8").replace(/^\uFEFF/, "")) as Partial<Build>;
    return { branch: b.branch ?? "", commit: b.commit ?? "", dirty: b.dirty === true, installedAt: b.installedAt ?? "", from: b.from ?? "folder" };
  } catch {
    return null;
  }
}

async function github<T>(url: string): Promise<T> {
  const r = await fetch(url, {
    headers: { "User-Agent": `${C.app.id}/${C.app.version}`, Accept: "application/vnd.github+json" },
    signal: AbortSignal.timeout(C.update.timeout_ms),
  }).catch((e: Error) => {
    throw new HttpError(502, `GitHub could not be reached (${e.message}) — is this computer online?`);
  });
  if (r.status === 403 || r.status === 429) throw new HttpError(503, "GitHub's limit for anonymous checks is reached (60 an hour); try again later");
  if (r.status === 404) throw new HttpError(404, `not found on GitHub: ${url.replace(/^https?:\/\/[^/]+/, "")}`);
  if (!r.ok) throw new HttpError(502, `GitHub answered ${r.status}`);
  return (await r.json()) as T;
}

type GhCommit = { sha: string; commit: { message: string; author: { date: string; name: string } } };
const commitOf = (c: GhCommit): Commit => ({ sha: c.sha, date: c.commit.author.date, message: c.commit.message.split("\n")[0], author: c.commit.author.name });

export class Updater {
  state: UpdateState;
  private root: string | null;
  private publish: (s: UpdateState) => void;
  /** For tests: what the runner does after the installer (default: start the new copy). */
  restart = true;
  /** Called once the installer runs on its own: this server then disconnects and stops (main.ts). */
  onLaunched: () => void = () => {};

  constructor(publish: (s: UpdateState) => void = () => {}, root?: string | null) {
    this.publish = publish;
    const h = here();
    this.root = root === undefined ? h.root : root;
    const where = root === undefined ? h.where : root && existsSync(join(root, "build.json")) ? "installed" : root ? "source" : "exe";
    const build = readBuild(this.root);
    let autoCheck = true;
    try {
      autoCheck = JSON.parse(readFileSync(prefsFile(), "utf8")).autoCheck !== false;
    } catch {
      /* default on */
    }
    this.state = {
      version: C.app.version, build, where, branch: build?.branch || C.update.branch,
      checking: false, checkedAt: null, latest: null, newer: [], newerCount: 0, available: false, ahead: 0, note: null, installing: null, error: null, autoCheck,
    };
  }

  private set(p: Partial<UpdateState>): void {
    this.state = { ...this.state, ...p };
    this.publish(this.state);
  }

  setAutoCheck(on: boolean): UpdateState {
    mkdirSync(dirname(prefsFile()), { recursive: true });
    writeFileSync(prefsFile(), JSON.stringify({ autoCheck: on }));
    this.set({ autoCheck: on });
    return this.state;
  }

  async branches(): Promise<string[]> {
    const list = await github<{ name: string }[]>(`${host("api")}/repos/${C.update.repo}/branches?per_page=100`);
    return list.map((b) => b.name);
  }

  /** The newest commit of `branch`, and what this copy is missing of it. */
  async check(branch: string = this.state.branch): Promise<UpdateState> {
    if (!/^[\w./-]{1,100}$/.test(branch)) throw new HttpError(400, "not a branch name");
    this.set({ checking: true, error: null, branch });
    try {
      const head = commitOf(await github<GhCommit>(`${host("api")}/repos/${C.update.repo}/commits/${encodeURIComponent(branch)}`));
      let version: string | null = null;
      try {
        const r = await fetch(`${host("raw")}/${C.update.repo}/${head.sha}/shared/constants.json`, { signal: AbortSignal.timeout(C.update.timeout_ms) });
        if (r.ok) version = ((await r.json()) as { app?: { version?: string } }).app?.version ?? null;
      } catch {
        /* the version is a nicety; the commit decides */
      }
      const have = this.state.build?.commit || "";
      let newer: Commit[] = [];
      let newerCount = 0;
      let ahead = 0;
      if (have && have !== head.sha) {
        try {
          const cmp = await github<{ ahead_by: number; behind_by: number; commits: GhCommit[] }>(`${host("api")}/repos/${C.update.repo}/compare/${have}...${head.sha}`);
          newerCount = cmp.ahead_by;
          ahead = cmp.behind_by;
          newer = cmp.commits.map(commitOf).reverse().slice(0, C.update.list_commits);
        } catch {
          // The installed commit is not on GitHub (never pushed): say what the branch has.
          newerCount = 1;
          newer = [head];
        }
      } else if (!have) {
        newerCount = 1;
        newer = [head];
      }
      // Never offer an older app as an update: a copy installed from local changes that are not
      // pushed yet is newer than the branch, and "updating" it would take them away.
      let note: string | null = null;
      if (version && newerVersion(C.app.version, version)) note = `This copy (${C.app.version}) is newer than ${branch} on GitHub (${version}): push your changes, then the next version can come from there.`;
      else if (ahead > 0 && newerCount === 0) note = `This copy has ${ahead} commit${ahead > 1 ? "s" : ""} that ${branch} on GitHub does not: push them first.`;
      else if (this.state.build?.dirty && have === head.sha) note = `Installed from ${branch} @ ${have.slice(0, 7)} with local changes that are not in any commit.`;
      const available = this.state.where === "installed" && have !== head.sha && newerCount > 0 && !(version && newerVersion(C.app.version, version));
      this.set({ checking: false, checkedAt: new Date().toISOString(), latest: { ...head, version }, newer, newerCount, ahead, available, note });
      return this.state;
    } catch (e) {
      this.set({ checking: false, checkedAt: new Date().toISOString(), error: (e as Error).message });
      throw e;
    }
  }

  /** Once at start-up (and then every check_hours) if allowed: only reads. */
  startAutoCheck(): void {
    const tick = () => {
      if (this.state.autoCheck && this.state.where === "installed" && !this.state.installing) void this.check().catch(() => {});
    };
    setTimeout(tick, 5000).unref();
    setInterval(tick, C.update.check_hours * 3600 * 1000).unref();
  }

  /**
   * Download commit `sha` of the repo, check it is this app, and run the installer on it in a
   * process of its own (it outlives this server, which the installer stops).
   */
  async install(sha: string, branch: string = this.state.branch, busy: string | null = null): Promise<UpdateState> {
    if (this.state.where !== "installed") throw new HttpError(409, this.state.where === "exe" ? "the .exe is not updated in place: download the new MHO Studio.exe" : "this copy runs from the source folder: update it with git pull, then the installer");
    if (!/^[0-9a-f]{40}$/.test(sha)) throw new HttpError(400, "not a commit");
    if (this.state.installing) throw new HttpError(409, "an update is already being installed");
    if (busy) throw new HttpError(409, `the ${busy} is running — let it finish, then update`);
    const dir = join(stateDir(), "update");
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    this.set({ installing: "downloading", error: null });
    try {
      const tgz = join(dir, `${sha}.tar.gz`);
      await download(`${host("codeload")}/${C.update.repo}/tar.gz/${sha}`, tgz);
      this.set({ installing: "unpacking" });
      await run("tar", ["-xzf", tgz, "-C", dir]);
      const top = readdirSync(dir, { withFileTypes: true }).find((d) => d.isDirectory());
      if (!top) throw new Error("the download held no folder");
      const src = join(dir, top.name);
      // Only ever this app: its constants name it, and the installer is where it should be.
      const constants = JSON.parse(readFileSync(join(src, "shared", "constants.json"), "utf8")) as { app?: { id?: string; version?: string } };
      const installer = process.platform === "win32" ? join(src, "install-windows.ps1") : join(src, "install.sh");
      if (constants.app?.id !== C.app.id || !existsSync(installer)) throw new Error(`the download is not ${C.app.name}`);
      this.set({ installing: `installing ${constants.app.version ?? sha.slice(0, 7)}` });
      log(`update: installing ${branch} @ ${sha.slice(0, 7)} (${constants.app.version}) from ${C.update.repo}`);
      launchInstaller(src, installer, dir, { branch, sha, restart: this.restart });
      // Stop on our own, disconnecting the scope properly, rather than waiting for the installer to
      // find this process by its command line (which depends on how it was started).
      this.onLaunched();
      return this.state;
    } catch (e) {
      this.set({ installing: null, error: `update failed: ${(e as Error).message}` });
      throw e instanceof HttpError ? e : new HttpError(502, `update failed: ${(e as Error).message}`);
    }
  }
}

async function download(url: string, file: string): Promise<void> {
  const r = await fetch(url, { headers: { "User-Agent": `${C.app.id}/${C.app.version}` }, signal: AbortSignal.timeout(10 * C.update.timeout_ms) });
  if (!r.ok || !r.body) throw new Error(`download answered ${r.status}`);
  const out = createWriteStream(file);
  let n = 0;
  for await (const chunk of r.body as unknown as AsyncIterable<Uint8Array>) {
    n += chunk.length;
    if (n > C.update.max_bytes) {
      out.destroy();
      throw new Error("the download is larger than an app this size can be");
    }
    if (!out.write(chunk)) await new Promise<void>((ok) => out.once("drain", () => ok()));
  }
  await new Promise<void>((ok, no) => out.end((e?: Error | null) => (e ? no(e) : ok())));
}

function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((ok, no) => {
    const p = spawn(cmd, args, { windowsHide: true, stdio: "ignore" });
    p.on("error", no);
    p.on("exit", (c) => (c === 0 ? ok() : no(new Error(`${cmd} exited with ${c}`))));
  });
}

/**
 * The installer in a process group of its own, logging to update.log: it stops this server,
 * installs, and (unless told not to) the runner starts the new copy, which opens a window.
 */
function launchInstaller(src: string, installer: string, dir: string, o: { branch: string; sha: string; restart: boolean }): void {
  const logFile = join(dir, "update.log");
  const fd = openSync(logFile, "a");
  // An app started from Finder or App Launcher has a bare PATH: the installer must find the node (and npm) running this one.
  const env = { ...process.env, PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ""}`, MHO_STUDIO_UPDATE_BRANCH: o.branch, MHO_STUDIO_UPDATE_COMMIT: o.sha };
  let child;
  if (process.platform === "win32") {
    const runner = join(dir, "update-run.ps1");
    writeFileSync(
      runner,
      [
        `& powershell -NoProfile -ExecutionPolicy Bypass -File "${installer}"`,
        `if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }`,
        o.restart ? `Start-Process (Join-Path ([Environment]::GetFolderPath("Desktop")) "${C.app.name}.lnk")` : "",
      ].join("\r\n"),
    );
    child = spawn("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", runner], { cwd: src, env, detached: true, windowsHide: true, stdio: ["ignore", fd, fd] });
  } else {
    const runner = join(dir, "update-run.sh");
    const launcher = join(expand("~/Desktop/Apps"), `${C.app.name}.command`);
    writeFileSync(
      runner,
      ["#!/usr/bin/env bash", "set -e", `bash "${installer}"`, o.restart ? `nohup "${launcher}" >/dev/null 2>&1 &` : "", `echo "update finished"`].join("\n"),
    );
    child = spawn("bash", [runner], { cwd: src, env, detached: true, stdio: ["ignore", fd, fd] });
  }
  child.unref();
}
