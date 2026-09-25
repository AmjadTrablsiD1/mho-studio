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
    command: `node ../server/main.ts --port ${PORT} --no-open --no-reuse --sim`,
    url: `http://127.0.0.1:${PORT}/api/whoami`,
    env: { MHO_STUDIO_HOME: home },
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
