import { defineConfig, devices } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The suite drives the built app against the simulated MHO984 (sim/), never a
// real instrument: it switches generator outputs on and resets settings.
export const PORT = 4392;
const home = mkdtempSync(join(tmpdir(), "mho-studio-e2e-"));

export default defineConfig({
  testDir: "./tests",
  testMatch: "**/*.spec.ts",
  fullyParallel: false,
  workers: 1,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  reporter: [["list"]],
  use: {
    testIdAttribute: "data-test",
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: "retain-on-failure",
  },
  projects: [
    { name: "midnight", use: { ...devices["Desktop Chrome"], viewport: { width: 1600, height: 1000 } }, metadata: { theme: "midnight" } },
    { name: "daylight", use: { ...devices["Desktop Chrome"], viewport: { width: 1600, height: 1000 } }, metadata: { theme: "daylight" } },
  ],
  webServer: {
    // --stay: pages open and close between tests; the server must not stop when the last one does.
    command: `node ../server/main.ts --port ${PORT} --no-open --no-reuse --sim --stay`,
    url: `http://127.0.0.1:${PORT}/api/whoami`,
    // MHO_STUDIO_NO_USB / _NO_SERIAL: the suite must never list, open or reset a real scope on this
    // computer's USB, nor open the STM32 board's serial port.
    // The updater never reaches GitHub from the suite: a closed local port stands in for it.
    env: {
      MHO_STUDIO_HOME: home, MHO_STUDIO_NO_USB: "1", MHO_STUDIO_NO_SERIAL: "1", MHO_STUDIO_NO_UPDATE_CHECK: "1",
      MHO_STUDIO_UPDATE_API: "http://127.0.0.1:9", MHO_STUDIO_UPDATE_RAW: "http://127.0.0.1:9", MHO_STUDIO_UPDATE_CODELOAD: "http://127.0.0.1:9",
    },
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
