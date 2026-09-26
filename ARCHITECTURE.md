# MHO Studio — architecture

*Kept true after every change.*

## What this app is for

One window that drives a RIGOL MHO984 (800 MHz, 4 GSa/s, 12-bit, 4 + 16 channels,
optional 2-channel generator) from a computer, and does the things its own
screen cannot:

1. **Front panel, remotely.** Live traces of every channel and math source,
   draggable offsets / trigger level / trigger position, wheel for s/div and
   V/div, cursors, persistence, every vertical, horizontal, trigger, acquire,
   math, generator, counter and voltmeter setting.
2. **The whole command set.** All 655 commands of the MHO900 programming guide
   are in a registry; 596 of them are editable fields (the rest are data
   transfers or multi-argument commands with their own UI). Nothing of the
   instrument is out of reach, and every field says which SCPI header it is.
3. **Things only a computer can do with it.** Deep-memory capture (up to 25 Mpts
   per channel) with zoom, measurement and CSV; an FFT with stated window and
   scaling, peak list and THD; a Bode sweep driven by the built-in generator
   (the scope's own Bode option cannot return its curve over SCPI); presets
   (setup files) on disk; screenshots; a SCPI console with completion from the
   guide; measurements with running statistics and an independent cross-check.
4. **A simulated MHO984** that speaks the same SCPI over TCP, so all of the
   above works — and is tested — with no instrument on the desk.

It talks to the scope over LAN (raw SCPI on TCP port 5555) or USB (USB-TMC on
the rear USB Device port). No VISA, no Python; the only native code is the
optional prebuilt `usb` package.

## Layers

```
ui/      React 19 + Vite. Chrome, the scope canvas, plots, generic control widgets.
  │      Imports core/ (registry, formatter, DSP) directly; knows nothing of TCP.
  │ HTTP (JSON) + Server-Sent Events, 127.0.0.1 only, per-launch token
  ▼
server/  Node 22.18+, TypeScript run directly (type stripping). Owns the link:
  │      transport.ts (TCP, with the macOS nc fallback) or usbtmc.ts (USB-TMC
  │      as a Duplex stream), scpi.ts (framing, strict request/reply, exclusive
  │      sections), scope.ts
  │      (value mirror, live loop, measurements), deep.ts, bode.ts, discover.ts,
  │      store.ts (settings + presets), main.ts (routes only).
  │ imports                                  ┌──────────────────────────────┐
  ▼                                          │ sim/  the simulated MHO984:  │
core/    Pure TypeScript. No DOM, no node:   │ instrument.ts (dispatcher on │
         imports, no I/O.                    │ the registry), bench.ts      │
           scpi/     header forms, value     │ (signals), png.ts, server.ts │
                     encode/parse, #N blocks,│ (TCP 5555-style)             │
                     USB-TMC headers
           wave/     preamble → volts, word  └──────────────────────────────┘
                     order, 1-2-5 knobs, offset limits
           dsp/      FFT, windows, spectrum/THD, measurements, lock-in,
                     Bode maths, min/max decimation
           registry/ manual.json (generated from the guide), controls.ts
                     (curation), labels.ts, measurements.ts
shared/  constants.json (rule 11) and themes.json (rule 1).
```

Dependencies point one way: `ui → core`, `server → core`, `server → sim` (only to
start it in-process), `sim → core`, `core → nothing`. Node runs the `.ts` files as
they are, so TypeScript here is *erasable only*: no `enum`, no `namespace`, no
parameter properties, no decorators; imports carry `.ts`.

## The registry (why "all of the instrument" is cheap)

`scripts/gen-manual-index.ts` reads `pdftotext -layout` output of the RIGOL
*MHO900 Programming Guide* and writes `core/src/registry/manual.json`: for each
command its header (`:TRIGger:PULSe:UWIDth`), section, set/query forms, and each
parameter's type, option list, range and default. Facts only — no prose is
copied. `controls.ts` turns each into a `Control`:

`{ id, header, section, group, sub, label, kind: number|enum|bool|string|action|readonly,
options, min, max, unit, def, suffix: {name, values}, step: "125"|"fine"|n,
when: {id, is[]}, confirm, primary, watch, after[], hidden, needs }`

and `CURATED` overrides by header add what a table cannot know: 1-2-5 steps,
which values are polled because a person may turn a knob on the real front panel
(`watch`), which are read at connect (`primary`), which writes need a
confirmation (`confirm`: generator output on, 50 Ω input, *RST, autoset), which
values the instrument couples (`after`: V/div → offset and trigger level), and
when a field is relevant (`when`: pulse widths only while the trigger type is
Pulse; a bus's RS232 fields only while *that* bus is RS232).

The same list drives: the server's read/write/parse, the simulator's command
dispatcher and defaults, every inspector field, the All-settings view, and the
console's completion.

## Data flow — one screen of live traces

1. `server/scope.ts → loop()` runs while a window is open (SSE subscriber) and no
   long job holds the instrument (`busy`).
2. Every `loops.status_period_ms`: `:TRIGger:STATus?` → header pill.
3. If running (or a setting changed while stopped): in one exclusive section,
   `:WAVeform:MODE NORMal`, `:WAVeform:FORMat WORD`, then per visible source
   `:WAVeform:SOURce CHANnel2`, `:WAVeform:PREamble?`, `:WAVeform:DATA?`.
4. `core/scpi/block.ts` frames the `#9…` block by its length; `core/wave/decode.ts`
   turns WORD codes into volts with the preamble: `(code − yorigin − yref) × yinc`.
   The WORD byte order is not in the guide, so `detectWordOrder()` measures it
   (the right order is smooth, the wrong one jumps by hundreds of codes) and the
   service locks it after three confident screens.
5. Float32 volts go out on SSE (`frame`, base64). The UI's `onFrame` listeners
   receive them outside React; `ui/src/scope/screen.ts` draws them in the next
   animation frame, mapping time with the preamble and volts with the mirrored
   V/div and offset.

## The two links

`server/scpi.ts` only needs a byte stream (a Node `Duplex`): SCPI text and #N
blocks out, the same back. Over LAN that is the TCP socket. Over USB it is
`UsbtmcStream` (`server/usbtmc.ts`): each message written goes out as one
DEV_DEP_MSG_OUT on the bulk-OUT pipe; if its header contains a `?`
(`core/scpi/usbtmc.ts → expectsReply`) the stream then sends
REQUEST_DEV_DEP_MSG_IN for up to `usb.request_bytes` and reads DEV_DEP_MSG_IN
from bulk-IN — header in the first transfer, continuation transfers without —
until EOM, or until the reply is visibly complete (a line ending in `\n`, or a
whole #N block) for instruments that leave EOM clear. Replies are pushed into
the stream as they arrive, so progress bars work over USB too. On open it
claims the USB-TMC interface (class FE/03), clears halts and sends
INITIATE_CLEAR so nothing a previous session left is taken as an answer.

Tests run the complete service over `server/test/virtual-usbtmc.ts`: the
simulator behind real USB-TMC framing, with replies split into small
transfers, a no-EOM mode and unplugging.

## Data flow — one write

1. A field (`ui/src/components/Controls.tsx`) posts `{key: "channel.scale@2", value}`.
2. `scope.write()` validates against the registry; if `confirm` applies and the
   request is not confirmed, it answers 409 with the warning text — the UI shows
   it and repeats the call with `confirmed: true` if accepted.
3. `:CHAN2:SCAL 0.3`, settle, read it back, read the `after` keys, drain
   `:SYSTem:ERRor?`.
4. The reply carries `requested`, `value` (what the scope set), `coerced` and
   `errors`; the field shows "asked 300 mV/div — instrument set 200 mV/div" or
   the error text. Broadcasts always publish the mirror's *current* value, so a
   read that raced a write cannot roll the interface back.

## Data flow — Bode sweep

`server/bode.ts`: read every setting it will touch; set GEN n to a sine at the
amplitude, both channels DC/0 V offset/fitted scale, edge trigger on the input
channel; then per frequency: set it, choose the 1-2-5 timebase showing ≥ 4
periods, wait (settle or two screens), read both channels, rescale a channel
that is clipped or under 1.5 div and retry, and take gain and phase from
`core/dsp/lockin.ts` phasors of the two records (same acquisition, same time
origin). The corner is interpolated in log-frequency. Everything touched is
written back at the end, generator output last.

## Where state lives

| State | Home | Survives restart? |
|---|---|---|
| Instrument settings | the instrument; the server mirrors what it read back | on the device |
| Last address, recent addresses, sim or not | `~/.config/mho-studio/settings.json` | yes |
| Presets (instrument setup files) | `~/.config/mho-studio/presets/*.setup` + `.json` | yes |
| Deep capture | server memory, 16-bit codes (50 MB per 25 Mpt channel) | no |
| Measurement slots and statistics | server memory | no |
| Bode result | server memory; CSV export | no |
| View, section, cursors, persistence, theme | browser `localStorage` | yes |

## How to add a new …

**Setting the generic panels do not label well** (e.g. a trigger field):
1. Add its header to `CURATED` in `core/src/registry/controls.ts` with `label`,
   `unit`, `step`, `when`, `confirm` as needed. Nothing else.

**Setting with its own place in the inspector**: add `<Ctl id="…" n={n} />` to
the section in `ui/src/components/Inspector.tsx`.

**Measurement**: an entry in `core/src/registry/measurements.ts`; if the app
should cross-check it, compute it in `core/src/dsp/measure.ts → measureAll()`
with a test in `core/test/dsp.test.ts`.

**New analysis view** (e.g. jitter, eye): the maths in `core/src/dsp/<name>.ts`
with two worked examples in `core/test/`; a view in `ui/src/views/`, listed in
`VIEWS` in `ui/src/App.tsx`; if it needs deep data, an endpoint in
`server/main.ts` that calls `DeepStore`.

**Newer programming guide**: re-run `scripts/gen-manual-index.ts` on it, run the
tests (the registry test checks ids, `when` and `after` references), diff
`manual.json`.

**Something the simulator should model**: `sim/instrument.ts → special()` for a
query with behaviour, `sim/bench.ts` for a signal; list it in `sim/README.md`.

## Security posture

- Binds `127.0.0.1` on an OS-chosen port; the port goes to a file so a second
  launch opens the running one.
- Every mutating request needs the per-launch token the page receives at load,
  and a same-origin `Host`/`Origin`: a web page elsewhere cannot drive the scope.
- Actions that change what is connected to the outside world (generator output,
  50 Ω input) or throw away settings (*RST, restart, setup load, preset recall,
  autoset) need an explicit confirmation.
- Discovery is a connect scan of the local /24 on one port; nothing leaves the LAN.

## Decisions

| Decision | Why | Rejected alternative |
|---|---|---|
| Raw SCPI over TCP 5555 from Node | No VISA/NI stack, identical on macOS and Windows, one socket | VISA via ffi |
| USB-TMC implemented in TypeScript over `usb` v3 (nusb, prebuilt) | Framing is small and testable; no libusb or compiler; macOS needs no driver | VISA (NI-VISA install, poor macOS support); `usb` v2 (libusb) |
| A missing reply is a per-query error (ENOREPLY), not a lost link | The MHO984 answers unknown/unimplemented queries with silence; over USB it then stays silent until a USB-TMC clear. The USB stream times out, clears and reports; TCP resynchronises on *IDN?. Unanswered queries are remembered per firmware | Closing and reconnecting (what 0.1 did: over USB the close crashed the server) |
| Nothing touches the USB device while a transfer is pending | The `usb` library throws synchronously from release/close during a transfer; every call is queued and guarded | Relying on promise rejections |
| mDNS + ARP in discovery | A direct cable with 169.254.x.x addresses is a /16 — unscannable; LXI instruments answer mDNS | Scanning /16 |
| All TypeScript (Node server + React) | His standing rule: no Python in the GUI; one language end to end | Python core |
| Browser UI served by a local Node server | Same stack as his other studios; no 150 MB Electron | Electron |
| Registry generated from the guide, curated on top | 655 commands cannot be hand-written without mistakes; facts stay traceable to §numbers | Hand-written command table |
| WORD transfer with measured byte order | Keeps 12-bit resolution; the guide leaves the order unstated | BYTE (loses 4 bits); assuming little-endian |
| Read back after every write | The scope snaps and clamps (1-2-5, offset limits); the UI must show what is true | Trusting the requested value |
| App-driven Bode with lock-in phasors | The instrument's Bode curve cannot be read over SCPI; phasors avoid the guide's undefined phase-measurement sign | :MEASure:ITEM? RRPHase per point |
| Canvas 2D for the screen | 4 × 1000 points at 25 fps is trivial for 2D; crisp lines, no WebGL context loss | Three.js/WebGL |
| Simulator as a TCP server using the same registry | The app runs identically on sim and hardware; tests exercise the real transport | Mocking at the service layer |
