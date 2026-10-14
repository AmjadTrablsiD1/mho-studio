// What the app can read and set on a Siglent-made oscilloscope: the Teledyne
// T3DSO1000 series (T3DSO1204 in the lab) and Siglent's SDS1000X-E, which it
// is built on. Commands are Siglent's SCPI set (LeCroy-style headers: C1:VDIV,
// TDIV, TRMD, TRSE…), with no VBS automation and no VICP. Replies and formats
// were checked on a T3DSO1204 (fw 8.3.6.1.37R8); see core/src/scpi/siglent.ts.
//
// Common quantities use the same ids as the other families, so the screen, the
// inspector and the run keys work unchanged. A query a firmware does not
// answer is learned and not asked again.

import type { Control, Kind } from "./controls.ts";
import type { Measurement } from "./measurements.ts";
import { C } from "../constants.ts";

const CH = { name: "n", values: [1, 2, 3, 4] };
const opts = (...v: [string, string][]) => v.map(([value, label]) => ({ value, label }));
const same = (...v: string[]) => v.map((x) => ({ value: x, label: x }));

type Spec = Partial<Control> & { id: string; label: string; kind: Kind; header: string };

function ctl(s: Spec): Control {
  const [group, ...rest] = s.id.split(".");
  return {
    section: "Siglent SDS1000X-E programming guide",
    group,
    sub: rest.length >= 2 ? rest[0] : null,
    set: s.kind !== "readonly",
    query: s.kind !== "action",
    suffix: null,
    ...s,
  };
}

/** A setting with the same header to read and to write ("C<n>:VDIV?" / "C<n>:VDIV {v}"). */
const rw = (h: string) => ({ header: h, q: `${h}?`, w: `${h} {v}` });

// {src}: the trigger source (C1…C4, EX, EX5, LINE); {type}: the trigger type (EDGE, GLIT…), both from the mirror.
export const SIGLENT_CONTROLS: Control[] = [
  // ---------------------------------------------------------- channels
  ctl({ id: "channel.display", label: "Display", kind: "bool", ...rw("C<n>:TRA"), suffix: CH, primary: true, watch: true, after: ["acquire.srate", "acquire.mdepth"] }),
  ctl({ id: "channel.scale", label: "Scale", kind: "number", unit: "V", step: "125", ...rw("C<n>:VDIV"), suffix: CH, primary: true, watch: true, after: ["channel.offset"], help: "Includes the probe factor: 1 V/div with a 10× probe is 1 V/div at the probe tip." }),
  ctl({ id: "channel.offset", label: "Offset", kind: "number", unit: "V", ...rw("C<n>:OFST"), suffix: CH, primary: true, watch: true }),
  ctl({
    id: "channel.coupling", label: "Coupling / input", kind: "enum", ...rw("C<n>:CPL"), suffix: CH, primary: true,
    options: opts(["D1M", "DC 1 MΩ"], ["A1M", "AC 1 MΩ"], ["D50", "DC 50 Ω"], ["A50", "AC 50 Ω"], ["GND", "Ground"]),
  }),
  ctl({
    id: "channel.probe", label: "Probe attenuation", kind: "enum", unit: "×", ...rw("C<n>:ATTN"), suffix: CH, primary: true, after: ["channel.scale", "channel.offset"],
    options: same("0.1", "0.2", "0.5", "1", "2", "5", "10", "20", "50", "100", "200", "500", "1000", "2000", "5000", "10000"),
  }),
  ctl({ id: "channel.bwlimit", label: "20 MHz bandwidth limit", kind: "bool", ...rw("C<n>:BWL"), suffix: CH }),
  ctl({ id: "channel.invert", label: "Invert", kind: "bool", ...rw("C<n>:INVS"), suffix: CH }),
  ctl({ id: "channel.unit", label: "Unit", kind: "enum", ...rw("C<n>:UNIT"), suffix: CH, options: opts(["V", "Volts"], ["A", "Amps (current probe)"]) }),
  ctl({ id: "channel.deskew", label: "Deskew", kind: "number", unit: "s", ...rw("C<n>:SKEW"), suffix: CH, min: -1e-7, max: 1e-7 }),

  // ---------------------------------------------------------- timebase and acquisition
  ctl({ id: "timebase.scale", label: "Time / div", kind: "number", unit: "s", step: "125", ...rw("TDIV"), primary: true, watch: true, after: ["acquire.srate", "acquire.mdepth"], help: `The screen is ${C.siglent.divisions_x} divisions wide.` }),
  ctl({
    id: "timebase.offset", label: "Screen centre", kind: "readonly", unit: "s", header: "(from Trigger delay)", query: false,
    help: "The time at the centre of the screen, from the trigger: minus the trigger delay. Move it with Trigger delay or the T marker.",
  }),
  ctl({ id: "timebase.delay", label: "Trigger delay", kind: "number", unit: "s", ...rw("TRDL"), primary: true, watch: true, help: "Positive moves the trigger point right of the centre (more of the time before the trigger on screen)." }),
  ctl({ id: "acquire.mdepth", label: "Memory depth", kind: "enum", unit: "pts", ...rw("MSIZ"), primary: true, watch: true, after: ["acquire.srate"], options: same(...C.siglent.memory_options), help: "7K…7M when both channels of a pair (CH1/CH2, CH3/CH4) are on; 14K…14M with one of the pair." }),
  ctl({ id: "acquire.srate", label: "Sample rate", kind: "readonly", unit: "Sa/s", header: "SARA", q: "SARA?", primary: true }),
  ctl({
    id: "acquire.type", label: "Acquisition", kind: "enum", header: "ACQW", q: "ACQW?", w: "ACQW {v}", pick: 0, primary: true, after: ["acquire.averages"],
    options: opts(["SAMPLING", "Normal"], ["PEAK_DETECT", "Peak detect"], ["AVERAGE", "Average"], ["HIGH_RES", "Eres (high resolution)"]),
  }),
  ctl({ id: "acquire.averages", label: "Averages", kind: "enum", ...rw("AVGA"), options: same("4", "16", "32", "64", "128", "256", "512", "1024"), when: { id: "acquire.type", is: ["AVERAGE"] } }),

  // ---------------------------------------------------------- trigger
  ctl({
    id: "trigger.sweep", label: "Trigger mode", kind: "enum", ...rw("TRMD"), primary: true, watch: true,
    options: opts(["AUTO", "Auto"], ["NORM", "Normal"], ["SINGLE", "Single"], ["STOP", "Stop"]),
  }),
  ctl({
    id: "trigger.mode", label: "Trigger type", kind: "enum", header: "TRIG_SELECT", q: "TRSE?", w: "TRSE {v},SR,{src}", pick: 0, primary: true, watch: true,
    options: opts(["EDGE", "Edge"], ["SLEW", "Slope"], ["GLIT", "Pulse width"], ["INTV", "Interval"], ["RUNT", "Runt"], ["DROP", "Dropout"]),
    help: "The conditions of the other types are set on the instrument or from the console (TRSE); the app sets the type and its source.",
  }),
  ctl({
    id: "trigger.edge.source", sub: null, label: "Source", kind: "enum", header: "TRIG_SELECT …,SR", q: "TRSE?", w: "TRSE {type},SR,{v}", pick: "SR", primary: true, watch: true,
    options: opts(["C1", "CH1"], ["C2", "CH2"], ["C3", "CH3"], ["C4", "CH4"], ["EX", "Ext"], ["EX5", "Ext/5"], ["LINE", "Line"]),
    after: ["trigger.edge.level", "trigger.edge.slope", "trigger.coupling"],
  }),
  ctl({ id: "trigger.edge.level", sub: null, label: "Level", kind: "number", unit: "V", ...rw("{src}:TRLV"), primary: true, watch: true }),
  ctl({ id: "trigger.edge.slope", sub: null, label: "Slope", kind: "enum", ...rw("{src}:TRSL"), primary: true, options: opts(["POS", "Rising"], ["NEG", "Falling"], ["WINDOW", "Either"]) }),
  ctl({ id: "trigger.coupling", label: "Coupling", kind: "enum", ...rw("{src}:TRCP"), options: opts(["DC", "DC"], ["AC", "AC"], ["HFREJ", "HF reject"], ["LFREJ", "LF reject"]) }),

  // ---------------------------------------------------------- actions
  ctl({ id: "root.run", label: "Run", kind: "action", header: "TRIG_MODE AUTO / NORM" }),
  ctl({ id: "root.stop", label: "Stop", kind: "action", header: "STOP" }),
  ctl({ id: "root.single", label: "Single", kind: "action", header: "TRIG_MODE SINGLE" }),
  ctl({ id: "root.tforce", label: "Force trigger", kind: "action", header: "FORCE_TRIGGER" }),
  ctl({ id: "root.autoset", label: "Auto setup", kind: "action", header: "AUTO_SETUP", confirm: "Auto setup changes the vertical, timebase and trigger settings of every channel. Continue?" }),
  ctl({ id: "common.rst", label: "Reset to defaults (*RST)", kind: "action", header: "*RST", confirm: "*RST returns the instrument to its default setup; the current setup is lost unless saved. Continue?" }),
  ctl({ id: "common.cls", label: "Clear status (*CLS)", kind: "action", header: "*CLS" }),
];

/** The run keys and actions: what goes on the wire. Run restores the last running trigger mode. */
export const SIGLENT_ACTIONS: Record<string, string> = {
  "root.stop": "STOP",
  "root.single": "TRMD SINGLE",
  "root.tforce": "FRTR",
  "root.autoset": "ASET",
  "common.rst": "*RST",
  "common.cls": "*CLS",
};

/** PARAMETER_VALUE? names of the SDS1000X-E guide, with the app's own computation of each for the cross-check. */
export const SIGLENT_MEASUREMENTS: Measurement[] = [
  { item: "PKPK", label: "Peak-peak", unit: "V", category: "vertical", cross: "VPP" },
  { item: "MAX", label: "Maximum", unit: "V", category: "vertical", cross: "VMAX" },
  { item: "MIN", label: "Minimum", unit: "V", category: "vertical", cross: "VMIN" },
  { item: "AMPL", label: "Amplitude", unit: "V", category: "vertical", cross: "VAMP" },
  { item: "TOP", label: "Top", unit: "V", category: "vertical", cross: "VTOP" },
  { item: "BASE", label: "Base", unit: "V", category: "vertical", cross: "VBASe" },
  { item: "MEAN", label: "Mean", unit: "V", category: "vertical", cross: "VAVG" },
  { item: "CMEAN", label: "Mean (one cycle)", unit: "V", category: "vertical" },
  { item: "RMS", label: "RMS", unit: "V", category: "vertical", cross: "VRMS" },
  { item: "CRMS", label: "RMS (one cycle)", unit: "V", category: "vertical" },
  { item: "STDEV", label: "Standard deviation", unit: "V", category: "vertical", cross: "ACRMs" },
  { item: "OVSP", label: "Overshoot +", unit: "%", category: "vertical", percent: true, cross: "OVERshoot" },
  { item: "OVSN", label: "Overshoot −", unit: "%", category: "vertical", percent: true },
  { item: "RPRE", label: "Preshoot (rising)", unit: "%", category: "vertical", percent: true, cross: "PREShoot" },
  { item: "PER", label: "Period", unit: "s", category: "horizontal", cross: "PERiod" },
  { item: "FREQ", label: "Frequency", unit: "Hz", category: "horizontal", cross: "FREQuency" },
  { item: "PWID", label: "Positive width", unit: "s", category: "horizontal", cross: "PWIDth" },
  { item: "NWID", label: "Negative width", unit: "s", category: "horizontal", cross: "NWIDth" },
  { item: "RISE", label: "Rise time 10–90 %", unit: "s", category: "horizontal", cross: "RTIMe" },
  { item: "FALL", label: "Fall time 90–10 %", unit: "s", category: "horizontal", cross: "FTIMe" },
  { item: "DUTY", label: "Duty cycle +", unit: "%", category: "horizontal", percent: true, cross: "PDUTy" },
  { item: "NDUTY", label: "Duty cycle −", unit: "%", category: "horizontal", percent: true, cross: "NDUTy" },
  { item: "DELAY", label: "Delay (trigger to first edge)", unit: "s", category: "other" },
];

/** Commands offered by the console's Tab completion (the SDS1000X-E guide's common set). */
export const SIGLENT_CONSOLE: { header: string; set: boolean; query: boolean; section: string; params: { name: string; type: string; options?: string[]; range?: string }[] }[] = [
  ["*IDN", false, true, "identification"], ["*RST", true, false, "reset"], ["*CLS", true, false, "clear status"], ["*ESR", false, true, "event status register"], ["*OPC", true, true, "operation complete"],
  ["CHDR", true, true, "COMM_HEADER OFF|SHORT|LONG"], ["CMR", false, true, "command error register"], ["EXR", false, true, "execution error register"], ["INR", false, true, "internal state register"],
  ["C1:TRA", true, true, "trace ON|OFF"], ["C1:VDIV", true, true, "volts/div"], ["C1:OFST", true, true, "offset"], ["C1:CPL", true, true, "coupling A1M|A50|D1M|D50|GND"],
  ["C1:ATTN", true, true, "probe attenuation"], ["C1:BWL", true, true, "20 MHz limit ON|OFF"], ["C1:INVS", true, true, "invert ON|OFF"], ["C1:SKEW", true, true, "deskew"], ["C1:UNIT", true, true, "unit V|A"],
  ["TDIV", true, true, "time/div"], ["TRDL", true, true, "trigger delay"], ["MSIZ", true, true, "memory depth 7K…14M"], ["SARA", false, true, "sample rate"], ["SANU", false, true, "points (SANU? C1)"],
  ["ACQW", true, true, "acquisition SAMPLING|PEAK_DETECT|AVERAGE|HIGH_RES"], ["AVGA", true, true, "averages"], ["SAST", false, true, "acquisition status"],
  ["TRMD", true, true, "trigger mode AUTO|NORM|SINGLE|STOP"], ["TRSE", true, true, "trigger select EDGE,SR,C1,HT,OFF"],
  ["C1:TRLV", true, true, "trigger level"], ["C1:TRSL", true, true, "trigger slope POS|NEG|WINDOW"], ["C1:TRCP", true, true, "trigger coupling"],
  ["ARM", true, false, "arm"], ["STOP", true, false, "stop"], ["FRTR", true, false, "force trigger"], ["ASET", true, false, "auto setup"],
  ["WFSU", true, true, "waveform setup SP,NP,FP"], ["C1:WF", false, true, "waveform DESC|DAT2"], ["C1:PAVA", false, true, "parameter value (e.g. C1:PAVA? FREQ)"],
  ["SCDP", false, false, "screen dump (raw BMP)"], ["PNSU", true, true, "panel setup (XML)"],
].map(([header, set, query, section]) => ({ header: header as string, set: set as boolean, query: query as boolean, section: section as string, params: [] }));
