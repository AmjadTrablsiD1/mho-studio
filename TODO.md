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

## Doing

- Nothing in progress.

## Next

1. **First session on the real MHO984.** Check, in this order: `*IDN?` and options; WORD byte order is detected and locked (Instrument view); traces overlay the scope's own screen (Screenshot) at several V/div and offsets; `:MEASure:ITEM?` agrees with the cross-check; deep capture of 25 Mpts (is 250 000 points per read accepted? adjust `instrument.raw_chunk_points`); Bode on a known RC. Record anything that differs from the guide in `sim/README.md` and make the simulator match.
2. **Frame rate on hardware.** If the LAN round trip makes 4 channels slow, read `:WAVeform:PREamble?` only when settings change, or use BYTE for the live view.
3. **USB on the real scope, continued:** probe every query once (finds all unanswered ones for fw 00.01.00 and any reply that does not match the guide's options); a 25 Mpt deep read over USB; Windows (Zadig/WinUSB) and Linux (udev).
4. **Speed over USB:** read preamble and data in one compound query (`:WAV:PRE?;:WAV:DATA?` works on the scope), and skip the preamble when no setting changed.
4. **Reference waveforms in the app**: freeze a trace as an overlay (the instrument's own REF1–10 are already in All settings).
5. **Mask test and waveform record/playback panels** with their results (today: settings only, in All settings).
6. **Jitter / eye analysis** from deep memory (time-interval error from edge crossings).
7. **Arbitrary waveform upload** to the generator (`:SOURce<n>:LOAD:ARBitrary` loads from the instrument's storage; the guide has no upload command — check the web interface).

## Someday

- Multiple instruments in one window.
- Scripted sequences (a list of SCPI steps with waits and captures) saved as recipes.
- Export deep captures as WAV or HDF5-free binary with a JSON header.

## Won't do (and why)

- **Digital channel waveforms in the app's screen.** The MHO900 guide has no command that transfers D0–D15 data (`:WAVeform:SOURce` accepts only CHANnel1–4 and MATH1–4). They are configured here and visible in the instrument screenshot.
- **Reading the instrument's own Bode curve.** §3.5 has no data query; the app's own sweep replaces it.
- **Python anywhere in the app.** His rule; the one Python file is App Launcher's install-time registration helper, which never runs with the app.
