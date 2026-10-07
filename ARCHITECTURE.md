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

Since 0.2 it also drives **Teledyne LeCroy X-Stream** oscilloscopes (Windows
based, about 2004 on) over **VICP** on TCP port 1861. The model the user will
connect is not known, so the LeCroy side keeps to what every X-Stream model
documents and learns what a given one does not answer. See "Families and
drivers" below.

## Layers

```
ui/      React 19 + Vite. Chrome, the scope canvas, plots, generic control widgets.
  │      Imports core/ (registry, formatter, DSP) directly; knows nothing of TCP.
  │ HTTP (JSON) + Server-Sent Events, 127.0.0.1 only, per-launch token
  ▼
server/  Node 22.18+, TypeScript run directly (type stripping). Owns the link:
  │      transport.ts (TCP, with the macOS nc fallback), usbtmc.ts (USB-TMC
  │      as a Duplex stream) or vicp.ts (LeCroy VICP), scpi.ts (framing, strict
  │      request/reply, exclusive sections), scope.ts (value mirror, live loop,
  │      measurements) with drivers/rigol.ts or drivers/lecroy.ts for what
  │      differs by brand, deep.ts, bode.ts, discover.ts, store.ts (settings +
  │      presets), main.ts (routes only).
  │ imports                                  ┌──────────────────────────────┐
  ▼                                          │ sim/  the simulated MHO984 + │
core/    Pure TypeScript. No DOM, no node:   │ instrument.ts (dispatcher on │
         imports, no I/O.                    │ the registry), bench.ts      │
           scpi/     header forms, value     │ (signals), png.ts, server.ts │
                     encode/parse, #N blocks,│ (TCP 5555-style); lecroy.ts, │
                     USB-TMC headers, VICP,  │ lecroy-server.ts (VICP 1861) │
                     LeCroy replies + WAVEDESC
           wave/     preamble → volts, word  └──────────────────────────────┘
                     order, 1-2-5 knobs, offset limits
           dsp/      FFT, windows, spectrum/THD, measurements, lock-in,
                     Bode maths, min/max decimation
           registry/ manual.json (generated from the guide), controls.ts
                     (curation), labels.ts, measurements.ts; lecroy.ts (the
                     LeCroy table), families.ts (which table, which features)
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

## Families and drivers

`*IDN?` decides (`core/src/registry/families.ts → familyOf`): a LeCroy vendor
string selects the LeCroy driver, anything else the RIGOL one. A **driver**
(`server/drivers/types.ts`) owns only what differs between brands:

| | RIGOL (`drivers/rigol.ts`) | LeCroy (`drivers/lecroy.ts`) |
|---|---|---|
| Link | raw SCPI lines, or USB-TMC | VICP frames (`server/vicp.ts`) |
| Commands | rendered from the guide's header | per-control templates `q` / `w` (`C<n>`, `{v}`, `{src}`) |
| Replies | short-form enums, NR3 | `CHDR OFF`, units after a space, `MA` = mega, multi-field picks |
| Errors | `:SYSTem:ERRor?` queue | `CMR?` and `EXR?` registers |
| Trigger status | `:TRIGger:STATus?` | `TRMD?` + `INR?` bit 0 |
| Screen record | `:WAV:MODE NORM`, 1000 pts | `WFSU SP,N` (every Nth point, ~2000), `C1:WF? ALL` |
| Waveform format | preamble + WORD codes | WAVEDESC (346 bytes) + int16; mapped onto the same preamble |
| Deep memory | `:WAV:MODE RAW`, STARt/STOP | `WFSU NP,FP` chunks |
| Measurements | `:MEASure:ITEM` slots | `C1:PAVA? <name>` on demand |
| Screenshot / setup | `:DISPlay:DATA? PNG` / `:SYSTem:SETup?` | `HCSU` + `SCDP` (raw image) / `PNSU?` |

Everything else is shared: the value mirror, read-back after writes, the live
loop, learning unanswered queries per model and firmware, deep memory, the DSP,
the whole UI. Common quantities use **the same control ids in both registries**
(`channel.scale`, `trigger.edge.level`, …), so the screen, the inspector and
the run keys need no family checks. Views and inspector sections that need a
feature (`Features` in `families.ts`: generator, decode, math, counter…) are
hidden when the family lacks it; a `<Ctl id>` the active registry lacks renders
nothing.

LeCroy controls are of two kinds: legacy remote-control commands (C1:VDIV,
TDIV, TRMD, MSIZ…) where they are universal, and **automation properties** read
and written through VBS (`VBS? 'return=app.Acquisition.Trigger.Type'`,
`VBS 'app.Acquisition.C1.LabelsText = "VIN"'`) for everything else — trigger
types and their fields, channel names, bandwidth limit, sampling mode. Names,
types and values are those of LeCroy's X-Stream automation manual of June 2003
(WaveMaster / WavePro 7000), the first X-Stream generation, so they should hold
on any later model. A control can carry `then` writes (setting a channel name
also switches its label on). The LeCroy simulator answers the same properties
from a store generated from this registry (`sim/lecroy.ts → vbsSpecs`).

On a LeCroy the screen centre is not a setting: the driver derives it from each
record (HORIZ_OFFSET + half the span) and the T marker does not drag.
`timebase.delay` (HorOffset: seconds, positive moves the trigger right) moves it;
dragging the T marker writes it once, on release. Whether a sparsed descriptor's
HORIZ_INTERVAL already includes the sparsing factor is not stated clearly in
what we have; `pointInterval()` picks the reading that makes the record span
10 × TDIV.

## The links

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

**VICP** (`core/src/scpi/vicp.ts`, `server/vicp.ts`): every message written goes
out with an 8-byte header (DATA|EOI|REMOTE, version 1, sequence number,
big-endian length). Replies are reassembled until EOI and handed to the client
whole (`"reply"` events → `ReplyReader.pushReply`), so a reply is never framed
by guessing at newlines: a message holding an IEEE block becomes that block, a
screen dump (raw image bytes) becomes bytes, text becomes a line. The
instrument echoes the sequence number of the query it answers; a reply with an
older number belongs to a query the client gave up on and is dropped, which
makes a missing reply cost only itself.

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

## Data flow — edge capture (one event, every edge)

`server/burst.ts`, driven only through the registry and the drivers, so the
same code runs on both families:
1. Channels to measure are switched on; an edge trigger is set on the chosen
   channel by meaning (the option of `trigger.mode` matching "edge", of
   `trigger.edge.source` matching channel n — `CHANnel2` or `C2` — of the slope
   matching "pos"/"neg").
2. Timebase: the smallest 1-2-5 s/div whose 9 divisions after the trigger hold
   the window; the trigger 1 division from the left (RIGOL: screen centre
   `timebase.offset`; LeCroy: trigger position `timebase.delay`, negative).
   Memory as deep as allowed (largest option ≤ the limit), so the sample rate is
   the highest the window permits.
3. Single; poll the drivers' status until STOP (the instrument stopped on the
   event) or the wait runs out (then Stop, and an error that says why).
4. Deep memory reads every point (`DeepStore.capture`, inside the same busy
   section). RIGOL deep memory reads only the points the record holds: the
   smaller of the depth setting and rate × span.
5. `core/dsp/edges.ts` finds each passage between the 10 % and 90 % levels
   (hysteresis), interpolates the 10/50/90 % crossings, and summarises; a
   channel whose record leaves the screen is flagged (clipped edges are fast).

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
| Last address, protocol (raw/VICP), recent addresses, which simulator | `~/.config/mho-studio/settings.json` | yes |
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
For the LeCroy simulator, `sim/lecroy.ts → one()`.

**LeCroy setting**: an entry in `core/src/registry/lecroy.ts` with `q` and `w`
templates (and `pick` if the reply has several fields); use an existing RIGOL
id if it is the same quantity, so existing panels show it. If the simulator
should answer it, add it to `sim/lecroy.ts`.

**Another family** (Keysight, Tektronix, Siglent, R&S…): a registry in
`core/src/registry/`, an entry in `families.ts` (`familyOf`, `Features`), a
driver implementing `server/drivers/types.ts`, and a simulator so it can be
tested. The UI follows from the registry and the features.

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
| One app with a driver per family, chosen from *IDN? | The UI, DSP, deep memory and robustness work are brand-independent; only commands and formats differ | A separate app per brand; one "generic SCPI" layer (brands do not share commands) |
| LeCroy over VICP, implemented in TypeScript | Every X-Stream scope has it, old ones included; it is 8 bytes of header; sequence numbers drop late replies | VXI-11 (only newer firmware); LeCroy's ActiveDSO/VISA (Windows COM, not macOS) |
| LeCroy commands: legacy set + automation properties from the 2003 manual | Model unknown: the first X-Stream generation's properties hold on later models; unanswered ones are learned | Generating a registry from one newer model's automation tree (would not match the model he gets) |
| LeCroy reads grouped into one VBS line (`return=app.A & "|" & app.B`) | One round trip instead of ~15 per watch cycle; VBS is on every X-Stream scope. A model lacking one property spoils the line: the service falls back to single reads, learns the culprit, and regroups. Decimal commas from a non-English Windows are accepted | Legacy `;`-joined queries (reply framing over VICP not documented) |
| LeCroy deep memory as bytes when the data has ≤ 8 bits | Half the transfer; NOMINAL_BITS and the channel's averaging decide, words otherwise | Always words |
| Scope FFT in math slot F8 | Whole record at full rate, no aliasing, little to transfer; F8 leaves the user's F1–F7 alone; switched off when the view is left | Only the app's FFT of a sparsed record |
| Edge capture through deep memory, edges found in the app | One trigger, the whole record, every edge with a stated method; instruments' own rise-time statistics cover only the screen or need options | Repeated acquisitions with :MEASure statistics (misses a one-time event) |
| Single-file .exe via Node's SEA: esbuild CJS bundle + interface as assets, unpacked once | No Node install on the lab PC; built and smoke-tested in CI on Windows | pkg/nexe (unmaintained); Electron (large) |
| Windows: PowerShell installer + shortcut to node.exe, CI on a Windows runner | No Windows machine here; Node and the app are cross-platform, so the risk is in the OS glue, which CI exercises | Electron/MSI packaging (large, and still untestable here) |
| LeCroy live screen sparsed, deep memory whole | A 40 GS/s record is millions of points; the screen needs ~2000 | Reading every point each frame (seconds per screen) |
