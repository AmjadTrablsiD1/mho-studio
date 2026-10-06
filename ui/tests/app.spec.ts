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
  await expect(table).toContainText(/Frequency(5|4\.99\d*|5\.00\d*)kHz/);
  await expect(table).toContainText(/Peak-peak2\.0\d*V/);
  await expect(table.locator(".badge").first()).toBeVisible();
  await page.screenshot({ path: `${shots}measure-${theme}.png` });
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
  // This machine has no USB instrument: the tab must say so rather than fail.
  await expect(page.getByTestId("usb-tab")).toContainText(/No RIGOL or USB-TMC device is connected|USB support did not load/);
  await expect(page.getByTestId("usb-tab")).toContainText(/macOS|Windows|Linux/);
  await page.screenshot({ path: `${shots}connect-usb.png` });
  await page.getByTestId("usb-connect-first").click();
  await expect(page.locator(".toast.error")).toContainText(/No RIGOL or USB-TMC instrument is connected by USB/);
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
