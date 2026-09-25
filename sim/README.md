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
  -113 (unknown header), -114 (suffix), -222 (out of range, then clamped),
  -224 (illegal value) in `:SYSTem:ERRor?`.
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

## Assumptions that the real instrument must confirm

- **WORD scaling and byte order** (V/div ÷ 7500, yref 32768, little-endian). The
  app does not rely on any of it — it uses the preamble and measures the order —
  but the simulator had to pick something.
- **Chunk size for RAW reads**: the app reads 250 000 points per `:WAVeform:DATA?`.
- **String arguments unquoted** (labels), as in the guide's examples.
