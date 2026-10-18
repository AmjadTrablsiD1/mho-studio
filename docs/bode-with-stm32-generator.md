# Bode sweeps with the STM32H743 board as the generator

Report, 2026-10-16. **Steps 1–4 are built (0.5.0) and tested on the simulators;
step 5 — the real board — is TODO → Next. Added afterwards (also 0.5.0): the
board's DAC sine on PC4 as a third generator, 1 Hz – 60 kHz — the "board's own
DAC" option this report mentioned, but measured by the scope like the others.** Where the build differs from the
plan, the plan below has been corrected and says so.

## Short answer

**Do not merge the two applications. Make the board a second generator inside
MHO Studio.** The scope stays the measuring instrument; the board only sets a
frequency and reports what it actually produced. One tile in App Launcher, one
window, one Bode view with a *Generator* choice:

- **Scope GEN OUT** — today's sweep, unchanged (needs the AFG option);
- **STM32 board – Si5351 CLK0/1/2** — new.

Board Test GUI stays what it is: the bring-up tool. It and MHO Studio must not
have the board's serial port open at the same time (see Risks).

Why not a real merge: Board Test GUI and Loop Bench are Python/Qt and
Python/web; MHO Studio is TypeScript with no Python, by your rule. Gluing them
(MHO Studio calling a Python app over HTTP) means two programs, two ports, two
things to start and a serial link owned by a process the sweep cannot see. The
part MHO Studio needs from the board is small — about six commands — so it is
cheaper and safer to speak the board's protocol directly from TypeScript.

## What already exists

| Piece | Where | Reusable for this |
|---|---|---|
| Bode sweep: step a generator, read CH-in and CH-out screen records, lock-in phasor at the drive frequency, gain/phase, auto-ranging, −3 dB corner, CSV, settings restored | `mho-studio/server/bode.ts`, `core/src/dsp/{bode,lockin}.ts`, `ui/src/views/BodeView.tsx` | **All of it.** Only the "set the generator" lines change. |
| Si5351 driver, 2.5 kHz – 200 MHz, 0.01 Hz resolution, reports the *achieved* frequency | `STM32H743/H743_CORE_V13_Cpp/Core/Src/si5351.cpp` | Yes, as is — no reflash needed |
| Wire protocol: 16-byte packets, `0xC0DE5A5A` command / `0xACED5A5A` reply, sequence number echoed, USART1 via CH340 at 115200 | `Core/Inc/test_protocol.hpp`, `board_test_gui/board_test/protocol.py` | Port the subset to TypeScript |
| `ClkInit`, `ClkFreq` (stops an on-board sweep on that channel), `ClkGet`, `ClkDrive`, `GetVersion` | protocol v15+ | The commands the generator needs |
| Board-only swept-sine analyser (DAC → circuit → two ADC inputs, lock-in on the chip) | `sweep.cpp`, used by Loop Bench | Optional third source for low frequencies, without the scope |

So MHO Studio has the measurement and the board has the generator. Neither has
to be rewritten.

## Design

```
┌──────────────── MHO Studio (one Node process) ────────────────┐
│ BodeView ── Generator: [Scope GEN OUT ▾ | Board Si5351 CLK0]   │
│                      │                                         │
│ BodeRunner ── gen.set(hz) → achieved hz ── scope.readTrace ×2  │
│      │                                       lock-in, gain/phase│
│  ┌───┴──────────────┐                                          │
│  │ scopeAfg         │ :SOURce1:FREQuency …  (USB/LAN)          │
│  │ boardClock       │ ClkFreq …  ── server/board.ts ── serial ─┼─► STM32H743 ─I²C─► Si5351 ─► DUT
│  └──────────────────┘                                          │                      │
└────────────────────────────────────────────────────────────────┘          CH1 (in) ◄──┤
                                                                            CH2 (out) ◄─ DUT out
```

### 1. A `Generator` interface (`server/generators.ts`)

```ts
export type Generator = {
  label: string;
  minHz: number; maxHz: number;
  waveform: "sine" | "square";
  amplitudeAdjustable: boolean;
  prepare(cfg: BodeConfig): Promise<() => Promise<void>>; // returns "restore"
  set(hz: number): Promise<number>;                         // returns the ACHIEVED hz
  output(on: boolean): Promise<void>;
};
```

- `scopeAfg` is today's code moved out of `BodeRunner.run`: the `source.*`
  writes and their restore.
- `boardClock` sends `ClkFreq` and returns the frequency in the reply, not the
  one asked for. The lock-in then runs at that frequency. (Bug checklist 9: a
  field named after a setting must carry what the hardware achieved.)
- `BodeRunner` stays generator-blind. The changes are: plan and check against
  `gen.minHz/maxHz`; channel scales start from a first measurement rather than
  from `amplitudeVpp`, since the Si5351 amplitude is fixed; and the CSV header
  names the generator (`frequency_hz` is the achieved frequency).

### 2. The board link (`server/board.ts`)

- The Node `serialport` package. It is native like `usb`, which MHO Studio
  already ships, and has prebuilt binaries for macOS and Windows, so the
  Windows `.exe` build needs the same native-module handling `usb` has.
- Port the packet format and only these commands: `GetVersion`, `ClkInit`,
  `ClkFreq`, `ClkGet`, `ClkDrive`, plus `ClkSweep` (to stop one).
- On connect: refuse a protocol older than v16 and say so.
- Open the port **exclusively**. If it is busy, say "close Board Test GUI /
  Loop Bench".
- Find the port: the CH340 (USB 1a86:7523), only when there is exactly one —
  the same rule Board Test GUI uses. Otherwise ask.
- Command timeout with a retry that re-reads `ClkGet`: if a reply was lost,
  the board may still have changed frequency.

### 3. A simulated board (`sim/board.ts`)

- It answers the same packets and models the Si5351's achieved frequency, so
  tests run without hardware.
- The simulated scope gets an input: a square at the board's frequency into
  CH1, and an RC-filtered copy into CH2. The whole sweep is then
  tested end to end, as the AFG sweep is today.
- `MHO_STUDIO_NO_USB` gains a sibling, `MHO_STUDIO_NO_SERIAL`, so tests can
  never open your real board — the lesson from the MHO984 this week.

### 4. UI

- **Bode view:** a Generator selector; a board status line (port, firmware,
  protocol, Si5351 found or not); a channel selector (CLK0–2) and drive
  (2–8 mA). The start/stop fields are limited to the selected generator's range.
- **Connect panel:** an optional "Board" row, so the board can be connected
  once and stay connected, like the scope.

## The Si5351 as a Bode source — what to expect

| | Si5351 via the board | Scope GEN OUT (AFG option) |
|---|---|---|
| Waveform | **square**, 0 – 3.3 V | sine |
| Range | **2.5 kHz – 200 MHz** | the AFG option's range |
| Amplitude | fixed (≈3.3 Vpp, drive 2–8 mA) | adjustable |
| DC level | ≈1.65 V average | 0 V, adjustable |
| Frequency step | 0.01 Hz; reports the achieved value | as set |

What this means for the measurement:

- **The square wave is fine for linear circuits.** The lock-in takes only the
  fundamental from each channel, and gain/phase are the ratio out/in of the two
  *measured* fundamentals. The 1.27× fundamental of a square, the harmonics
  (3f at −9.5 dB, 5f at −14 dB) and the DC level all drop out.
- **It is not fine for nonlinear circuits or very sharp resonances.** Harmonic
  energy goes into the circuit too: an amplifier near clipping, or a high-Q
  filter whose peak sits at 3f, sees a different stimulus than a sine sweep would
  give. For those, use a sine source.
- **Too big for small-signal circuits.** 3.3 V into an op-amp stage with gain
  clips at once. Put a resistive divider (e.g. 10:1) after CLKx and measure CH1
  *after* the divider. The ratio method does not care how big the drive is.
- **The DC level** goes into DC-coupled circuits. Either AC-couple (a series
  capacitor, whose corner is far below 2.5 kHz) or accept the 1.65 V offset. The
  lock-in ignores DC; the circuit might not.
- **No sweep below 2.5 kHz.** Audio and control-loop bands need the scope's
  AFG, or the board's own DAC sine sweep, which goes down to 0.1 Hz.
- **Each frequency change can re-plan the PLL,** and the output glitches
  while it relocks. The existing settle time (max of `settle_ms` and two fresh
  screens) already covers this. Do not lower it for this source.
- **At the top end the scope sets the limit,** not the Si5351. Two channels on
  means at most 2 GSa/s; the sweep wants about 4 periods on screen. Both
  channels roll off together, so the ratio stays correct well past where each
  trace alone looks attenuated. Treat the top decade as measured only after
  comparing against a known circuit.

**If your "signal generator chip" is not the Si5351** (for example an AD9833 or
AD9850 DDS, which gives a sine), the design does not change. It is one more
`Generator` implementation and a firmware command to set its frequency, and
the sine removes the square-wave caveats above. Tell me which chip and how it is
wired.

## Speed (estimate, to be measured)

Per point:

| Step | Time |
|---|---|
| `ClkFreq` over 115200 baud + I²C write | a few ms |
| Settle | ≥ 120 ms or two screens |
| Two screen records over USB | ~30 ms per query, plus transfer |

That is roughly **0.2–0.5 s per point**, so a 50-point sweep takes about
**15–25 s**. The scope dominates the time, as with GEN OUT.

## Risks — the checklist items that apply

1. **Two programs on one serial port** (checklist 12). Board Test GUI
   auto-connects to the CH340. MHO Studio must open the port exclusively and
   name the program holding it.
2. **The achieved frequency, not the requested one** (checklist 9). The
   lock-in uses the reply's frequency. *Corrected:* the plan also said to
   refine it from CH1's zero crossings and so catch a wrong crystal load — a
   screen of 4–10 periods cannot resolve tens of ppm, so that was dropped.
   What was built instead: the sweep checks that CH1 repeats at the
   generator's frequency (within 10 %) and stops at the first point if not —
   it catches the wrong CLK output or CH1 wired to nothing.
3. **An on-board `ClkSweep` left running** on that channel would fight the
   Bode sweep. `ClkFreq` stops it, but the generator still sends an explicit
   stop in `prepare`.
4. **I²C2 is shared with the EEPROM.** Today no firmware code touches the
   EEPROM, so there is no conflict.
5. **Common ground.** The board, the circuit and the scope must share ground.
   The board is powered by USB from the same Mac as the scope, so that is
   normally true. Use 10× probes or 50 Ω termination on CLKx above a few MHz,
   or the edges ring and the "input" channel is not what the circuit sees.
6. **Windows:** `serialport` needs its prebuilt binary in the `.exe` and in
   `install-windows.ps1`. COM port names differ, and CH340 drivers are needed.
   CI covers the build, not the device.

## Plan

| Step | What | Done when |
|---|---|---|
| 1 | `Generator` interface; move the AFG code into `scopeAfg` | existing Bode tests pass unchanged |
| 2 | `server/board.ts` (serialport, packet codec, the 6 commands, exclusive open, CH340 detection) + `sim/board.ts` | unit tests against the simulated board, incl. lost reply and busy port |
| 3 | `boardClock` generator, achieved-frequency lock-in, wiring check on CH1; sim scope fed by the sim board | end-to-end sim sweep of the simulated low-pass finds its corner (test: within 8 %; it gives 19.6 kHz for 20 kHz with 12 points) |
| 4 | Bode view: generator selector, Board card (status, CLK outputs, drive, Detect); docs, README, TODO. *Changed:* no Connect-panel row — the board is connected from the Bode view, where it is used | UI test (Playwright), axe clean |
| 5 | **On the bench:** RC low-pass, R = 1.6 kΩ, C = 1 nF (corner ≈ 100 kHz), 10:1 divider in front | measured corner and −45° within a few % of 1/(2πRC); same circuit with GEN OUT overlaps where the ranges meet |
| 6 (optional) | Board-only sine sweep (`SweepXxx`) as a third source for 0.1 Hz – low kHz, no scope needed; one Bode plot stitched from two sources | low band and high band meet without a step |

Steps 1–4 are done. Step 5 needs you, the board, the scope and an RC.

## What I need from you

1. **Which chip** — the Si5351 already on I²C2 (P1 pins 12/13), or a different
   one? If different: its part number and the pins it is on.
2. **Does your MHO984 have the AFG option?** If not, the board is your only
   generator and step 6 (low frequencies) matters more.
3. **The frequency range you want to sweep,** and what circuits (passive
   filters, amplifiers, a loop?). That decides whether the square-wave source is
   enough.
