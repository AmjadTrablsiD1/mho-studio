#!/usr/bin/env node
// Run a simulated scope on its own, for other tools (or `nc 127.0.0.1 5555`):
//   node sim/main.ts [--port 5555] [--host 127.0.0.1]          the MHO984, raw SCPI
//   node sim/main.ts --lecroy [--port 1861] [--host 127.0.0.1] a LeCroy X-Stream, VICP

import { C } from "../core/src/constants.ts";
import { startSim } from "./server.ts";
import { startLecroySim } from "./lecroy-server.ts";

const args = process.argv.slice(2);
const val = (n: string) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const lecroy = args.includes("--lecroy");
const host = val("host") ?? "127.0.0.1";
const h = lecroy ? await startLecroySim(Number(val("port") ?? C.lecroy.vicp_port), host) : await startSim(Number(val("port") ?? C.instrument.scpi_port), host);
console.log(lecroy ? `Simulated LeCroy X-Stream listening on ${host}:${h.port} (VICP, like the real one's port ${C.lecroy.vicp_port})` : `Simulated MHO984 listening on ${host}:${h.port} (raw SCPI, like the real one's port ${C.instrument.scpi_port})`);
const stop = () => void h.close().then(() => process.exit(0));
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
