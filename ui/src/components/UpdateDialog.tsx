// Updates from the GitHub repository: what is installed, what the branch has
// that this copy does not, and one button that installs it (server/update.ts).
// The app stops while the installer runs and opens a new window when it is done.

import { useEffect, useState } from "react";
import { C } from "../../../core/src/constants.ts";
import { ask, attempt, post, useLive, type UpdateState } from "../api.ts";

const short = (sha: string | undefined | null) => (sha ? sha.slice(0, 7) : "—");
const day = (iso: string | undefined | null) => (iso ? new Date(iso).toLocaleString() : "—");

export function UpdateDialog({ onClose }: { onClose: () => void }) {
  const u = useLive((s) => s.update);
  const [branches, setBranches] = useState<string[] | null>(null);
  const [branch, setBranch] = useState(u?.branch ?? C.update.branch);
  const [started, setStarted] = useState(false);

  useEffect(() => {
    void attempt(() => post<UpdateState>("update/check", { branch }));
    void attempt(() => post<{ branches: string[] }>("update/branches")).then((r) => r && setBranches(r.branches));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!u) return null;
  const check = (b: string) => {
    setBranch(b);
    void attempt(() => post("update/check", { branch: b }));
  };
  const install = async () => {
    if (!u.latest) return;
    const ok = await ask(`Update MHO Studio to ${u.latest.version ?? short(u.latest.sha)} (${u.branch} @ ${short(u.latest.sha)})? The app disconnects and stops, the installer builds the new version (a minute or two, needs internet), and a new window opens when it is done.`);
    if (!ok) return;
    if (await attempt(() => post("update/install", { sha: u.latest!.sha, branch: u.branch }))) setStarted(true);
  };
  const b = u.build;
  return (
    <div className="modal-back" role="dialog" aria-modal="true" aria-labelledby="update-title" onClick={(e) => e.target === e.currentTarget && !started && onClose()}>
      <div className="modal" data-test="update-dialog" style={{ width: "min(620px, 94vw)" }}>
        <h2 id="update-title">Updates</h2>
        <div style={{ display: "grid", gap: 4 }}>
          <div className="metric-row"><span>This copy</span><strong data-test="update-installed">{u.version}{b ? ` · ${b.branch || "?"} @ ${short(b.commit)}${b.dirty ? " + local changes" : ""}` : ""}</strong></div>
          {b && <div className="metric-row"><span>Installed</span><strong>{day(b.installedAt)}</strong></div>}
          <div className="metric-row"><span>From</span><strong className="mono">github.com/{C.update.repo}</strong></div>
        </div>
        {u.where !== "installed" ? (
          <p className="body-text" data-test="update-not-installed" style={{ margin: 0 }}>
            {u.where === "exe"
              ? "This is the single-file MHO Studio.exe: it is not updated in place. Download or build the new .exe."
              : "This copy runs straight from its source folder (a git checkout), not from an installed copy: update it with git pull, then run the installer (install.sh or install-windows.bat)."}
          </p>
        ) : started || u.installing ? (
          <p className="body-text" data-test="update-installing" style={{ margin: 0, color: "var(--gold)" }}>
            {u.installing ? `${u.installing[0].toUpperCase()}${u.installing.slice(1)}…` : "Starting the installer…"} The app stops while the installer runs (a minute or two) and opens a new window when it is done. You can close this one.
          </p>
        ) : (
          <>
            <div className="row" style={{ gap: 8, alignItems: "end" }}>
              <div className="field" style={{ flex: 1 }}>
                <label htmlFor="update-branch">Branch</label>
                <select id="update-branch" className="input" value={branch} onChange={(e) => check(e.target.value)} data-test="update-branch">
                  {(branches ?? [branch]).includes(branch) ? null : <option value={branch}>{branch}</option>}
                  {(branches ?? [branch]).map((x) => <option key={x} value={x}>{x}</option>)}
                </select>
              </div>
              <button className="btn" disabled={u.checking} onClick={() => check(branch)} data-test="update-check">{u.checking ? "Checking…" : "Check again"}</button>
            </div>
            {u.error && <p className="body-text" style={{ margin: 0, color: "var(--coral)" }} data-test="update-error">{u.error}</p>}
            {u.latest && (
              <div style={{ display: "grid", gap: 4 }}>
                <div className="metric-row"><span>On GitHub</span><strong data-test="update-latest">{u.latest.version ?? "?"} · {short(u.latest.sha)} · {day(u.latest.date)}</strong></div>
                {u.available ? (
                  <>
                    <p className="body-text" style={{ margin: "4px 0 0" }}><b>{u.newerCount} new commit{u.newerCount > 1 ? "s" : ""}</b>{u.newerCount > u.newer.length ? ` (the newest ${u.newer.length} shown)` : ""}:</p>
                    <ul className="body-text" style={{ margin: 0, paddingLeft: 18, maxHeight: 180, overflowY: "auto" }} data-test="update-commits">
                      {u.newer.map((c) => <li key={c.sha}><span className="mono muted">{short(c.sha)}</span> {c.message}</li>)}
                    </ul>
                  </>
                ) : (
                  <p className="body-text" style={{ margin: 0 }} data-test="update-none">{u.note ?? "This copy is up to date with that branch."}</p>
                )}
              </div>
            )}
            <label className="row" style={{ gap: 6, fontSize: 11.5 }}>
              <input type="checkbox" checked={u.autoCheck} onChange={(e) => void attempt(() => post("update/auto", { on: e.target.checked }))} data-test="update-auto" />
              Look for updates when the app starts (only reads from GitHub; nothing is installed without you)
            </label>
          </>
        )}
        <div className="actions">
          <button className="btn" onClick={onClose} disabled={started}>Close</button>
          {u.where === "installed" && !started && !u.installing && (
            <button className="btn primary" disabled={!u.available} onClick={() => void install()} data-test="update-install">
              {u.available && u.latest ? `Update to ${u.latest.version ?? short(u.latest.sha)}` : "Update"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
