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

Math, zoom, memories, other trigger types, sequence mode, RIS, roll, ERES,
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
