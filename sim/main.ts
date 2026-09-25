#!/usr/bin/env node
// Run the simulated MHO984 on its own, for other tools (or `nc 127.0.0.1 5555`):
//   node sim/main.ts [--port 5555] [--host 127.0.0.1]

import { startSim } from "./server.ts";

const args = process.argv.slice(2);
const val = (n: string) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const h = await startSim(Number(val("port") ?? 5555), val("host") ?? "127.0.0.1");
console.log(`Simulated MHO984 listening on ${val("host") ?? "127.0.0.1"}:${h.port} (raw SCPI, like the real one's port 5555)`);
const stop = () => void h.close().then(() => process.exit(0));
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
