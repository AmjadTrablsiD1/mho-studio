// What the app can read and set on a Teledyne LeCroy X-Stream oscilloscope
// (WaveRunner / WavePro / WaveMaster / SDA / DDA / LabMaster — the Windows
// ones, about 2004 onwards). The model is not known in advance, so this list
// keeps to commands every X-Stream model documents:
//  • the legacy remote-control set (C1:VDIV, TDIV, TRMD, TRSE, …);
//  • a few values only VBS automation exposes (VBS? 'return=app.…').
// Property names, types and option values follow LeCroy's X-Stream
// automation manual (June 2003, WaveMaster / WavePro 7000). Anything else the
// instrument can do is reachable from the console: a VBS line can set any
// property of the instrument's automation object model.
//
// Common quantities use the same ids as the RIGOL registry (channel.scale,
// trigger.edge.level, …), so the screen, the inspector and the run keys work
// for both families. A query a model does not answer is learned and not asked
// again, exactly as on the RIGOL.

import type { Control, Kind } from "./controls.ts";
import type { Measurement } from "./measurements.ts";

const CH = { name: "n", values: [1, 2, 3, 4] };
const opts = (...v: [string, string][]) => v.map(([value, label]) => ({ value, label }));

type Spec = Partial<Control> & { id: string; label: string; kind: Kind; header: string };

function ctl(s: Spec): Control {
  const [group, ...rest] = s.id.split(".");
  return {
    section: "LeCroy remote control manual",
    group,
    sub: rest.length >= 2 ? rest[0] : null,
    set: s.kind !== "readonly",
    query: s.kind !== "action",
    suffix: null,
    ...s,
  };
}

const vbs = (prop: string) => `VBS? 'return=app.${prop}'`;
const vbsSet = (prop: string) => `VBS 'app.${prop} = {v}'`;

/** A control backed by one automation property (VBS), read and written as app.<prop>. */
function vb(s: Omit<Spec, "header"> & { prop: string }): Control {
  const { prop, ...rest } = s;
  return ctl({ header: `app.${prop}`, q: vbs(prop), ...(s.kind === "readonly" ? {} : { w: vbsSet(prop) }), ...rest });
}

const TIME = { kind: "number" as const, unit: "s" };
const opt1 = (...v: string[]) => v.map((x) => ({ value: x, label: x.replace(/([a-z])([A-Z])/g, "$1 $2") }));
const TRIG_SOURCES = opts(["C1", "CH1"], ["C2", "CH2"], ["C3", "CH3"], ["C4", "CH4"], ["Ext", "Ext"], ["ExtDivide10", "Ext/10"], ["Line", "Line"]);
const when = (id: string, ...is: string[]) => ({ when: { id, is } });

// Property names, types and values below are those of the X-Stream automation
// manual (WaveMaster / WavePro 7000 / DDA-5005, June 2003 — the first X-Stream
// generation; later models keep these and add more).
export const LECROY_CONTROLS: Control[] = [
  // ---------------------------------------------------------- channels
  ctl({ id: "channel.display", label: "Display", kind: "bool", header: "C<n>:TRACE", q: "C<n>:TRA?", w: "C<n>:TRA {v}", b: "Acquisition.C<n>.View", suffix: CH, primary: true, watch: true }),
  ctl({ id: "channel.scale", label: "Scale", kind: "number", unit: "V", step: "125", header: "C<n>:VOLT_DIV", q: "C<n>:VDIV?", w: "C<n>:VDIV {v}", b: "Acquisition.C<n>.VerScale", suffix: CH, primary: true, watch: true, after: ["channel.offset"] }),
  ctl({ id: "channel.offset", label: "Offset", kind: "number", unit: "V", header: "C<n>:OFFSET", q: "C<n>:OFST?", w: "C<n>:OFST {v}", b: "Acquisition.C<n>.VerOffset", suffix: CH, primary: true, watch: true }),
  ctl({
    id: "channel.coupling", label: "Coupling / input", kind: "enum", header: "C<n>:COUPLING", q: "C<n>:CPL?", w: "C<n>:CPL {v}", suffix: CH, primary: true,
    options: opts(["D1M", "DC 1 MΩ"], ["A1M", "AC 1 MΩ"], ["D50", "DC 50 Ω"], ["GND", "Ground"]),
    help: "Choices vary by model: the high-bandwidth WaveMasters have only DC 50 Ω and ground. The instrument answers what it set.",
  }),
  ctl({ id: "channel.probe", label: "Probe attenuation", kind: "number", unit: "×", header: "C<n>:ATTENUATION", q: "C<n>:ATTN?", w: "C<n>:ATTN {v}", suffix: CH }),
  vb({
    id: "channel.bwlimit", label: "Bandwidth limit", kind: "enum", prop: "Acquisition.C<n>.BandwidthLimit", suffix: CH, options: opt1("Full", "20MHz", "200MHz", "1GHz", "3GHz", "4GHz"),
    help: "The filters offered vary by model; one it lacks is refused and the read-back shows what stayed set.",
  }),
  vb({ id: "channel.invert", label: "Invert", kind: "bool", prop: "Acquisition.C<n>.Invert", suffix: CH }),
  vb({ id: "channel.averages", label: "Averaging (sweeps)", kind: "number", min: 1, max: 1000000, step: 1, prop: "Acquisition.C<n>.AverageSweeps", suffix: CH }),
  vb({ id: "channel.deskew", label: "Deskew", ...TIME, min: -0.1, max: 0.1, prop: "Acquisition.C<n>.Deskew", suffix: CH }),
  vb({ id: "channel.interpolate", label: "Interpolation", kind: "enum", prop: "Acquisition.C<n>.InterpolateType", suffix: CH, options: opts(["Linear", "Linear"], ["Sinxx", "sin x / x"]) }),
  vb({
    id: "channel.label.content", label: "Name", kind: "string", prop: "Acquisition.C<n>.LabelsText", suffix: CH, primary: true,
    then: [{ id: "channel.label.show", value: true }],
    help: "Shown on the instrument's screen and in this app. Several labels: separate with commas.",
  }),
  vb({ id: "channel.label.show", label: "Show name on screen", kind: "bool", prop: "Acquisition.C<n>.ViewLabels", suffix: CH }),
  vb({ id: "channel.label.position", label: "Name position (s)", kind: "string", prop: "Acquisition.C<n>.LabelsPosition", suffix: CH, help: "Where on the trace the name sits, as a time (e.g. 0, or 0,55e-9 for two labels)." }),

  // ---------------------------------------------------------- timebase and acquisition
  ctl({ id: "timebase.scale", label: "Time / div", kind: "number", unit: "s", step: "125", header: "TIME_DIV", q: "TDIV?", w: "TDIV {v}", b: "Acquisition.Horizontal.HorScale", primary: true, watch: true, after: ["acquire.srate", "acquire.mdepth"] }),
  ctl({
    id: "timebase.offset", label: "Screen centre", kind: "readonly", unit: "s", header: "(from the waveform descriptor)", query: false,
    help: "The time at the centre of the record, taken from each waveform's descriptor (HORIZ_OFFSET + half the record). Move it with Trigger position.",
  }),
  vb({ id: "timebase.delay", label: "Trigger position", ...TIME, prop: "Acquisition.Horizontal.HorOffset", primary: true, watch: true, help: "Seconds from its origin (normally the screen centre); positive moves the trigger to the right." }),
  ctl({ id: "acquire.mdepth", label: "Memory (max points)", kind: "number", unit: "pts", step: "125", header: "MEMORY_SIZE", q: "MSIZ?", w: "MSIZ {v}", primary: true, after: ["acquire.srate", "timebase.scale"] }),
  vb({ id: "acquire.srate", label: "Sample rate", kind: "readonly", unit: "Sa/s", prop: "Acquisition.Horizontal.SamplingRate", primary: true }),
  vb({ id: "acquire.mode", label: "Sampling mode", kind: "enum", prop: "Acquisition.Horizontal.SampleMode", primary: true, options: opts(["RealTime", "Real time"], ["RIS", "RIS"], ["Sequence", "Sequence"]), after: ["acquire.srate"], help: "RIS and sequence are not available at every timebase, nor together." }),
  vb({ id: "acquire.segments", label: "Segments", kind: "number", min: 2, max: 20000, step: 1, prop: "Acquisition.Horizontal.NumSegments", ...when("acquire.mode", "Sequence") }),
  vb({ id: "acquire.channels", label: "Active channels", kind: "enum", prop: "Acquisition.Horizontal.ActiveChannels", options: opts(["Auto", "Auto"], ["4", "4"], ["2", "2 (faster)"]), after: ["acquire.srate"], help: "Two channels interleave for the higher sample rate." }),
  vb({ id: "acquire.memorymode", label: "Memory management", kind: "enum", prop: "Acquisition.Horizontal.SmartMemory", options: opts(["SetMaximumMemory", "Maximum memory"], ["FixedSampleRate", "Fixed sample rate"]), after: ["acquire.srate", "acquire.mdepth"] }),

  // ---------------------------------------------------------- trigger: common
  ctl({
    id: "trigger.sweep", label: "Trigger mode", kind: "enum", header: "TRIG_MODE", q: "TRMD?", w: "TRMD {v}", primary: true, watch: true,
    b: "Acquisition.TriggerMode", bmap: { Auto: "AUTO", Normal: "NORM", Single: "SINGLE", Stop: "STOP", Stopped: "STOP" },
    options: opts(["AUTO", "Auto"], ["NORM", "Normal"], ["SINGLE", "Single"], ["STOP", "Stop"]),
  }),
  vb({
    id: "trigger.mode", label: "Trigger type", kind: "enum", prop: "Acquisition.Trigger.Type", primary: true, watch: true,
    options: opt1("Edge", "Width", "Glitch", "Interval", "Dropout", "Logic", "Qualify", "State"),
    help: "Newer models offer more (runt, slew rate, TV, serial…); set those on the instrument or with VBS from the console.",
  }),
  vb({ id: "trigger.edge.source", sub: null, label: "Source", kind: "enum", prop: "Acquisition.Trigger.Source", primary: true, watch: true, options: TRIG_SOURCES, after: ["trigger.edge.level", "trigger.edge.slope", "trigger.coupling"] }),
  vb({ id: "trigger.edge.level", sub: null, label: "Level", kind: "number", unit: "V", prop: "Acquisition.Trigger.{src}.Level", primary: true, watch: true }),
  vb({ id: "trigger.edge.slope", sub: null, label: "Slope", kind: "enum", prop: "Acquisition.Trigger.{src}.Slope", primary: true, options: opts(["Positive", "Rising"], ["Negative", "Falling"]) }),
  ctl({
    id: "trigger.coupling", label: "Coupling", kind: "enum", header: "<source>:TRIG_COUPLING", q: "{lsrc}:TRCP?", w: "{lsrc}:TRCP {v}",
    options: opts(["DC", "DC"], ["AC", "AC"], ["HFREJ", "HF reject"], ["LFREJ", "LF reject"]),
  }),
  vb({ id: "trigger.holdoff.type", sub: null, label: "Holdoff", kind: "enum", prop: "Acquisition.Trigger.HoldoffType", options: opt1("Off", "Time", "Events") }),
  vb({ id: "trigger.holdoff", sub: null, label: "Holdoff time", ...TIME, min: 2e-9, max: 20, prop: "Acquisition.Trigger.HoldoffTime", ...when("trigger.holdoff.type", "Time") }),
  vb({ id: "trigger.holdoff.events", sub: null, label: "Holdoff events", kind: "number", min: 1, max: 1e9, step: 1, prop: "Acquisition.Trigger.HoldoffEvents", ...when("trigger.holdoff.type", "Events") }),

  // ---------------------------------------------------------- trigger: one panel per type
  vb({ id: "trigger.width.condition", label: "Trigger when width is", kind: "enum", prop: "Acquisition.Trigger.Width", options: opt1("GreaterThan", "LessThan", "InRange", "OutOfRange") }),
  vb({ id: "trigger.width.range", label: "Given as", kind: "enum", prop: "Acquisition.Trigger.WidthRange", options: opts(["Limits", "Lower / upper"], ["Delta", "Nominal ± delta"]) }),
  vb({ id: "trigger.width.nominal", label: "Nominal width", ...TIME, prop: "Acquisition.Trigger.WidthNominal", ...when("trigger.width.range", "Delta") }),
  vb({ id: "trigger.width.delta", label: "± delta", ...TIME, prop: "Acquisition.Trigger.WidthDelta", ...when("trigger.width.range", "Delta") }),
  vb({ id: "trigger.width.low", label: "Lower limit", ...TIME, prop: "Acquisition.Trigger.GlitchLow", ...when("trigger.width.range", "Limits") }),
  vb({ id: "trigger.width.high", label: "Upper limit", ...TIME, prop: "Acquisition.Trigger.GlitchHigh", ...when("trigger.width.range", "Limits") }),

  vb({ id: "trigger.glitch.condition", label: "Trigger on a glitch", kind: "enum", prop: "Acquisition.Trigger.Glitch", options: opts(["LessThan", "narrower than"], ["InRange", "within range"]) }),
  vb({ id: "trigger.glitch.high", label: "Upper limit", ...TIME, prop: "Acquisition.Trigger.GlitchHigh" }),
  vb({ id: "trigger.glitch.low", label: "Lower limit", ...TIME, prop: "Acquisition.Trigger.GlitchLow", ...when("trigger.glitch.condition", "InRange") }),

  vb({ id: "trigger.interval.condition", label: "Trigger when interval is", kind: "enum", prop: "Acquisition.Trigger.Interval", options: opt1("GreaterThan", "LessThan", "InRange", "OutOfRange") }),
  vb({ id: "trigger.interval.range", label: "Given as", kind: "enum", prop: "Acquisition.Trigger.IntervalRange", options: opts(["Limits", "Lower / upper"], ["Delta", "Nominal ± delta"]) }),
  vb({ id: "trigger.interval.nominal", label: "Nominal interval", ...TIME, prop: "Acquisition.Trigger.IntervalNominal", ...when("trigger.interval.range", "Delta") }),
  vb({ id: "trigger.interval.delta", label: "± delta", ...TIME, prop: "Acquisition.Trigger.IntervalDelta", ...when("trigger.interval.range", "Delta") }),
  vb({ id: "trigger.interval.low", label: "Lower limit", ...TIME, prop: "Acquisition.Trigger.IntervalLow", ...when("trigger.interval.range", "Limits") }),
  vb({ id: "trigger.interval.high", label: "Upper limit", ...TIME, prop: "Acquisition.Trigger.IntervalHigh", ...when("trigger.interval.range", "Limits") }),

  vb({ id: "trigger.dropout.time", label: "Dropout time", ...TIME, min: 2e-9, max: 20, prop: "Acquisition.Trigger.DropoutTime", help: "Triggers when no edge has come for this long." }),

  vb({ id: "trigger.logic.type", label: "Pattern logic", kind: "enum", prop: "Acquisition.Trigger.PatternType", options: opt1("And", "Nand", "Or", "Nor") }),
  vb({ id: "trigger.logic.state", label: "State", kind: "enum", prop: "Acquisition.Trigger.C<n>.PatternState", suffix: CH, options: opts(["DontCare", "Don't care"], ["High", "High"], ["Low", "Low"]) }),
  vb({ id: "trigger.logic.level", label: "Threshold", kind: "number", unit: "V", prop: "Acquisition.Trigger.C<n>.Level", suffix: CH }),

  vb({ id: "trigger.qualify.source", label: "Qualifying source", kind: "enum", prop: "Acquisition.Trigger.ValidateSource", options: TRIG_SOURCES.filter((o) => o.value !== "Line") }),
  vb({ id: "trigger.qualify.state", label: "Qualified while", kind: "enum", prop: "Acquisition.Trigger.QualState", options: opts(["Above", "above its level"], ["Below", "below its level"]) }),
  vb({ id: "trigger.qualify.wait", label: "Then wait", kind: "enum", prop: "Acquisition.Trigger.QualWait", options: opts(["Off", "No wait"], ["GreaterThan", "Longer than"], ["LessThan", "Shorter than"], ["Events", "Events"]) }),
  vb({ id: "trigger.qualify.time", label: "Time", ...TIME, prop: "Acquisition.Trigger.QualTime", ...when("trigger.qualify.wait", "GreaterThan", "LessThan") }),
  vb({ id: "trigger.qualify.events", label: "Events", kind: "number", min: 1, max: 99999999, step: 1, prop: "Acquisition.Trigger.QualEvents", ...when("trigger.qualify.wait", "Events") }),
  vb({ id: "trigger.qualify.first", label: "Qualify first segment only", kind: "bool", prop: "Acquisition.Trigger.QualFirst", help: "Sequence mode only." }),

  vb({ id: "trigger.state.source", label: "Qualifying source", kind: "enum", prop: "Acquisition.Trigger.ValidateSource", options: TRIG_SOURCES.filter((o) => o.value !== "Line") }),
  vb({ id: "trigger.state.state", label: "Trigger while it is", kind: "enum", prop: "Acquisition.Trigger.QualState", options: opts(["Above", "above its level"], ["Below", "below its level"]) }),

  // ---------------------------------------------------------- actions
  ctl({ id: "root.run", label: "Run", kind: "action", header: "TRIG_MODE NORM / AUTO" }),
  ctl({ id: "root.stop", label: "Stop", kind: "action", header: "STOP" }),
  ctl({ id: "root.single", label: "Single", kind: "action", header: "TRIG_MODE SINGLE" }),
  ctl({ id: "root.tforce", label: "Force trigger", kind: "action", header: "FORCE_TRIGGER" }),
  ctl({ id: "root.autoset", label: "Auto setup", kind: "action", header: "AUTO_SETUP", confirm: "Auto setup changes the vertical, timebase and trigger settings of every channel. Continue?" }),
  ctl({ id: "trigger.zerolevel", label: "Level to 0 V", kind: "action", header: "app.Acquisition.Trigger.ZeroLevel" }),
  ctl({ id: "acquire.clearsweeps", label: "Clear sweeps", kind: "action", header: "app.Acquisition.ClearSweeps", help: "Restart averaging and persistence." }),
  ctl({ id: "common.rst", label: "Reset to defaults (*RST)", kind: "action", header: "*RST", confirm: "*RST returns the instrument to its default setup; the current setup is lost unless saved. Continue?" }),
  ctl({ id: "common.cls", label: "Clear status (*CLS)", kind: "action", header: "*CLS" }),
];

/** Trigger type → the registry sub-group with its fields (Edge's fields are the common ones). */
export const LECROY_TRIGGER_SUB: Record<string, string> = {
  Width: "width", Glitch: "glitch", Interval: "interval", Dropout: "dropout", Logic: "logic", Qualify: "qualify", State: "state",
};

/** The run keys and actions: what goes on the wire. Run restores the last running trigger mode. */
export const LECROY_ACTIONS: Record<string, string> = {
  "root.stop": "STOP",
  "root.single": "TRMD SINGLE",
  "root.tforce": "FRTR",
  "root.autoset": "ASET",
  "trigger.zerolevel": "VBS 'app.Acquisition.Trigger.ZeroLevel'",
  "acquire.clearsweeps": "VBS 'app.Acquisition.ClearSweeps'",
  "common.rst": "*RST",
  "common.cls": "*CLS",
};

/** PARAMETER_VALUE? names, with the app's own computation of each for the cross-check. */
export const LECROY_MEASUREMENTS: Measurement[] = [
  { item: "MAX", label: "Maximum", unit: "V", category: "vertical", cross: "VMAX" },
  { item: "MIN", label: "Minimum", unit: "V", category: "vertical", cross: "VMIN" },
  { item: "PKPK", label: "Peak-peak", unit: "V", category: "vertical", cross: "VPP" },
  { item: "TOP", label: "Top", unit: "V", category: "vertical", cross: "VTOP" },
  { item: "BASE", label: "Base", unit: "V", category: "vertical", cross: "VBASe" },
  { item: "AMPL", label: "Amplitude", unit: "V", category: "vertical", cross: "VAMP" },
  { item: "MEAN", label: "Mean", unit: "V", category: "vertical", cross: "VAVG" },
  { item: "RMS", label: "RMS", unit: "V", category: "vertical", cross: "VRMS" },
  { item: "SDEV", label: "Standard deviation", unit: "V", category: "vertical", cross: "ACRMs" },
  { item: "OVSP", label: "Overshoot +", unit: "%", category: "vertical", percent: true, cross: "OVERshoot" },
  { item: "OVSN", label: "Overshoot −", unit: "%", category: "vertical", percent: true },
  { item: "AREA", label: "Area", unit: "V·s", category: "vertical", cross: "MARea" },
  { item: "PER", label: "Period", unit: "s", category: "horizontal", cross: "PERiod" },
  { item: "FREQ", label: "Frequency", unit: "Hz", category: "horizontal", cross: "FREQuency" },
  { item: "RISE", label: "Rise time 10–90 %", unit: "s", category: "horizontal", cross: "RTIMe" },
  { item: "FALL", label: "Fall time 90–10 %", unit: "s", category: "horizontal", cross: "FTIMe" },
  { item: "RISE28", label: "Rise time 20–80 %", unit: "s", category: "horizontal" },
  { item: "FALL82", label: "Fall time 80–20 %", unit: "s", category: "horizontal" },
  { item: "PWID", label: "+Width", unit: "s", category: "horizontal", cross: "PWIDth" },
  { item: "NWID", label: "−Width", unit: "s", category: "horizontal", cross: "NWIDth" },
  { item: "DUTY", label: "Duty cycle", unit: "%", category: "horizontal", percent: true, cross: "PDUTy" },
  { item: "DLY", label: "Delay (trigger to first 50 % crossing)", unit: "s", category: "other" },
];

/** Commands offered by the console's Tab completion (the X-Stream remote control manual's common set). */
export const LECROY_CONSOLE: { header: string; set: boolean; query: boolean; section: string; params: { name: string; type: string; options?: string[]; range?: string }[] }[] = [
  ["*IDN", false, true, "identification"], ["*RST", true, false, "reset"], ["*CLS", true, false, "clear status"], ["*OPC", true, true, "operation complete"],
  ["CHDR", true, true, "COMM_HEADER OFF|SHORT|LONG"], ["CFMT", true, true, "COMM_FORMAT DEF9,BYTE|WORD,BIN"], ["CORD", true, true, "COMM_ORDER HI|LO"],
  ["CMR", false, true, "command error register"], ["EXR", false, true, "execution error register"], ["INR", false, true, "internal state register"],
  ["C1:TRA", true, true, "trace on/off"], ["C1:VDIV", true, true, "volts/div"], ["C1:OFST", true, true, "offset"], ["C1:CPL", true, true, "coupling A1M|D1M|D50|GND"],
  ["C1:ATTN", true, true, "probe attenuation"], ["BWL", true, true, "bandwidth limit"], ["TDIV", true, true, "time/div"], ["TRDL", true, true, "trigger delay"],
  ["MSIZ", true, true, "memory size"], ["TRMD", true, true, "trigger mode AUTO|NORM|SINGLE|STOP"], ["TRSE", true, true, "trigger select"],
  ["C1:TRLV", true, true, "trigger level"], ["C1:TRSL", true, true, "trigger slope POS|NEG"], ["C1:TRCP", true, true, "trigger coupling"],
  ["ARM", true, false, "arm acquisition"], ["STOP", true, false, "stop"], ["FRTR", true, false, "force trigger"], ["ASET", true, false, "auto setup"],
  ["WAIT", true, false, "wait for acquisition"], ["WFSU", true, true, "waveform setup SP,NP,FP,SN"], ["C1:WF", false, true, "waveform DESC|TEXT|DAT1|ALL"],
  ["C1:PAVA", false, true, "parameter value (e.g. C1:PAVA? FREQ)"], ["HCSU", true, true, "hardcopy setup"], ["SCDP", true, false, "screen dump"],
  ["PNSU", true, true, "panel setup"], ["VBS", true, true, "VBS 'app.…' / VBS? 'return=app.…'"],
].map(([header, set, query, section]) => ({ header: header as string, set: set as boolean, query: query as boolean, section: section as string, params: [] }));
