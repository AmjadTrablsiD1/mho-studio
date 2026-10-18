# The simulated MHO984

A TCP server that answers the same raw SCPI as the instrument's port 5555.
MHO Studio starts it in-process for "Use the simulated MHO984"; it also runs
on its own:

```bash
node sim/main.ts --port 5555
```

## The bench

```
GEN OUT 1 ──┬──────────────────────── CH1   (a tee: the generator itself)
            └── 2nd-order low-pass ── CH2   (fc 20 kHz, Q 0.707 — shared/constants.json → sim)
1 MHz 3.3 V clock with 180 MHz ringing ── CH3
UART TX 115200 8N1 "MHO984\r\n" every 2 ms ── CH4
```

Power-on state: CH1 and CH2 on at 500 mV/div (offsets ±1 V), 100 µs/div,
GEN 1 on at 5 kHz 2 Vpp sine, edge trigger on CH1 rising at 0 V.

### The simulated STM32 board (since 0.5.0)

`sim/board.ts` answers the board's command link (`core/src/board/protocol.ts`):
Ping, GetVersion, ClkInit, ClkFreq, ClkGet, ClkDrive, ClkSweep, DacSine,
DacPlay, DacStatus, with a log line before each ClkFreq reply as the firmware
prints one. The DAC sine is chosen as `dac_play.cpp` does: a table of
~400 kHz ÷ f entries (16–1024), a timer rate that divides 240 MHz, frequency =
rate ÷ length, clamped to 1 Hz – 60 kHz. Its Si5351 plan is an
approximation of the firmware's (even integer output divider, 600–900 MHz VCO,
2^20−1 fractional denominator, R divider below 500 kHz), so the reported
frequency is the planned one, not the requested one. While the DAC plays a
sine, that sine — else the lowest CLK output that is on, a 0–3.3 V square with
~2 ns edges — replaces GEN OUT 1 on the bench (`sim/wiring.ts`):

```
board output ──┬──────────────────────── CH1
             └── 2nd-order low-pass ── CH2
```

Test options: no Si5351, a different UART speed, dropped replies, an old
protocol version, a DAC held by another owner (Busy), what the DAC plays at
power-up. Not modelled: PLL sharing between the three outputs (no
output is ever "unreachable"), relock glitches, the crystal's own error.

## Modelled

- Every command in `core/src/registry/controls.ts` as a stored value: set,
  query (short-form enum replies, `%E` numbers), defaults from the guide, errors
  -100 (unknown or unimplemented command), -114 (suffix), -222 (out of range,
  then clamped), -224 (illegal value) in `:SYSTem:ERRor?`.
- **An unknown query gets no reply at all**, and `-100,"Command err"` is queued —
  exactly what the real MHO984 does (measured 2026-09-26). `new SimScope({ unimplemented: [/…/] })`
  makes chosen commands behave that way, to model a firmware without them.
- The instrument's own coercion: V/div and s/div snap to 1-2-5 unless fine is
  on; V/div limits by impedance and probe; offset limits by V/div (guide §3.6.5);
  trigger level within the screen; averages rounded down to a power of two.
- Acquisition: a new trigger instant per screen when running, frozen when
  stopped; AUTO sweep free-runs without a trigger, NORMAL waits, SINGLE stops
  after one. Edge trigger on any analog channel with either slope.
- Channel coupling (AC removes the mean, GND), invert, noise that scales with
  V/div and falls with averaging / high-res / 20 MHz limit.
- `:WAVeform` NORMal / MAXimum / RAW in BYTE (yinc = V/div ÷ 25, yref 128),
  WORD (yinc = V/div ÷ 7500, yref 32768, little-endian) and ASCii; RAW only when
  stopped; START/STOP windows; memory depth and sample rate from the channel
  count as the datasheet gives them.
- `:MEASure:ITEM?` (all 41 items, from a 10 000-point record with
  `core/dsp/measure.ts`) and `:MEASure:STATistic:ITEM?`; counter; voltmeter.
- Math arithmetic, ABS, SQRT, LG, LN, EXP, INTG, DIFF, and FFT.
- `:BUS<n>:DATA?` for RS232 on the UART, in HEX/ASCII/DEC/BIN.
- `:DISPlay:DATA?` and `:SAVE:IMAGe:DATA?` as a PNG of its own screen;
  `:SYSTem:SETup?` / `:SYSTem:SETup #9…` as a JSON blob; `*IDN?`, `*OPC?`,
  `:SYSTem:OPTion:STATus?` (RLU-05 and AFG100 installed).

## Not modelled (they store and return their settings, nothing more)

- Trigger conditions other than an edge on the source (pulse widths, runts,
  protocol triggers…): the simulator triggers on the source's edge regardless.
- Digital channels, mask test results, record/playback, search and navigate
  results, histograms, cursors' read-back values.
- Math logic operations, filters and aX+b (they pass source A through).
- Bandwidth limit shaping (only its noise reduction), probe attenuation of the
  signal (the scale is already at the probe tip).

## Confirmed on the real MHO984 (fw 00.01.00, USB, 2026-09-26)

- WORD scaling V/div ÷ 7500 and yref 32768; little-endian (the app measured and locked it).
- USB IDs `1ab1:0452`, USB-TMC on interface 0, bulk EP 1 in/out, 512-byte packets.
- An unknown query is answered with silence; over USB the instrument then answers
  nothing more until a USB-TMC INITIATE_CLEAR. Compound queries (`:A?;:B?`) work,
  replies joined with `;`. Each query costs the instrument about 25–35 ms.
- A reply left pending by a previous session is still waiting at the next open.

## Assumptions that the real instrument must still confirm
- **Chunk size for RAW reads**: the app reads 250 000 points per `:WAVeform:DATA?`.
- **String arguments unquoted** (labels), as in the guide's examples.

# The simulated LeCroy X-Stream

`sim/lecroy.ts` behind `sim/lecroy-server.ts` (VICP on a TCP port; `node
sim/main.ts --lecroy` runs it alone on 1861). It stands in for an **unknown**
40 GS/s X-Stream model; every number in `constants.json → lecroy.sim` is the
simulator's choice, not any real model's datasheet value.

## The bench

- CH1 — 10 MHz sine, 0.8 Vpp
- CH2 — the 1 MHz 3.3 V clock with ringing (same as the RIGOL bench's CH3)
- CH3 — 100 kHz square, 1 Vpp
- CH4 — the UART burst (same as the RIGOL bench's CH4)

8-bit codes (25 per division) sent as 16-bit words (× 256), Gaussian noise.
Sample rate = memory ÷ (10 × TDIV), at most 40 GS/s.

## Modelled

- VICP framing; replies carry the query's sequence number.
- `CHDR` (header on by default: `C1:VDIV 100E-3 V`; off: `100E-3 V`), `CFMT`, `CORD`.
- `C<n>:TRA/VDIV/OFST/CPL/ATTN/TRLV/TRSL/TRCP`, `BWL` (pairs), `TDIV`, `TRDL`,
  `MSIZ` (snapped to its list; answers `100K`, `10MA`), `TRMD` (SINGLE stops after one
  acquisition), `TRSE EDGE,SR,…`, `ARM`, `STOP`, `FRTR`, `ASET`, `*RST`, `*CLS`, `*OPC?`.
- `WFSU SP,NP,FP,SN` and `C<n>:WF? DESC|ALL` with a LECROY_2_3 WAVEDESC
  (HORIZ_INTERVAL of a sparsed record includes the sparsing factor — the real
  instrument may differ; the app copes with both).
- `C<n>:PAVA? <name>` from the app's own measurement code (`OK`, `NP` or `IV`).
- `CMR?` (1 = unrecognized header, 3 = bad number, 5 = bad keyword), `EXR?`,
  `INR?` (bit 0 set by each acquisition, cleared by reading).
- `HCSU`, `SCDP` (a PNG of its own screen, raw bytes), `PNSU?` / `PNSU #9…`.
- `VBS?` for `Horizontal.SamplingRate`, `Horizontal.SampleMode`, `C<n>.Invert`,
  `C<n>.AverageSweeps`; `VBS 'app.…= …'` for the last two.
- An unknown command or query: no reply, `CMR` = 1 (what the manual describes).

## Not modelled

Math, zoom, memories, other trigger types, RIS, roll, ERES,
averaging's effect on the data, digital channels, real timing (it answers in
~2 ms), and every VBS property not listed above.

## Assumptions the real instrument must confirm

Written from the remote control manual, so these are the manual's word, not
measurements: the reply layout of `PAVA?` and `WF?` with headers off; whether
`HCSU DEV,PNG,PORT,NET` is accepted on an old model; `INR?` bit 0's meaning;
`TRDL`'s sign; HORIZ_INTERVAL under sparsing. See TODO → Next → 0.

### Automation properties (since 0.2.1)

Every `VBS? 'return=app.…'` / `VBS 'app.… = …'` property in the app's LeCroy
registry is answered from a store generated from that registry, with the
manual's option lists enforced (a value outside them sets EXR and changes
nothing). Some are wired to the simulated bench: channel invert, averaging,
bandwidth limit, V/div and offset; trigger source, per-source level and slope;
HorOffset (trigger position); sampling rate. The others (trigger types and
their fields, labels, sample mode, segments…) are stored and returned only:
the simulator always triggers on an edge of the trigger source, whatever type
is selected. Booleans come back as -1 / 0.

### Since 0.2.2

- `VBS? 'return=app.A & "|" & app.B'`: string concatenation of properties and
  string literals, as VBScript does; one unknown property fails the line (EXR,
  no reply). `new LecroySim({ lacks: [/HorOffset/] })` models a scope without
  a property, `commaLocale: true` a Windows writing "0,05".
- `CFMT DEF9,BYTE,BIN`: 8-bit codes with a 256× gain; NOMINAL_BITS 8, or 11
  for a channel averaging more than one sweep.
- Math F1–F8 as an FFT of a channel (`Source1`, `Operator1 = "FFT"`,
  `Operator1Setup.Window`, `View`): the magnitude spectrum of the whole record
  (up to 2^19 points) in RMS volts per bin — the simulator's choice; the
  manual does not state the real instrument's scaling.

### Since 0.3.2

- Sequence mode: with `SampleMode = "Sequence"` an acquisition records
  `NumSegments` segments, each at the next crossing of the trigger level after
  the previous segment's record has ended and `lecroy.sim.rearm_s` (1 µs) has
  passed. `WF?` with `WFSU SN,0` returns them back to back (FP and NP count
  across them), the descriptor's SUBARRAY_COUNT and a TRIGTIME array of (time
  from the first trigger, time from this trigger to its first point) per
  segment. Whether the real instrument does exactly this is on the checklist in
  TODO → Next → 0.

### Since 0.3.0

- Trigger in Normal and Single waits for a real crossing of the level: a level
  the signal never reaches leaves the instrument armed (Auto still free-runs,
  FRTR always acquires). In Single a `TRMD?` poll lets the trigger arrive, as a
  live signal would; the instrument then reads STOP.

## The simulated Teledyne T3DSO1204 (since 0.4.0)

`sim/siglent.ts` + `sim/siglent-server.ts` (raw SCPI over TCP; `node
sim/main.ts --siglent` runs it alone on 5025). Built from what a real T3DSO1204
(fw 8.3.6.1.37R8) answered over USB on 2026-10-14; the real replies themselves
are fixtures in `core/test/fixtures/t3dso1204/`.

The bench: CH1 a 1 MHz sine, 1 Vpp; CH2 the 1 MHz 3.3 V clock with ringing;
CH3 a 100 kHz square, 1 Vpp; CH4 the UART. 14 horizontal divisions, 25 codes
per division, signed 8-bit. CH1/CH2 and CH3/CH4 are pairs: both of a pair on
gives 500 MSa/s and 7K…7M memory, one gives 1 GSa/s and 14K…14M.

Modelled, as the real one: `*IDN?` "Lecroy,T3DSO1204 ,…"; `CHDR` (headers and
units on by default, off with CHDR OFF); `C<n>:TRA/VDIV/OFST/CPL/ATTN/BWL/INVS/
UNIT/SKEW/TRLV/TRSL/TRCP`, `TDIV`, `TRDL`, `MSIZ` ("7M", "700K"), `SARA?`,
`SANU?`, `ACQW`, `AVGA`, `TRMD` (Single stops after one acquisition), `TRSE
<type>,SR,<src>,HT,OFF`, `WFSU SP,NP,FP`, `C<n>:WF? DAT2` ("DAT2,#9…" + bytes +
two newlines) and `DESC`, `C<n>:PAVA?` ("****" when it cannot measure), `INR?`,
`*ESR?` (32 command error, 16 execution error), `SAST?`, `SCDP` (an 800×480
RGB565 BMP, raw), `PNSU?` / `PNSU #9…` (XML), `ARM`, `STOP`, `FRTR`, `ASET`,
`*RST`, `*CLS`, `*OPC?`. A query it does not know: no reply, ESR bit 5.
`new SiglentSim({ ignoreSparse: true })` ignores WFSU SP (every point comes),
to test the driver's own thinning; the virtual USB-TMC device in the tests can
add the empty transfer after each block (`emptyAfterBlock`).

Not modelled: the conditions of trigger types other than Edge, math, FFT,
decode, sequence/history, roll mode, the real instrument's timing, and how the
real one answers several queries in one message (it answers only part; the
simulator answers all).
