// Drives the real interface, in both themes, against the simulated MHO984.

import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { foldProbe, clippedElements, pageScrolls } from "./foldProbe.mjs";

// fileURLToPath, not URL.pathname: on Windows the latter is "/C:/…", which is not a path.
const shots = fileURLToPath(new URL("./screenshots/", import.meta.url));
mkdirSync(shots, { recursive: true });

async function api(page: Page, path: string, data: unknown = {}) {
  const { token, header } = await page.evaluate(() => fetch("./api/session").then((r) => r.json()));
  const r = await page.request.post(`/api/${path}`, { data, headers: { [header]: token } });
  return r.json();
}

async function open(page: Page, theme: string, view = "scope", extra: Record<string, unknown> = {}) {
  await page.addInitScript(([t, ui]) => {
    localStorage.setItem("mho-studio.theme", t as string);
    localStorage.setItem("mho-studio.ui", JSON.stringify(ui));
  }, [theme, { view, section: "vertical", channel: 1, cursors: "off", persistence: false, inspector: true, ...extra }] as const);
  await page.goto("/");
  await expect(page.getByTestId("link-pill")).toContainText("MHO984");
}

/** Put the simulated scope back to its bench state between tests. */
async function resetScope(page: Page) {
  await api(page, "console", { cmd: "*RST" });
  for (const m of await page.evaluate(() => fetch("./api/state").then((r) => r.json()).then((s) => s.measure))) await api(page, "measure/remove", { id: m.slot.id });
}

async function axe(page: Page, where: string) {
  const r = await new AxeBuilder({ page }).analyze();
  const bad = r.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(bad.map((v) => `${where}: ${v.id} — ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
}

/** How many pixels of a trace colour the scope canvas holds (traces are really drawn). */
async function tracePixels(page: Page, token: string): Promise<number> {
  return page.evaluate((tk) => {
    const hex = getComputedStyle(document.documentElement).getPropertyValue(`--${tk}`).trim();
    const want = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
    const c = document.querySelector("[data-test=scope-screen] canvas") as HTMLCanvasElement;
    const d = c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 128 && Math.abs(d[i] - want[0]) + Math.abs(d[i + 1] - want[1]) + Math.abs(d[i + 2] - want[2]) < 90) n++;
    return n;
  }, token);
}

test.describe.configure({ mode: "serial" });
test.afterEach(async ({ page }) => {
  await resetScope(page).catch(() => {});
});

test("scope: live traces, legend, run/stop, no page scroll, accessible", async ({ page }, info) => {
  const theme = info.project.metadata.theme as string;
  await open(page, theme);
  await expect(page.getByTestId("legend")).toContainText("CH1");
  await expect(page.getByTestId("legend")).toContainText("500 mV/div");
  await expect.poll(() => tracePixels(page, "ch1")).toBeGreaterThan(400);
  await expect.poll(() => tracePixels(page, "ch2")).toBeGreaterThan(400);
  await expect(page.getByTestId("trig-status")).toContainText(/Triggered|Auto/);
  await page.getByTestId("runstop").click();
  await expect(page.getByTestId("trig-status")).toContainText("Stopped");
  await page.getByTestId("runstop").click();
  await expect(page.getByTestId("trig-status")).not.toContainText("Stopped");
  expect(await pageScrolls(page)).toEqual({ x: false, y: false });
  await axe(page, `scope/${theme}`);
  await page.screenshot({ path: `${shots}scope-${theme}.png` });
});

test("vertical: 1-2-5 step, typed value read back and reported when the scope coerces it", async ({ page }, info) => {
  await open(page, info.project.metadata.theme as string);
  await page.getByRole("button", { name: "increase Scale" }).click();
  await expect(page.getByTestId("ch-scale-hero")).toContainText("1");
  await expect(page.getByTestId("legend")).toContainText("1 V/div");
  const field = page.locator("#ctl-channel\\.scale\\@1");
  await field.click();
  await field.fill("300m");
  await field.press("Enter");
  await expect(page.locator(".c-note")).toContainText("instrument set 200 mV/div");
  await expect(page.getByTestId("legend")).toContainText("200 mV/div");
});

test("screen: dragging the trigger-level marker sets the level; cursors read out", async ({ page }, info) => {
  await open(page, info.project.metadata.theme as string, "scope", { section: "trigger" });
  const screen = page.getByTestId("scope-screen");
  const box = (await screen.boundingBox())!;
  const before = await page.evaluate(() => fetch("./api/state").then((r) => r.json()).then((s) => s.values["trigger.edge.level"]));
  // The T marker sits on the right edge at the level (0 V on CH1 = +2 div above centre).
  const gh = box.height - 16 - 4;
  const y0 = box.y + 16 + gh / 2 - 2 * (gh / 8);
  await page.mouse.move(box.x + box.width - 20, y0);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 20, y0 - gh / 8, { steps: 6 });
  await page.mouse.up();
  // One division up on CH1 (0.5 V/div, +1 V offset) is +0.5 V; drag writes are throttled, the last one lands on release.
  const level = () => page.evaluate(() => fetch("./api/state").then((r) => r.json()).then((s) => s.values["trigger.edge.level"] as number));
  await expect.poll(level).not.toBe(before);
  await expect.poll(level).toBeGreaterThan(0.4);
  expect(await level()).toBeLessThan(0.6);
  await page.getByTestId("cursors-time").click();
  await expect(page.getByTestId("cursor-box")).toContainText("ΔT");
  await expect(page.getByTestId("cursor-box")).toContainText("1/ΔT");
});

test("measure: add frequency and Vpp; values, statistics and cross-check appear", async ({ page }, info) => {
  const theme = info.project.metadata.theme as string;
  await open(page, theme, "scope", { section: "measure" });
  await page.getByTestId("measure-item").selectOption("FREQuency");
  await page.getByTestId("measure-add").click();
  await page.getByTestId("measure-item").selectOption("VPP");
  await page.getByTestId("measure-add").click();
  const table = page.getByTestId("measure-table");
  const current = (i: number) => table.locator("tbody tr").nth(i).locator("td").nth(2);
  await expect(table.getByTestId("m-item-0")).toHaveValue("FREQuency");
  await expect(current(0)).toHaveText(/^(5|4\.99\d*|5\.00\d*)kHz$/);
  await expect(table.getByTestId("m-item-1")).toHaveValue("VPP");
  await expect(current(1)).toHaveText(/^2\.0\d*V$/);
  await expect(table.locator(".badge").first()).toBeVisible();
  await page.screenshot({ path: `${shots}measure-${theme}.png` });
});

test("measure: a row's channel and quantity can be changed after adding it, and the row removed", async ({ page }, info) => {
  await open(page, info.project.metadata.theme as string, "scope");
  await page.getByTestId("measure-quick-add").click();
  const table = page.getByTestId("measure-table");
  const row = table.locator("tbody tr").first();
  const current = row.locator("td").nth(2);
  await expect(table.getByTestId("m-item-0")).toHaveValue("VPP");
  await expect(current).toHaveText(/^2\.0\d*V$/); // CH1: the generator, 2 Vpp
  // Change the channel: CH3 is the 3.3 V clock.
  await table.getByTestId("m-src1-0").selectOption("CHANnel3");
  await expect(current).toHaveText(/^3\.\d+V$/);
  // Change the quantity: the clock is 1 MHz.
  await table.getByTestId("m-item-0").selectOption("FREQuency");
  await expect(current).toHaveText(/^(1|0\.99\d*|1\.00\d*)MHz$/);
  // A two-channel quantity gets a second channel picker, which can be changed too.
  await table.getByTestId("m-item-0").selectOption("RRDelay");
  await expect(table.getByTestId("m-src2-0")).toBeVisible();
  await table.getByTestId("m-src2-0").selectOption("CHANnel2");
  await expect(table.getByTestId("m-src2-0")).toHaveValue("CHANnel2");
  // The inspector shows the same row, editable there as well.
  await page.getByTestId("sec-measure").click();
  await expect(page.locator(".inspector").getByTestId("m-item-0")).toHaveValue("RRDelay");
  await page.locator(".inspector").getByTestId("m-src1-0").selectOption("CHANnel1");
  await expect(table.getByTestId("m-src1-0")).toHaveValue("CHANnel1");
  await row.getByRole("button", { name: /^Remove/ }).click();
  await expect(table).toHaveCount(0);
});

test("generator: switching an output on asks first, and the answer is honoured", async ({ page }, info) => {
  await open(page, info.project.metadata.theme as string, "scope", { section: "generator", awg: 2 });
  const sw = page.getByRole("switch", { name: "Output" });
  await expect(sw).toHaveAttribute("aria-checked", "false");
  await sw.click();
  await expect(page.getByRole("dialog")).toContainText("generator output");
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(sw).toHaveAttribute("aria-checked", "false");
  await sw.click();
  await page.getByTestId("confirm-ok").click();
  await expect(sw).toHaveAttribute("aria-checked", "true");
});

test("trigger: changing the type shows only that type's fields", async ({ page }, info) => {
  await open(page, info.project.metadata.theme as string, "scope", { section: "trigger" });
  await expect(page.locator("[data-ctl='trigger.edge.level']")).toBeVisible();
  await page.locator("#ctl-trigger\\.mode").selectOption("PULSe");
  await expect(page.locator("[data-ctl='trigger.pulse.lwidth']")).toBeVisible();
  await expect(page.locator("[data-ctl='trigger.edge.level']")).toHaveCount(0);
  await page.locator("#ctl-trigger\\.mode").selectOption("EDGE");
});

test("spectrum: the generator's 5 kHz tone is the top peak", async ({ page }, info) => {
  const theme = info.project.metadata.theme as string;
  await open(page, theme, "spectrum");
  await expect(page.getByTestId("spectrum-plot").locator("canvas")).toBeVisible();
  await expect(page.locator(".card").filter({ hasText: "Peaks" }).locator("tbody tr").first()).toContainText(/(4\.9\d*|5\.0\d*|5) kHz/);
  await page.screenshot({ path: `${shots}spectrum-${theme}.png` });
});

test("quit asks first; cancelled, the app keeps running and stays connected", async ({ page }, info) => {
  const theme = info.project.metadata.theme as string;
  test.skip(theme !== "midnight", "behaviour, not styling");
  await open(page, theme);
  await page.getByTestId("quit").click();
  await expect(page.getByText(/Quit MHO Studio\? The oscilloscope is disconnected and the app stops/)).toBeVisible();
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByTestId("app-stopped")).toHaveCount(0);
  await expect(page.getByTestId("link-pill")).toContainText("MHO984");
  // (Confirming is tested on a server of its own: server/test/lifetime.test.ts — this suite's server must keep running.)
});

test("updates: the dialog says what is installed; a copy run from its source folder is updated with git, not in place", async ({ page }, info) => {
  const theme = info.project.metadata.theme as string;
  await open(page, theme);
  await page.getByTestId("updates").click();
  await expect(page.getByTestId("update-dialog")).toBeVisible();
  await expect(page.getByTestId("update-installed")).toContainText(/^\d+\.\d+\.\d+/);
  await expect(page.getByTestId("update-not-installed")).toContainText("git pull");
  await expect(page.getByTestId("update-install")).toHaveCount(0);
  await axe(page, `updates (${theme})`);
  await page.getByRole("button", { name: "Close" }).click();
  await expect(page.getByTestId("update-dialog")).toHaveCount(0);
});

test("spectrum: on a narrow window the span fields stay in view; a stop above the record's reach raises it, out of ROLL too", async ({ page }, info) => {
  const theme = info.project.metadata.theme as string;
  test.skip(theme !== "midnight", "behaviour, not styling");
  await page.setViewportSize({ width: 1280, height: 800 });
  await open(page, theme, "spectrum");
  // Every toolbar control inside the toolbar, none under the inspector.
  const fits = await page.evaluate(() => {
    const tb = document.querySelector(".toolbar")!.getBoundingClientRect();
    return ["span-start", "span-stop", "span-full"].map((id) => {
      const r = document.querySelector(`[data-test=${id}]`)!.getBoundingClientRect();
      return r.left >= tb.left && r.right <= tb.right && r.bottom <= tb.bottom;
    });
  });
  expect(fits).toEqual([true, true, true]);
  // The scope in ROLL at a slow time/div: the record reaches ~1 kHz, and the view says why.
  await api(page, "control", { key: "timebase.scale", value: 0.05 });
  await api(page, "control", { key: "timebase.mode", value: "ROLL" });
  await expect(page.getByTestId("spectrum-roll")).toBeVisible({ timeout: 10_000 });
  // The live bandwidths are offered up to what the converters can do, not what ROLL samples at today.
  await expect(page.locator("[data-test=spectrum-livebw] option[value='1000000']")).toBeEnabled();
  await page.getByTestId("span-stop").fill("2M");
  await page.getByTestId("span-stop").press("Enter");
  await expect(page.getByTestId("spectrum-nyquist")).toHaveText(/^(2|2\.5|5) MHz$/, { timeout: 15_000 });
  await expect(page.getByTestId("spectrum-roll")).toHaveCount(0);
  await expect(page.getByTestId("spectrum-shown")).toContainText("2 MHz");
  await expect(page.getByTestId("spectrum-beyond")).toHaveCount(0);
});

test("spectrum full rate: memory 10k at 20 ms/div reaches 25 kHz; asking for 1 MHz raises the memory and captures again", async ({ page }, info) => {
  const theme = info.project.metadata.theme as string;
  test.skip(theme !== "midnight", "behaviour, not styling");
  await open(page, theme, "spectrum");
  // His MHO984 on 2026-10-17: one channel, 10k points, 20 ms/div → 50 kSa/s.
  await api(page, "control", { key: "channel.display@2", value: false });
  await api(page, "control", { key: "acquire.mdepth", value: "10k" });
  await api(page, "control", { key: "timebase.scale", value: 0.02 });
  await page.getByTestId("spectrum-full").click();
  await page.getByTestId("spectrum-capture").click();
  await expect(page.getByTestId("spectrum-nyquist")).toHaveText("25 kHz", { timeout: 30_000 });
  await expect(page.getByTestId("spectrum-more-memory")).toContainText("Memory 10k →");
  await page.getByTestId("span-stop").fill("1M");
  await page.getByTestId("span-stop").press("Enter");
  await expect(page.getByTestId("spectrum-nyquist")).toHaveText(/^([1-9]\d*(\.\d+)?) MHz$/, { timeout: 30_000 });
  const reach = await page.getByTestId("spectrum-nyquist").textContent();
  expect(parseFloat(reach!)).toBeGreaterThanOrEqual(1);
  await expect(page.getByTestId("spectrum-shown")).toContainText("1 MHz");
  await expect(page.getByTestId("spectrum-beyond")).toHaveCount(0);
});

test("spectrum bandwidth: a span typed or chosen, the live bandwidth raised, and a full-rate capture reaching half the sample rate", async ({ page }, info) => {
  const theme = info.project.metadata.theme as string;
  await open(page, theme, "spectrum");
  await expect(page.getByTestId("spectrum-plot").locator("canvas")).toBeVisible();
  // CH1 and CH2 are on: the card says the scope shares its 4 GSa/s, and how to get it back.
  await expect(page.getByTestId("rate-limit")).toContainText(/2 channels on: .* at most 2 GSa\/s each\. Switch the others off for 4 GSa\/s/);
  // Live: the screen record reaches 1000 / (2 × 10 × 100 µs) = 500 kHz.
  await expect(page.getByTestId("spectrum-nyquist")).toContainText(/49\d(\.\d+)? kHz|500 kHz/);
  // A span around the 5 kHz tone.
  await page.getByTestId("span-start").fill("4k");
  await page.getByTestId("span-stop").fill("6k");
  await page.getByTestId("span-stop").press("Enter");
  await expect(page.getByTestId("spectrum-shown")).toContainText(/4 kHz … 6 kHz/);
  await page.getByTestId("span-full").click();
  await expect(page.getByTestId("spectrum-shown")).toContainText(/^0 Hz … /);
  // Raise the live bandwidth to 1 MHz: the timebase becomes 50 µs/div (1000 / (2 × 10 × 50 µs) = 1 MHz).
  await page.getByTestId("spectrum-livebw").selectOption("1000000");
  await expect(page.getByTestId("spectrum-nyquist")).toContainText(/(99\d(\.\d+)? kHz|1 MHz)/, { timeout: 10_000 });
  // Full rate: the memory at the scope's own sample rate — far more bandwidth.
  await page.getByTestId("spectrum-full").click();
  await page.getByTestId("spectrum-points").selectOption(String(262_144));
  await page.getByTestId("spectrum-capture").click();
  await expect(page.getByTestId("spectrum-nyquist")).toContainText(/MHz|GHz/, { timeout: 30_000 });
  // 262 144 points at the scope's rate: the time covered and what that cannot resolve are stated.
  await expect(page.getByTestId("spectrum-covers")).toContainText(/µs|ms/);
  await expect(page.getByTestId("spectrum-lowest")).toContainText("not resolved");
  // A narrow span of the capture comes back at the record's full resolution: bins of sample rate / points.
  await page.getByTestId("span-start").fill("0");
  await page.getByTestId("span-stop").fill("1M");
  await page.getByTestId("span-stop").press("Enter");
  await expect(page.getByTestId("spectrum-shown")).toContainText(/0 Hz … 1 MHz/);
  const binText = await page.locator(".metric-row").filter({ hasText: "Bin spacing" }).locator("strong").textContent();
  const covers = await page.getByTestId("spectrum-covers").textContent();
  const sec = (t: string) => { const m = /([\d.]+)\s*(µs|ms|s)/.exec(t)!; return Number(m[1]) * ({ "µs": 1e-6, ms: 1e-3, s: 1 } as Record<string, number>)[m[2]]; };
  const hz = (t: string) => { const m = /([\d.]+)\s*(Hz|kHz|MHz)/.exec(t)!; return Number(m[1]) * ({ Hz: 1, kHz: 1e3, MHz: 1e6 } as Record<string, number>)[m[2]]; };
  // Bin spacing × time covered = 1 (zero-padding aside): the span is not compressed.
  await expect.poll(async () => hz((await page.locator(".metric-row").filter({ hasText: "Bin spacing" }).locator("strong").textContent()) ?? "") * sec(covers ?? "")).toBeLessThan(1.05);
  expect(binText).toBeTruthy();
  expect(await pageScrolls(page)).toEqual({ x: false, y: false });
  await axe(page, `spectrum-bandwidth/${theme}`);
  await page.screenshot({ path: `${shots}spectrum-full-${theme}.png` });
  // Only CH1 on: the scope's full 4 GSa/s.
  await page.getByTestId("spectrum-live").click();
  await api(page, "control", { key: "channel.display@2", value: false });
  // One channel, but AUTO memory (1 Mpts in the simulator) cannot hold 500 µs at 4 GSa/s: the card says so…
  await expect(page.getByTestId("rate-limit")).toContainText("memory must hold the whole screen", { timeout: 10_000 });
  // …and with more memory the full rate is back.
  await api(page, "control", { key: "acquire.mdepth", value: "25M" });
  await expect(page.getByTestId("rate-limit")).toContainText("At the scope's full 4 GSa/s", { timeout: 10_000 });
});

test("bode: a sweep of the simulated filter finds its 20 kHz corner", async ({ page }, info) => {
  const theme = info.project.metadata.theme as string;
  test.skip(theme !== "midnight", "one sweep is enough; the view is screenshotted in both themes below");
  await open(page, theme, "bode");
  await page.locator("#b-startHz").fill("2k");
  await page.locator("#b-stopHz").fill("200k");
  await page.locator("#b-points").fill("12");
  await page.getByTestId("bode-start").click();
  await expect(page.getByTestId("bode-corner")).toContainText(/(1[89]|2[01])(\.\d+)?kHz|(1[89]|2[01])(\.\d+)?\s*kHz/, { timeout: 90_000 });
  await expect(page.getByTestId("bode-start")).toBeVisible({ timeout: 30_000 });
  await page.screenshot({ path: `${shots}bode-${theme}.png` });
});

test("bode: the STM32 board's Si5351 drives the sweep — connect the simulated board, same corner, board put back", async ({ page }, info) => {
  const theme = info.project.metadata.theme as string;
  await open(page, theme, "bode");
  await page.getByTestId("bode-source").selectOption("clk0");
  // Start moved up to the Si5351's range; the run waits for the board.
  await expect(page.locator("#b-startHz")).toHaveValue("5000");
  await expect(page.getByTestId("bode-board-needed")).toBeVisible();
  await expect(page.getByTestId("bode-start")).toBeDisabled();
  await expect(page.getByTestId("board-port")).toContainText("Simulated board");
  await page.getByTestId("board-port").selectOption("sim");
  await page.getByTestId("board-connect").click();
  await expect(page.getByTestId("board-status")).toContainText("Simulated board");
  await expect(page.getByTestId("board-clk0")).toContainText("off");
  await axe(page, `bode with board (${theme})`);
  if (theme === "midnight") {
    await page.locator("#b-startHz").fill("2.5k");
    await page.locator("#b-stopHz").fill("200k");
    await page.locator("#b-points").fill("12");
    await page.getByTestId("bode-start").click();
    await expect(page.getByTestId("board-disconnect")).toBeDisabled(); // the sweep holds the board
    await expect(page.getByTestId("bode-corner")).toContainText(/(1[89]|2[01])(\.\d+)?\s*kHz/, { timeout: 90_000 });
    await expect(page.getByTestId("bode-start")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("bode-generator")).toContainText("STM32 board CLK0");
    await expect(page.getByTestId("board-clk0")).toContainText("off");
    await page.screenshot({ path: `${shots}bode-board-${theme}.png` });
  }
  await page.getByTestId("board-disconnect").click();
  await expect(page.getByTestId("board-connect")).toBeVisible();
});

test("bode: the board's DAC sine drives the sweep — band moved into its range, same corner, DAC idle afterwards", async ({ page }, info) => {
  const theme = info.project.metadata.theme as string;
  test.skip(theme !== "midnight", "the board card is checked in both themes above");
  await open(page, theme, "bode");
  await page.locator("#b-stopHz").fill("1M");
  await page.getByTestId("bode-source").selectOption("dac");
  await expect(page.locator("#b-stopHz")).toHaveValue("60000"); // the DAC stops at 60 kHz
  await page.getByTestId("board-port").selectOption("sim");
  await page.getByTestId("board-connect").click();
  await expect(page.getByTestId("board-dac")).toContainText("idle");
  await page.locator("#b-startHz").fill("1k");
  await page.locator("#b-points").fill("10");
  await page.getByTestId("bode-start").click();
  await expect(page.getByTestId("bode-corner")).toContainText(/(1[89]|2[01])(\.\d+)?\s*kHz/, { timeout: 90_000 });
  await expect(page.getByTestId("bode-start")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("bode-generator")).toContainText("DAC (PC4, 1 Vpp sine)");
  await expect(page.getByTestId("board-dac")).toContainText("idle");
  await page.screenshot({ path: `${shots}bode-dac-${theme}.png` });
  await page.getByTestId("board-disconnect").click();
});

test("deep memory: stop, read memory in chunks, zoomable envelope", async ({ page }, info) => {
  const theme = info.project.metadata.theme as string;
  await open(page, theme, "deep");
  await page.getByLabel("Points per channel").selectOption("1000000");
  const before = await page.evaluate(() => fetch("./api/state").then((r) => r.json()).then((s) => s.deep?.capturedAt ?? null));
  await page.getByTestId("deep-capture").click();
  await expect.poll(() => page.evaluate(() => fetch("./api/state").then((r) => r.json()).then((s) => s.deep?.capturedAt ?? null)), { timeout: 60_000 }).not.toBe(before);
  await expect(page.getByTestId("deep-plot").locator("canvas")).toBeVisible({ timeout: 60_000 });
  await expect(page.locator(".card").filter({ hasText: "Points / channel" })).toContainText("1,000,000");
  await page.screenshot({ path: `${shots}deep-${theme}.png` });
});

test("decode: the simulated UART decodes to its text", async ({ page }, info) => {
  await open(page, info.project.metadata.theme as string, "decode");
  // The burst repeats every 2 ms; a 5 ms screen always holds one (at 1 ms, ~15 % of acquisitions miss it).
  await api(page, "control", { key: "timebase.scale", value: 5e-4 });
  await page.locator("#ctl-bus\\.mode\\@1").selectOption("RS232");
  await page.getByTestId("bus-read").click();
  await expect(page.getByTestId("bus-table")).toContainText("4D");
  await expect(page.getByTestId("bus-table")).toContainText("48");
});

test("console: a query answers; an unknown command shows the instrument's error", async ({ page }, info) => {
  await open(page, info.project.metadata.theme as string, "console");
  const input = page.getByTestId("console-input");
  await input.fill(":TIMebase:MAIN:SCALe?");
  await input.press("Enter");
  await expect(page.getByTestId("console-log")).toContainText("1.000000E-04");
  await input.fill(":NOT:REAL 1");
  await input.press("Enter");
  await expect(page.getByTestId("console-log")).toContainText("-100");
});

test("instrument and all settings: options, screenshot, search across the whole command set", async ({ page }, info) => {
  const theme = info.project.metadata.theme as string;
  await open(page, theme, "instrument");
  await expect(page.locator(".opt").filter({ hasText: "AFG100" })).toContainText("installed");
  await page.getByRole("button", { name: "Screenshot of the instrument's display" }).click();
  await expect(page.getByTestId("screenshot-img")).toBeVisible();
  await page.keyboard.press("Escape");
  await page.screenshot({ path: `${shots}instrument-${theme}.png` });
  await page.getByTestId("nav-settings").click();
  await page.getByTestId("settings-search").fill("holdoff");
  await expect(page.locator("[data-ctl='trigger.holdoff']")).toBeVisible();
  await axe(page, `settings/${theme}`);
});

test("fold: every control the interface names is on screen at laptop sizes", async ({ page }, info) => {
  test.skip(info.project.metadata.theme !== "midnight", "layout is theme-independent");
  const init = (ui: Record<string, unknown>) => async (p: Page) => {
    await p.evaluate((u) => localStorage.setItem("mho-studio.ui", JSON.stringify(u)), ui);
    await p.reload();
    await expect(p.getByTestId("link-pill")).toContainText("MHO984");
  };
  const r = await foldProbe(page, {
    url: "/",
    resetState: false,
    cases: [
      { name: "scope", load: init({ view: "scope", section: "vertical" }), must: ["[data-test=runstop]", "[data-test=scope-screen]", "[data-test=sec-trigger]", "[data-test=scope-foot]", "#ctl-channel\\.scale\\@1"] },
      { name: "measure", load: init({ view: "scope", section: "measure" }), must: ["[data-test=measure-add]"] },
      { name: "bode", load: init({ view: "bode" }), must: ["[data-test=bode-start]", "#b-startHz", "#b-settleMs"] },
      { name: "deep", load: init({ view: "deep" }), must: ["[data-test=deep-capture]"] },
      { name: "console", load: init({ view: "console" }), must: ["[data-test=console-input]"] },
    ],
  });
  expect(r.failures).toEqual([]);
  for (const vp of [{ width: 1366, height: 768 }, { width: 1440, height: 900 }]) {
    await page.setViewportSize(vp);
    expect(await clippedElements(page, [".app-header > *", ".toolbar > *", ".status-bar"])).toEqual([]);
  }
});

test("connect screen: LAN, USB and simulator tabs; USB lists what is plugged in", async ({ page }, info) => {
  test.skip(info.project.metadata.theme !== "midnight", "one pass is enough");
  await open(page, "midnight");
  await api(page, "disconnect");
  await expect(page.getByTestId("connect-card")).toBeVisible();
  await page.getByTestId("tab-usb").click();
  // No USB instrument the suite may use: the tab must say so rather than fail.
  await expect(page.getByTestId("usb-tab")).toContainText(/No USB-TMC instrument is connected|USB support did not load/);
  await expect(page.getByTestId("usb-tab")).toContainText(/macOS|Windows|Linux/);
  await page.screenshot({ path: `${shots}connect-usb.png` });
  // The suite runs with real USB switched off (it must never touch a scope plugged into this computer):
  // the tab says so, and connecting over USB is not offered.
  await expect(page.getByTestId("usb-tab")).toContainText("USB support did not load");
  await expect(page.getByTestId("usb-connect-first")).toBeDisabled();
  await page.getByTestId("tab-sim").click();
  await page.getByTestId("use-sim").click();
  await expect(page.getByTestId("link-pill")).toContainText("MHO984");
});

test("LeCroy: the simulated X-Stream over VICP — traces, family-only views, console, accessible", async ({ page }, info) => {
  const theme = info.project.metadata.theme as string;
  await open(page, theme);
  await api(page, "disconnect");
  await expect(page.getByTestId("connect-card")).toBeVisible();
  await page.getByTestId("tab-lan").click();
  await page.getByTestId("brand-lecroy").click();
  await expect(page.locator("#port")).toHaveValue("1861");
  await expect(page.getByTestId("connect-card")).toContainText("TCPIP (VICP)");
  await page.getByTestId("tab-sim").click();
  await page.getByTestId("use-sim-lecroy").click();
  try {
    await expect(page.getByTestId("link-pill")).toContainText("WM8ZI-A");
    await expect(page.getByTestId("legend")).toContainText("100 mV/div");
    await expect.poll(() => tracePixels(page, "ch1")).toBeGreaterThan(400);
    await expect.poll(() => tracePixels(page, "ch2")).toBeGreaterThan(200);
    // A LeCroy has no built-in generator or bus decoder: those views and sections are not offered.
    await expect(page.getByTestId("nav-bode")).toHaveCount(0);
    await expect(page.getByTestId("nav-decode")).toHaveCount(0);
    await expect(page.getByTestId("sec-generator")).toHaveCount(0);
    // Name a channel: it shows in the app and is sent to the scope (LabelsText, ViewLabels on).
    await page.getByTestId("sec-vertical").click();
    await page.getByRole("textbox", { name: "Name", exact: true }).fill("VIN");
    await page.getByRole("textbox", { name: "Name", exact: true }).press("Enter");
    await expect(page.getByTestId("legend")).toContainText("CH1 · VIN");
    await expect(page.getByTestId("chan-name-1")).toHaveText("VIN");
    // Trigger types from the automation manual, each with its own fields.
    await page.getByTestId("sec-trigger").click();
    await page.getByRole("combobox", { name: "Trigger type" }).selectOption("Width");
    await expect(page.locator(".inspector")).toContainText("Lower limit");
    await page.getByRole("combobox", { name: "Trigger type" }).selectOption("Logic");
    await expect(page.locator(".inspector")).toContainText("CH4 threshold");
    await page.getByRole("combobox", { name: "Trigger type" }).selectOption("Edge");
    await page.screenshot({ path: `${shots}lecroy-${theme}.png` });
    await axe(page, "lecroy scope");
    await page.getByTestId("nav-console").click();
    const box = page.getByRole("textbox", { name: "SCPI command" });
    await box.fill("VBS? 'return=app.Acquisition.Horizontal.SamplingRate'");
    await box.press("Enter");
    await expect(page.locator("main")).toContainText("40000000000");
    // The scope's own FFT: the 10 MHz sine is the top peak.
    await page.getByTestId("nav-spectrum").click();
    await page.getByTestId("spectrum-scope").click();
    await expect(page.locator("main")).toContainText(/10\.0\d* MHz/);
    await page.getByTestId("nav-scope").click();
  } finally {
    await api(page, "connect", { sim: true, simModel: "rigol" });
  }
  await expect(page.getByTestId("link-pill")).toContainText("MHO984");
});

test("Teledyne T3DSO1204: picked on the LAN tab or the simulator, 14-division screen, its trigger panel, console, screenshot, edge capture", async ({ page }, info) => {
  const theme = info.project.metadata.theme as string;
  await open(page, theme);
  await api(page, "disconnect");
  await expect(page.getByTestId("connect-card")).toBeVisible();
  // LAN: the T3DSO speaks raw SCPI on port 5025, and the help says how to address a direct cable.
  await page.getByTestId("tab-lan").click();
  await page.getByTestId("brand-siglent").click();
  await expect(page.locator("#port")).toHaveValue("5025");
  await expect(page.getByTestId("siglent-help")).toContainText("no router");
  await page.getByTestId("tab-sim").click();
  await page.getByTestId("use-sim-siglent").click();
  try {
    await expect(page.getByTestId("link-pill")).toContainText("T3DSO1204");
    await expect.poll(() => tracePixels(page, "ch1")).toBeGreaterThan(400);
    await expect.poll(() => tracePixels(page, "ch2")).toBeGreaterThan(200);
    // No generator, decoder or Bode on it.
    await expect(page.getByTestId("nav-bode")).toHaveCount(0);
    await expect(page.getByTestId("nav-decode")).toHaveCount(0);
    await page.getByTestId("sec-horizontal").click();
    await expect(page.locator(".inspector")).toContainText("14 divisions wide");
    await expect(page.locator(".inspector")).not.toContainText("Zoom (delayed timebase)");
    await page.getByTestId("sec-trigger").click();
    await expect(page.getByRole("combobox", { name: "Trigger type" })).toHaveValue("EDGE");
    await expect(page.locator(".inspector")).toContainText("Source");
    expect(await pageScrolls(page)).toEqual({ x: false, y: false });
    await axe(page, `t3dso scope/${theme}`);
    await page.screenshot({ path: `${shots}t3dso-${theme}.png` });
    await page.getByTestId("nav-console").click();
    const box = page.getByRole("textbox", { name: "SCPI command" });
    await box.fill("TDIV?");
    await box.press("Enter");
    await expect(page.locator("main")).toContainText("2.00E-07");
    await page.getByTestId("nav-instrument").click();
    await expect(page.locator("main")).toContainText("Teledyne T3DSO / Siglent SDS1000X-E");
    await expect(page.locator("main")).not.toContainText(":SYSTem:OPTion:STATus?");
    // Edge capture on its clock (CH2): 14 divisions, trigger one from the left.
    await page.getByTestId("nav-edges").click();
    await page.getByTestId("burst-trigger").selectOption("2");
    await page.getByTestId("burst-level").fill("1.65");
    await page.getByTestId("burst-window").selectOption(String(10e-6));
    await page.getByTestId("burst-ch-1").uncheck();
    await page.getByTestId("burst-ch-2").check();
    await page.getByTestId("burst-start").click();
    await expect(page.getByTestId("burst-status")).toContainText("done", { timeout: 30_000 });
    await expect(page.getByTestId("burst-result-2")).toContainText(/CH2 · (1[3-5]|2[5-9]|30) rising/);
  } finally {
    await api(page, "connect", { sim: true, simModel: "rigol" });
  }
  await expect(page.getByTestId("link-pill")).toContainText("MHO984");
});

test("all-measure set on the scope: every parameter of that channel is listed under the screen, computed here", async ({ page }, info) => {
  const theme = info.project.metadata.theme as string;
  await open(page, theme);
  // As if chosen on the instrument: the app sees it with its next watch and starts reading the table.
  await api(page, "control", { key: "measure.amsource", value: "CHANnel1" });
  const grid = page.getByTestId("all-measure");
  await expect(grid).toContainText("All measurements · CH1", { timeout: 10_000 });
  await expect(page.getByTestId("all-measure-note")).toContainText("no extra commands to the scope");
  await expect(page.getByTestId("all-VPP")).toContainText(/2(\.0+)? V|1\.9\d* V|2\.0\d* V/);
  await expect(page.getByTestId("all-FREQuency")).toContainText(/5(\.0+)? kHz|4\.99\d* kHz|5\.00\d* kHz/);
  expect(await pageScrolls(page)).toEqual({ x: false, y: false });
  await axe(page, `all-measure/${theme}`);
  await page.screenshot({ path: `${shots}all-measure-${theme}.png` });
  await api(page, "control", { key: "measure.amsource", value: "OFF" });
  await expect(grid).toHaveCount(0, { timeout: 10_000 });
});

test("edge capture: one trigger on the clock, every edge's rise time listed, CSV offered", async ({ page }, info) => {
  await open(page, info.project.metadata.theme as string, "edges");
  // Segments need a LeCroy's sequence mode: not offered on the RIGOL.
  await expect(page.getByTestId("burst-segments")).toBeDisabled();
  await page.getByTestId("burst-trigger").selectOption("3");
  await page.getByTestId("burst-level").fill("1.65");
  await page.getByTestId("burst-window").selectOption(String(10e-6));
  await page.getByTestId("burst-ch-1").uncheck();
  await page.getByTestId("burst-ch-3").check();
  await page.getByTestId("burst-start").click();
  await expect(page.getByTestId("burst-status")).toContainText("done", { timeout: 30_000 });
  const card = page.getByTestId("burst-result-3");
  await expect(card).toContainText(/CH3 · (19|20|21) rising/i);
  // The simulated clock's edges: about 4.9 ns 10–90 %.
  await expect(page.getByTestId("burst-rise")).toContainText(/4\.[6-9]\d* ns|5\.[0-2]\d* ns/);
  await expect(page.getByTestId("burst-edges").locator("tbody tr").first()).toBeVisible();
  await expect(page.getByTestId("edges-csv")).toHaveAttribute("href", "./api/burst/edges.csv");
  await axe(page, `edges/${info.project.metadata.theme}`);
  await page.screenshot({ path: `${shots}edges-${info.project.metadata.theme}.png` });
  await api(page, "measure/reset");
  await api(page, "console", { cmd: ":RUN" });
});

test("edge capture on a LeCroy: several segments, glitches, histogram, setup and hold against a clock", async ({ page }, info) => {
  const theme = info.project.metadata.theme as string;
  await open(page, theme, "edges");
  await api(page, "connect", { sim: true, simModel: "lecroy" });
  try {
    await expect(page.getByTestId("link-pill")).toContainText("WM8ZI-A");
    await expect(page.getByTestId("burst-segments")).toBeEnabled();
    await page.getByTestId("burst-trigger").selectOption("2");
    await page.getByTestId("burst-level").fill("1.65");
    await page.getByTestId("burst-window").selectOption(String(10e-6));
    await page.getByTestId("burst-segments").fill("3");
    await page.getByTestId("burst-ch-1").uncheck();
    await page.getByTestId("burst-ch-3").check();
    // Every 500 ns pulse of the 1 MHz clock is narrower than 600 ns: all of them are glitches by this rule.
    await page.getByTestId("burst-glitch").fill("600 ns");
    await page.getByTestId("burst-timing").check();
    await page.getByTestId("burst-clock").selectOption("2");
    await page.getByTestId("burst-setup-min").fill("1 us");
    await page.getByTestId("burst-start").click();
    await expect(page.getByTestId("burst-status")).toContainText("done", { timeout: 60_000 });
    await expect(page.getByTestId("burst-segments-card")).toContainText("3 triggers recorded");
    const clock = page.getByTestId("burst-result-2");
    await expect(clock).toContainText(/CH2 · (5[7-9]|6[0-3]) rising/);
    await expect(page.getByTestId("burst-glitches")).toContainText("glitches");
    await expect(page.getByTestId("burst-high")).toContainText(/(49\d|50\d)(\.\d+)? ns/);
    await expect(page.getByTestId("burst-segtable").locator("tbody tr")).toHaveCount(3);
    await expect(page.getByTestId("burst-hist")).toBeVisible();
    await expect(page.getByTestId("burst-slowest").locator("tbody tr")).toHaveCount(10);
    await expect(page.getByTestId("anomalies-csv")).toHaveAttribute("href", "./api/burst/anomalies.csv");
    await page.getByTestId("burst-tab-timing").click();
    await expect(page.getByTestId("burst-timing-result-3")).toContainText("against the CH2 clock");
    await expect(page.getByTestId("burst-violations")).toContainText(/setup < 1 µs: \d+/);
    await expect(page.getByTestId("burst-timing-rows").locator("tbody tr").first()).toBeVisible();
    await expect(page.getByTestId("timing-csv")).toHaveAttribute("href", "./api/burst/timing.csv");
    expect(await pageScrolls(page)).toEqual({ x: false, y: false });
    await axe(page, `edges-lecroy/${theme}`);
    await page.screenshot({ path: `${shots}edges-lecroy-${theme}.png` });
    await page.getByTestId("burst-tab-ch2").click();
    await page.screenshot({ path: `${shots}edges-lecroy-ch2-${theme}.png`, fullPage: true });
  } finally {
    await api(page, "connect", { sim: true, simModel: "rigol" });
  }
});
