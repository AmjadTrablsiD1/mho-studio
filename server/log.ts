// The server's own log: connections, lost links, queries the instrument did
// not answer, and anything that went wrong outside a request. Kept at
// ~/.local/state/mho-studio/server.log (rotated once at log_max_bytes), because
// a double-clicked app has no terminal to read.

import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { C } from "../core/src/constants.ts";
import { expand } from "./store.ts";

const file = () => expand(C.paths.log_file);

export function log(line: string): void {
  const text = `${new Date().toISOString()} ${line}\n`;
  if (process.env.MHO_STUDIO_LOG_STDOUT) process.stdout.write(text);
  try {
    const f = file();
    mkdirSync(dirname(f), { recursive: true });
    if (existsSync(f) && statSync(f).size > C.paths.log_max_bytes) renameSync(f, `${f}.1`);
    appendFileSync(f, text);
  } catch {
    /* the log must never take the app down */
  }
}
