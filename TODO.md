# TODO

## Done

- Command registry generated from the MHO900 Programming Guide: 655 commands, 596 exposed as fields, each traceable to its § number (`scripts/gen-manual-index.ts`, `core/src/registry/`).
- Raw-SCPI client over TCP 5555 with #N block framing, strict request/reply, exclusive sections, timeouts that drop the link, automatic reconnect, and the macOS Local Network `nc` fallback from Pluto Studio.
- Live screen: all four channels and math, 1000-point WORD records at ~20 screens/s on the simulator, drag offsets / trigger level / trigger position, wheel for s/div and V/div, time and voltage cursors, persistence, hover read-out.
- Read-back after every write, with "asked X — instrument set Y" and the error queue shown at the field.
- Confirmations for generator output on, 50 Ω input, *RST, restart, autoset, setup load, preset recall.
- Inspector: vertical, horizontal (incl. zoom/XY), trigger (all 20 types, each showing only its fields), acquire, measure, math (incl. FFT/filter), generator (incl. AM/FM/PM), counter and voltmeter.
- Measurements: all 41 items, running statistics, and an independent cross-check computed from the screen record.
- Spectrum: windowed FFT with stated scaling, power averaging, peak list, THD that refuses a too-coarse spectrum; from the live screen or from deep memory.
- Bode sweep with the built-in generator (lock-in phasors, auto-ranging, settings restored); CSV export.
- Deep memory: stop, read up to 25 Mpts/channel in chunks, zoomable min/max envelope, measurements of the visible range, CSV of visible/all.
- Decode: bus 1–4 configuration for every protocol, event-table read-out and CSV; logic-analyser set-up (enable, labels, thresholds, pods).
- Instrument: identity, installed options, link diagnostics, presets (instrument setup files) on disk, setup download/upload, clock sync, system settings, reset actions.
- All-settings browser and search over the entire command set; SCPI console with completion from the guide and history.
- Screenshot of the instrument's display (PNG) with save.
- Network discovery (connect scan of the local /24 for *IDN? on 5555).
- Simulated MHO984 on TCP with a bench (generator → filter, clock, UART), modelling acquisition, trigger, WORD/BYTE/ASCII transfer, RAW memory, measurements, counter, DVM, bus table, screenshots.
- Tests: 32 core (two worked examples per formula), 9 service tests over TCP against the simulator, 13 Playwright UI flows in both themes (24 runs) with axe and the fold probe at 1366×768 and 1440×900.
- Launchers: `.command`, `.app`, App Launcher tile, `.bat` (untested).
- USB-TMC link on the rear USB Device port (`server/usbtmc.ts`), with reconnect on replug and remembered for the next launch; tested over a virtual USB-TMC device.
- Discovery also finds a scope on a direct cable (mDNS for LXI services + the ARP table), not only on ordinary /24 networks.

- Fixed after the first session on the real MHO984 over USB (2026-09-26): an unanswered query no longer drops the link or crashes the server; leftover replies from an earlier session are cleared; unanswered queries are learned per firmware; the settings watch is batched into compound queries; a server log.

## Done (0.2.0, 2026-10-06)

- **Teledyne LeCroy X-Stream support over VICP.** Driver layer (`server/drivers/`), family chosen from `*IDN?`; VICP framing with sequence numbers; WAVEDESC decoding; LeCroy registry with the common settings; PAVA measurements with cross-check; sparsed live screen; chunked deep memory; SCDP screenshots; PNSU setups; VBS from the console; simulated LeCroy over VICP; LAN tab protocol choice; discovery over VICP; views and sections hidden where the family lacks the feature; presets refuse to load on a different model. 27 new tests (core, service over VICP, one UI flow in both themes).

## Done (0.2.1, 2026-10-06)

- **LeCroy, fuller:** all eight trigger types of the X-Stream automation manual with their fields; holdoff; channel names (on the scope's screen and in the app); deskew, interpolation, bandwidth limit via automation; sampling mode, sequence segments, interleave, memory management; draggable trigger position; level to 0 V, clear sweeps. Property names checked against the June 2003 WaveMaster / WavePro 7000 automation manual.
- **Windows 10 / 11:** `install-windows.bat` / `.ps1` (Node check, build, copy to %LOCALAPPDATA%, Desktop and Start-menu shortcuts); `run-mho-studio.bat` rewritten; cross-platform `npm test`; a Windows path bug in the UI tests fixed; `.github/workflows/ci.yml` runs everything on Windows and macOS.

## Done (0.2.2, 2026-10-06)

- Grouped LeCroy reads (one VBS line per watch cycle; fallback and relearning when a model lacks a property; decimal-comma locale).
- Scope FFT (LeCroy F8) in the Spectrum view, analysed by the app.
- LeCroy deep memory as bytes for 8-bit data.
- `npm run typecheck` for server, simulators and core, in CI; two old type errors fixed (a `pipe` field shadowing Duplex.pipe in the USB stream; an untyped JSON reply).
- Single-file `MHO Studio.exe` (packaging/build-exe.mjs, Node SEA), built and run in CI on Windows, published as an artifact; checked on macOS here.
- The occasional first-UI-test failure: not reproduced in 7 full runs; CI now keeps failure traces.
- Measurements are editable after adding: quantity and channel(s) change in place (table and inspector), statistics restart, readings in flight for the old setting are discarded; "+ Measurement" / "+ Add" buttons.

## Done (0.3.0, 2026-10-07)

- **Edge capture** (Edge capture view, `server/burst.ts`, `core/src/dsp/edges.ts`): one trigger, wait up to N s, record a window, every edge's 10–90 % / 90–10 % time and time from the trigger, statistics, scatter, list, CSV; both families; flags under-sampled edges and channels clipped off the screen. Tested on both simulators (the clock's true 4.95 ns edges) and in the UI.
- RIGOL deep memory read past the end of the record when the depth setting exceeded rate × span (found by the edge capture): fixed.
- LeCroy simulator: Normal / Single wait for a real crossing; Single triggers when polled.

## Done (0.3.1, 2026-10-07)

- **WaveRunner 640Zi** (the lab's scope) checked against its datasheet and LeCroy's X-Stream Remote Control Manual (WM-RCM-E rev D): VICP supported; CHDR/CFMT/CORD, WFSU, WF? with headers off, CPL values (and OVL on a 50 Ω overload, now shown), MSIZ, INR bit 0 = new acquisition, CMR/EXR, HCSU/SCDP, PAVA format and names, VBS — as implemented. Fixed from the manual: PWID/NWID do not exist (WID does); screenshot setup made explicit (DEST,REMOTE,AREA,DSOWINDOW).
- Windows .exe cross-built on macOS (`--target win-x64`, official node.exe, SHA-256 checked); structure verified (PE32+, SEA fuse set, blob resource present) — not yet run on Windows.

## Done (0.3.2, 2026-10-12)

- **Edge capture, deeper:** pulse widths (high and low, 50 % to 50 %); glitches (pulses narrower than a set width) and runts (past 50 %, back before 90 %), listed with time, width and how far they got; histograms of every rise and fall time and the five slowest edges of each with how many σ above the mean; **setup and hold** of data lines against a clock's rising or falling edges, with the worst of each, optional required values and violation counts; CSV of edges, glitches/runts and setup/hold. Running statistics use Welford's update (σ of picoseconds on milliseconds no longer collapses to 0). Hand-checked core tests for runts, glitches, histograms and setup/hold.
- **Segments (LeCroy sequence mode):** N triggers in one Single, each its own segment with its trigger time (TRIGTIME array); every segment analysed on its own, statistics merged, a per-segment table. The simulator models sequence mode (each segment waits for the next crossing after the record and a 1 µs re-arm). Offered on LeCroy only.
- **Live view, fewer round trips:** RIGOL reads each source's preamble again only after a setting changed or every `loops.preamble_max_age_ms` (500 ms; also when the data length disagrees), and does not resend unchanged `:WAVeform:` settings — one query per channel per screen instead of two. LeCroy no longer resends the same `WFSU` every frame and reads the record size once for all channels. The console invalidates both caches. Tests pin the per-frame traffic.
- The off-screen test used the CH4 UART, whose 20 µs window can be all low (then it does fit the screen): moved to the CH3 square — a flaky server test fixed.
- Result columns whose content overflowed squeezed rows with clipped items to nothing (the result tab bar became 2 px and unclickable): rows are content-sized in the Edge capture, Deep memory, Spectrum and Bode columns.

## Done (0.4.0, 2026-10-14)

- **Teledyne T3DSO1000 (T3DSO1204) driver** (`server/drivers/siglent.ts`, `core/src/registry/siglent.ts`, `core/src/scpi/siglent.ts`): raw SCPI on 5025 or USB-TMC; channels, timebase and trigger delay, memory, acquisition, trigger type/source/level/slope/coupling, run/stop/single/force/autoset, 23 PAVA measurements, screenshots (BMP → PNG), setups (XML), deep memory, edge capture, console list. Every reply format was taken from a real T3DSO1204 (fw 8.3.6.1.37R8) over USB; its replies are kept as test fixtures (`core/test/fixtures/t3dso1204/`). Simulated T3DSO1204 (`sim/siglent.ts`, `--siglent`).
- Why it failed on 2026-10-14: over **LAN** the computer's adapter had a self-assigned 169.254.x address, so 10.11.13.220 was routed to the office network (connect help now says how to address a direct cable); over **USB** the app took it for a LeCroy X-Stream ("Lecroy," in *IDN?) and sent X-Stream commands, read the empty transfer that follows each block as a broken reply and dropped the link, and kept the interface claimed afterwards. Fixed: family by model; empty transfers skipped; the release retried; double newlines after a block and text before it handled; a raw BMP read by its own length.
- Screen grid, edge capture and record length use the family's division count (14 on a T3DSO); inspector, console, instrument, deep and spectrum views take family facts from the registry instead of "LeCroy or not".

## Done (0.5.3, 2026-10-18)

- **`main` is the release branch** (fast-forwarded to the work of `lecroy-and-windows`); the updater follows `main` on every copy, whatever branch it was installed from.
- **Installing on another Mac asked for Xcode:** on a Mac without the command line developer tools, `/usr/bin/git` and `/usr/bin/python3` are placeholders that pop up the Xcode install dialog, and `install.sh` ran both (the build stamp and the App Launcher tile). They are now used only when real (and the tile only where App Launcher is installed). New double-clickable **`Install MHO Studio.command`** in the repo: checks Node (opens nodejs.org if missing), runs `install.sh`, starts the app. Checked with a temporary home and `xcode-select` failing: no developer tool was run, the copy started.

## Done (0.5.1, 2026-10-17)

- **The MHO984 lost its USB link every ~10 s and the app showed wrong settings** (time/div empty, sample rate "0.05", CH1 bandwidth limit = `0,"No error"`) — found by recording the running app's traffic while it happened. Cause: the exclusive-section marker leaked through Node's async context into the timer that declares a USB link lost, so the reconnect and the live loop it started ran as if they held the line; their queries interleaved with settings reads and every reply belonged to the previous question. Each starved query then timed out and lost the link again. Fixed in `ScpiClient.exclusive()` (a section id that counts only while that section holds the line; `onClose` outside any section), with tests that reproduce both leaks. This was also the unexplained 10 s reconnect loop of 2026-10-16 and the "OMEG" of 0.4.1.
- **Updates from inside the app** (⤓ in the header): installed copies know their branch and commit (`build.json`, written by both installers); the app compares them with the branch on GitHub, lists the new commits, and Update downloads the commit, checks it, runs the installer detached and opens the new version. Never offers an older version (a copy with unpushed changes says so). Daily read-only check at start-up, switchable. Not for a source-folder copy (git pull) or the .exe. Tested against a fake GitHub (`server/test/update.test.ts`); **the real Windows path (PowerShell runner, shortcut restart) is unrun**.
- **Closing the app ends the connection.** Closing the browser window used to leave the server running and connected to the scope (and holding the board's serial port) with no way to quit. Now the server disconnects and stops ~20 s after the last window closes (a reload or wake-up within that keeps it; a running sweep or capture is finished first), and **⏻ Quit** does it at once. `--stay` for the test suite and development.
- **Spectrum: a stop frequency typed before the first spectrum arrived did nothing** (seen as a flaky UI test in ROLL, where the first screen takes a while): the live reach now follows from the time/div until then.
- **Full-rate spectrum stopped at ~20 kHz on the real MHO984:** Memory depth was 10k at 20 ms/div, so the scope sampled at 50 kSa/s (memory ÷ screen time). Asking for a higher stop frequency in Full rate now raises the memory depth to the smallest that reaches it (within the channel limit and the per-channel memory) and captures again; the Bandwidth card offers the same as a button (`Memory 10k → …`).
- **LAN on a direct cable:** when an address cannot be reached because this computer has no address in its network (a direct cable: the adapter self-assigns 169.254.x.x while the scope keeps a static address), the connect error now says so, names the adapter and gives the address to set (`networkHint` in `server/discover.ts`). Both sides self-assigned: it says macOS may route that out of Wi-Fi.
- **Spectrum:** the Start/Stop span fields were pushed under the inspector on a window narrower than ~1500 px (the toolbar now wraps to a second line). A stop frequency above what the live record reaches now raises it — a faster time/div, and out of ROLL first — instead of drawing an empty axis; the ceiling is the converters' rate for the channels on (4/2/1 GSa/s), not today's rate. The live-bandwidth choices are offered up to that ceiling too: in ROLL every one was disabled. ROLL mode and a span beyond the record are explained in the Bandwidth card.

## Done (0.5.0, 2026-10-16)

- **Bode with the STM32H743 board's Si5351 as the generator** (steps 1–4 of `docs/bode-with-stm32-generator.md`). The sweep asks a `Generator` (`server/generators.ts`) for a frequency and plots the one it reports back: the scope's GEN OUT (as before) or a board CLK output. The board link (`server/board.ts`, packets in `core/src/board/protocol.ts`): exclusive serial port via the optional `serialport` package, speed probed 115200–921600, protocol ≥ v16, one command in flight, late ACKs ignored, the firmware's printf log kept apart. The sweep holds the board; its output (frequency, on/off, drive) is put back afterwards. The channels are AC-coupled for the board's 0–3.3 V square. New for both generators: the sweep stops at the first point if the input channel does not repeat at the generator's frequency (not wired). Simulated board (`sim/board.ts`) wired onto the simulated bench (`sim/wiring.ts`); `MHO_STUDIO_NO_SERIAL` keeps every test off real serial ports. Bode view: Generator = Scope GEN 1/2 or Board CLK0–2, drive, and a Board card (port, connect, firmware, Si5351, Detect with crystal and load, the three outputs, the firmware's last log lines).
- **The board's DAC sine as a third Bode generator** (Board DAC PC4: DAC1 through OPAMP1, 1 Hz – 60 kHz, ≤ 3 Vpp on 1.65 V; `DacSine`/`DacPlay`/`DacStatus`). Its frequency is the timer's rate over the table length, so the sweep plots the reply's frequency; a reply far from the request (the firmware clamps rather than refuses) stops the sweep. Afterwards the DAC is stopped; what it played before is named in the result, not restarted (its levels are not reported). Busy (a Loop Bench run or the board's own sweep) is refused in words. Choosing it moves the band and amplitude into its range.

## Done (0.4.6, 2026-10-16)

- The Spectrum's Bandwidth card says why the MHO984 samples below 4 GSa/s: channels share the converters (4 / 2 / 1 / 1 GSa/s with 1 / 2 / 3 / 4 on), and the memory must hold the whole screen. The simulated MHO984 rounded every rate to 1-2-5, so it could never show 4 GSa/s (the real one reports 4.000000E+9): its maximum is now kept exact.

## Done (0.4.5, 2026-10-16)

- **Spectrum bandwidth, adjustable.** A span (start / stop typed with units, or dragged on the plot; Full resets). **Live bandwidth up to…** sets the time/div so the screen record reaches it (screen points ÷ (2 × divisions × time/div)). **Full rate** reads 64 k–4 M points of the record at the scope's own sample rate (bandwidth = sample rate ÷ 2) and the server returns the span shown at the record's full resolution (`deep.analyse` fmin/fmax; at most `spectrum.max_bins_sent` values, peaks inside the span). The Bandwidth card states the span, what the record reaches, its sample rate, RBW, the signal time analysed and the lowest frequency it resolves. Level range moved out of the crowded toolbar.

## Done (0.4.3, 2026-10-16)

- **0.4.4:** the all-measure table is computed by the app from the screen record instead: asking each item with `:MEASure:ITEM?` cost ~35 queries a refresh and put every item on the scope's own measurement list (he saw them appear). New "Show only these on the scope" (Measure panel) makes the scope's list exactly the app's — it clears what 0.4.3 added.
- (superseded by 0.4.4) **The scope's "all measure" table in the app.** With an All-measure source chosen (on the scope or in Measure → All-measure), the app reads every single-source parameter of that channel with `:MEASure:ITEM?` (8 per message, every `measure.all_period_ms`) and lists them under the screen and in the Measure panel. `measure.amsource` is now read at connect and watched, so a choice made at the scope shows within a few seconds. The guide has no query for the whole table.

## Done (0.4.2, 2026-10-16)

- **A USB scope that stops answering even *IDN?** (the MHO984 after the link losses of 0.4.0) gets its USB port reset once while connecting, then the connection is tried again (`resetUsb`; it took a manual reset on 2026-10-16). Only for a device the app opened itself.
- **Measurements survive a reconnect and a restart**: the list is saved per instrument (model + serial, `measurements.json` in the config folder) and the instrument is set to show exactly it again. The first measurement added to an empty list clears what the instrument still showed (the app showed 1, the scope 3).
- **Tests never touch real USB** (`MHO_STUDIO_NO_USB` in every service test and the UI suite): a USB test could otherwise have reached — and reset — a scope plugged into the computer running them.

## Done (0.4.1, 2026-10-16)

- **MHO984 over USB dropped the link, then talked nonsense, when settings were changed quickly** (found with a recording of the app's traffic on the real scope). Cause, in order: after quick timebase changes while stopped, the scope left one `:WAVeform:DATA?` unanswered (its own behaviour); the USB clear that follows answered "pending" for ~7 s, longer than the client's backstop, so the link was given up; and the old link, finishing its clear after the reconnect, reported "no reply" into the new link's first query — every answer after it belonged to the question before (`:CHAN1:SCAL?` → "OMEG"). Fixed: the clear has a 2 s budget (`usb.clear_budget_ms`), a closed USB stream reports nothing, and the client ignores every event from a link that has been replaced; the T3DSO's empty-transfer retries share the reply's time limit. Tests copy the scope's behaviour (virtual USB device with an unanswered query and a slow clear; a replaced link's late report).

## Doing

- Nothing in progress.

## Next

00000. **Bode with the real STM32 board** (step 5 of `docs/bode-with-stm32-generator.md`). **DAC too:** an RC with fc ≈ 1 kHz (R = 1.6 kΩ, C = 100 nF) from PC4, 1 Vpp: corner and −45° within a few %, and the DAC's reported frequencies against the scope's own counter on CH1; a CLK sweep and a DAC sweep of the same circuit should overlap between 2.5 and 60 kHz. Board COM port on this Mac, Board Test GUI closed. Connect in Bode → Board: the port is found as CH340, the speed, firmware and protocol shown; Detect finds the Si5351 at 0x60 (check the crystal and load match the module). A known RC low-pass (R = 1.6 kΩ, C = 1 nF, fc ≈ 100 kHz) with a 10:1 divider after CLK0, CH1 after the divider, CH2 on C: the −3 dB point and −45° within a few % of 1/(2πRC); the same circuit with GEN OUT (if the AFG option is there) overlaps where the ranges meet. Watch for: DTR/BOOT0 (the board must not drop into DFU when the app connects or the board is reset), PLL relock glitches at a frequency step (raise Settle if early points scatter), ringing on the CLK edges into CH1 above a few MHz (terminate, 10× probes), the time per point. Then Windows: the CH340 driver, COM-port naming, `serialport` installed by `install-windows.ps1`.
0000. **First full session on the T3DSO1204** (USB or LAN). Connect and check, in this order: traces overlay the scope's own screen (Screenshot) at a few V/div, offsets and timebases; **the sign of TRDL** — set Trigger delay to +2 div and see the trigger point move right of centre on both; **whether WFSU SP is honoured** on a long record (Horizontal 1 ms/div: the log says "WFSU SP… ignored" if not, and the screen is then thinned in the app — slower); a deep capture of 7 or 14 Mpts and its speed (lower `siglent.deep_chunk_points` if a chunk times out); PNSU setup save and **restore** (restore is untested on hardware); SCDP over LAN; an edge capture of the probe-compensation output against the scope's own RISE; trigger types other than Edge (TRSE syntax for GLIT/INTV/RUNT/DROP holdoff fields); whether `C1:BWL` or `BWL C1,ON` is the form it takes. Record what differs in `sim/README.md` and make `sim/siglent.ts` match.

000. **First run on the Windows 11 PC: what failed on 2026-10-07 is not known yet** (asked). Likely causes: GitHub's default branch `main` is still the RIGOL-only 0.1; the installer needs Node 22.18+ and internet for npm; no .exe was available.
00. **Windows:** the first CI run on windows-latest (2026-10-06, commit de1869d) passed the server tests, type check, all UI tests, the installer and the installed app on the simulated LeCroy; only the .exe step failed — `rcedit` was imported by a name it does not export (fixed; confirm on the next run). Then install on the Windows 11 PC itself.
0. **First session on the real LeCroy** (model still unknown; 40 GS/s, Windows, 10+ years old). In this order: Remote = TCPIP (VICP) and port 1861 reachable; `*IDN?` names it and the link pill shows the model; `CHDR OFF` takes effect (values parse; check the log for unanswered queries); traces overlay the scope's own screen (Screenshot) at a few V/div, offsets and timebases — this settles whether a sparsed descriptor's HORIZ_INTERVAL includes the sparsing factor (`pointInterval`) and the sign of TRDL; `HCSU DEV,PNG,PORT,NET` + `SCDP` gives an image (else try BMP: `C.lecroy.screenshot_setup`); `INR?` bit 0 means "new acquisition" (trigger badge); `PAVA?` reply layout; deep capture of a few Mpts (chunk size `lecroy.deep_chunk_points`) and its speed; `PNSU?` round trip; an edge capture of a known edge (e.g. the probe-compensation output) to confirm rise times against the scope's own RISE parameter; an edge capture with 3–10 segments: does `WF? ALL` with `WFSU SN,0` bring every segment back to back with `FP`/`NP` counting across them, and does the TRIGTIME array hold one (time, offset) pair per segment (else read each segment with `WFSU SN,k`); the scope FFT's magnitude scaling (peak or RMS — compare a known sine); whether a VBS line of 24 properties is accepted (lower `lecroy.batch_props` if not); how VBS returns booleans (-1 or True: both are read); which automation properties this model lacks (logged as unanswered) and which trigger types it adds. Record what differs in `sim/README.md` and make `sim/lecroy.ts` match.
1. **First session on the real MHO984.** Check, in this order: `*IDN?` and options; WORD byte order is detected and locked (Instrument view); traces overlay the scope's own screen (Screenshot) at several V/div and offsets; `:MEASure:ITEM?` agrees with the cross-check; deep capture of 25 Mpts (is 250 000 points per read accepted? adjust `instrument.raw_chunk_points`); Bode on a known RC. Record anything that differs from the guide in `sim/README.md` and make the simulator match.
2. **Frame rate on hardware.** If the LAN round trip makes 4 channels slow, read `:WAVeform:PREamble?` only when settings change, or use BYTE for the live view.
3. **USB on the real scope, continued:** probe every query once (finds all unanswered ones for fw 00.01.00 and any reply that does not match the guide's options); a 25 Mpt deep read over USB; Windows (Zadig/WinUSB) and Linux (udev).
4. **Speed over USB:** read preamble and data in one compound query (`:WAV:PRE?;:WAV:DATA?` works on the scope), and skip the preamble when no setting changed.
4. **Reference waveforms in the app**: freeze a trace as an overlay (the instrument's own REF1–10 are already in All settings).
5. **Mask test and waveform record/playback panels** with their results (today: settings only, in All settings).
6. **Jitter / eye analysis** from deep memory (time-interval error from edge crossings).
7. **Arbitrary waveform upload** to the generator (`:SOURce<n>:LOAD:ARBitrary` loads from the instrument's storage; the guide has no upload command — check the web interface).

## Someday

- **More LeCroy panels** once the model is known: math functions (F1–F8), zoom, sequence mode, RIS, other trigger types — through VBS, as registry entries.
- **Other families** (Keysight InfiniiVision, Tektronix MSO, Siglent SDS, R&S RTB/RTM): a registry, a driver and a simulator each; see ARCHITECTURE → "How to add another family".
- **VXI-11** for instruments that offer it instead of a raw socket.

- Multiple instruments in one window.
- Scripted sequences (a list of SCPI steps with waits and captures) saved as recipes.
- Export deep captures as WAV or HDF5-free binary with a JSON header.

## Won't do (and why)

- **Digital channel waveforms in the app's screen.** The MHO900 guide has no command that transfers D0–D15 data (`:WAVeform:SOURce` accepts only CHANnel1–4 and MATH1–4). They are configured here and visible in the instrument screenshot.
- **Reading the instrument's own Bode curve.** §3.5 has no data query; the app's own sweep replaces it.
- **Python anywhere in the app.** His rule; the one Python file is App Launcher's install-time registration helper, which never runs with the app.
