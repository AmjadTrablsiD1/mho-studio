// Every value the app can read or set on the MHO984, as table entries.
//
// The base of each entry is generated from the programming guide
// (manual.json: header, parameter type, options, range, default). CURATED,
// below, adds what a table cannot know: good labels and units, 1-2-5 knob
// steps, which values are polled because someone may turn a knob on the real
// front panel, which writes need a confirmation, and when a field is relevant
// (a Pulse-trigger width only while the trigger type is Pulse).
//
// The server, the simulator and every settings panel are generated from this
// list; adding a feature is adding an entry, not a branch.

import manual from "./manual.json" with { type: "json" };
import { mnemonicLabel, optionLabel } from "./labels.ts";
import { shortForm } from "../scpi/header.ts";

export type Kind = "number" | "enum" | "bool" | "string" | "action" | "readonly";
export type Option = { value: string; label: string };
export type When = { id: string; is: string[] };

export type Control = {
  id: string;
  header: string;
  section: string;
  group: string;
  sub: string | null;
  label: string;
  kind: Kind;
  set: boolean;
  query: boolean;
  options?: Option[];
  min?: number;
  max?: number;
  unit?: string;
  def?: string | number | boolean;
  suffix: { name: string; values: number[] } | null;
  /** "125": the 1-2-5 sequence; "fine": ~1 % steps; a number: a fixed step. */
  step?: "125" | "fine" | number;
  when?: When;
  confirm?: string;
  /** Read at connect. */
  primary?: boolean;
  /** Re-read every watch period: a person at the instrument may change it. */
  watch?: boolean;
  /** Re-read these after a write (the instrument couples them). */
  after?: string[];
  /** Not offered as a generic field (special handling or console only). */
  hidden?: boolean;
  help?: string;
  /** Instrument option this needs (from :SYSTem:OPTion:STATus?). */
  needs?: string;
};

type Param = { name: string; type: string; options?: string[]; min?: number; max?: number; unit?: string; default?: string | number; range?: string };
type ManualEntry = { section: string; header: string; set: boolean; query: boolean; queryArgs: boolean; params: Param[] };

/** ":TRIGger:PULSe:UWIDth" → "trigger.pulse.uwidth"; the [:MAIN] node is dropped, other optional nodes kept. */
export function slug(header: string): string {
  if (header.startsWith("*")) return `common.${header.slice(1).toLowerCase()}`;
  const parts = header
    .replace(/\[:MAIN\]/gi, "")
    .replace(/[[\]]/g, "")
    .split(":")
    .filter(Boolean)
    .map((p) => p.replace(/<\w+>/, "").toLowerCase());
  if (parts.length === 1) return `root.${parts[0]}`;
  return parts.join(".");
}

const TRIGGER_SUB: Record<string, string> = {
  edge: "EDGE", pulse: "PULSe", slope: "SLOPe", video: "VIDeo", pattern: "PATTern", duration: "DURation", timeout: "TIMeout",
  runt: "RUNT", windows: "WINDow", delay: "DELay", shold: "SETup", nedge: "NEDGe", rs232: "RS232", iic: "IIC", spi: "SPI",
  can: "CAN", lin: "LIN", flexray: "FLEXray", iis: "IIS", m1553: "M1553",
};
const BUS_SUB: Record<string, string> = {
  parallel: "PARallel", rs232: "RS232", iic: "IIC", spi: "SPI", can: "CAN", lin: "LIN", flexray: "FLEXray", iis: "IIS", m1553: "M1553",
};
/** Options each needs: guide §3.4.16–18, §3.27.25–27, §3.5, §3.25. */
const NEEDS: Record<string, string> = { flexray: "FLEX", iis: "AUDio", m1553: "AERO" };

const V_WORDS = /^(LEVel|ALEVel|BLEVel|CLEVel|DLEVel|SLEVel|THReshold\d?|HIGH|LOW|DMAX|DMIN)$/;
const S_WORDS = /^(TIME|WIDTh|UWIDth|LWIDth|TUPPer|TLOWer|HOLDoff|STIMe|HTIMe|IDLE|WUPPer|WLOWer|TCALibrate|AWIDth|DWIDth|TIMeout)$/;

/** Header patterns the generic panels must not offer: data transfer and multi-argument commands with special UIs. */
const HIDDEN = [
  /^:WAVeform/i, /^:SYSTem:SETup/i, /^:DISPlay:DATA/i, /^:SAVE:IMAGe:DATA/i, /^:BUS<n>:DATA/i, /^\*(OPC|WAI|ESE|ESR|SRE|STB|TST)$/,
  /^:SYSTem:OPTion:(INSTall|UNINstall)/i, /^:SAVe:SMB:PASSword/i, /^:LAN:/i,
];

const LAN_READABLE = /^:LAN:(MAC|STATus|VISA|DSERver|IPADdress|SMASk|GATeway|DNS|DHCP|AUToip|MANual|MDNS|HOST:NAME|DESCription)$/i;

function fromManual(e: ManualEntry): Control {
  const header = e.header;
  const id = slug(header);
  const nodes = id.split(".");
  const group = nodes[0];
  const sub = nodes.length >= 3 ? nodes[1] : null;
  const sfxName = /<(\w+)>/.exec(header)?.[1] ?? null;
  const sp = sfxName ? e.params.find((p) => p.name === sfxName) : undefined;
  let suffix: Control["suffix"] = null;
  if (sfxName) {
    const vals = sp?.options?.map(Number).filter((x) => Number.isFinite(x)) ?? [];
    if (!vals.length && sp?.min !== undefined && sp?.max !== undefined) for (let i = sp.min; i <= sp.max; i++) vals.push(i);
    suffix = { name: sfxName, values: vals.length ? vals : [1, 2, 3, 4] };
  }
  const params = e.params.filter((p) => p !== sp);
  const last = header.replace(/\[:[A-Za-z]+\]/g, "").split(":").filter(Boolean).pop()!.replace(/<\w+>/, "");
  let kind: Kind;
  let hidden = HIDDEN.some((re) => re.test(header)) && !LAN_READABLE.test(header);
  if (!e.set && e.query) kind = "readonly";
  else if (e.set && !params.length) kind = "action";
  else if (params.length === 1) {
    const t = params[0].type;
    kind = t === "Bool" ? "bool" : t === "Discrete" ? "enum" : t === "Integer" || t === "Real" ? "number" : "string";
    if (t === "Binary") hidden = true;
  } else {
    kind = "string";
    hidden = true;
  }
  if (e.queryArgs) hidden = true;
  if (LAN_READABLE.test(header)) kind = "readonly";
  const p = params[0];
  const c: Control = {
    id,
    header,
    section: e.section,
    group,
    sub,
    label: mnemonicLabel(last),
    kind,
    set: e.set,
    query: e.query,
    suffix,
    hidden,
  };
  if (p && kind === "enum" && p.options?.length) c.options = p.options.map((o) => ({ value: o, label: optionLabel(o) }));
  if (p && kind === "number") {
    if (p.min !== undefined) c.min = p.min;
    if (p.max !== undefined) c.max = p.max;
    c.unit = p.unit || (V_WORDS.test(last) ? "V" : S_WORDS.test(last) ? "s" : undefined);
    if (c.unit === "bps") c.unit = "bps";
    if (p.type === "Integer") c.step = 1;
  }
  if (p?.default !== undefined) c.def = kind === "bool" ? p.default === "ON" : p.default;
  if (group === "trigger" && sub && TRIGGER_SUB[sub]) c.when = { id: "trigger.mode", is: [TRIGGER_SUB[sub]] };
  if (group === "bus" && sub && BUS_SUB[sub]) c.when = { id: "bus.mode", is: [BUS_SUB[sub]] };
  if (group === "math" && sub === "fft") c.when = { id: "math.operator", is: ["FFT"] };
  if (group === "math" && sub === "filter") c.when = { id: "math.operator", is: ["LPASs", "HPASs", "BPASs", "BSTop"] };
  if (sub && NEEDS[sub] && (group === "trigger" || group === "bus")) c.needs = NEEDS[sub];
  if (group === "source") c.needs = "AFG";
  if (group === "bodeplot") c.needs = "AFG";
  return c;
}

const CH_AFTER = ["channel.offset", "channel.scale", "acquire.srate"];

/** What a table cannot know. Keyed by header exactly as the guide writes it. */
const CURATED: Record<string, Partial<Control>> = {
  // ---------------------------------------------------------------- channel
  ":CHANnel<n>:DISPlay": { label: "On", primary: true, watch: true, after: ["acquire.srate", "acquire.mdepth"] },
  ":CHANnel<n>:SCALe": { label: "Scale", unit: "V/div", step: "125", primary: true, watch: true, after: ["channel.offset", "trigger.edge.level"] },
  ":CHANnel<n>:OFFSet": { label: "Offset", unit: "V", primary: true, watch: true },
  ":CHANnel<n>:POSition": { label: "Bias", unit: "V" },
  ":CHANnel<n>:COUPling": { primary: true, watch: true },
  ":CHANnel<n>:BWLimit": { options: [{ value: "OFF", label: "Full" }, { value: "20M", label: "20 MHz" }, { value: "250M", label: "250 MHz" }], primary: true },
  ":CHANnel<n>:IMPedance": { label: "Input", primary: true, after: CH_AFTER, confirm: "50 Ω input: the MHO984 is rated for 5 Vrms at 50 Ω. Make sure the signal on this channel is within that before switching." },
  ":CHANnel<n>:PROBe": {
    label: "Probe",
    primary: true,
    after: CH_AFTER,
    options: ["0.001", "0.002", "0.005", "0.01", "0.02", "0.05", "0.1", "0.2", "0.5", "1", "2", "5", "10", "15", "20", "50", "100", "150", "200", "500", "1000", "1500", "2000", "5000", "10000", "15000", "20000", "50000"].map((v) => ({ value: v, label: `${v}×` })),
  },
  ":CHANnel<n>:INVert": { primary: true },
  ":CHANnel<n>:UNITs": { label: "Units", primary: true },
  ":CHANnel<n>:VERNier": { label: "Fine scale", primary: true },
  ":CHANnel<n>:LABel:SHOW": { label: "Show label", primary: true },
  ":CHANnel<n>:LABel:CONTent": { label: "Label", primary: true },
  ":CHANnel<n>:TCALibrate": { label: "Deskew", unit: "s", step: 1e-10 },
  // --------------------------------------------------------------- timebase
  ":TIMebase[:MAIN]:SCALe": { label: "Scale", unit: "s/div", step: "125", primary: true, watch: true, min: 5e-10, max: 500, after: ["acquire.srate", "acquire.mdepth", "timebase.offset"] },
  ":TIMebase[:MAIN][:OFFSet]": { label: "Position", unit: "s", primary: true, watch: true },
  ":TIMebase:MODE": { label: "Mode", primary: true, watch: true },
  ":TIMebase:DELay:ENABle": { label: "Zoom", primary: true },
  ":TIMebase:DELay:SCALe": { label: "Zoom scale", unit: "s/div", step: "125" },
  ":TIMebase:DELay:OFFSet": { label: "Zoom position", unit: "s" },
  ":TIMebase:HREFerence:MODE": { label: "Expand about" },
  ":TIMebase:HREFerence:POSition": { label: "User reference", unit: "" },
  ":TIMebase:VERNier": { label: "Fine", primary: true },
  ":TIMebase:ROLL": { hidden: false },
  // ---------------------------------------------------------------- acquire
  ":ACQuire:TYPE": { label: "Mode", primary: true, watch: true },
  ":ACQuire:AVERages": {
    label: "Averages",
    kind: "enum",
    options: Array.from({ length: 16 }, (_, i) => String(2 ** (i + 1))).map((v) => ({ value: v, label: v })),
    when: { id: "acquire.type", is: ["AVERages"] },
    primary: true,
  },
  ":ACQuire:MDEPth": {
    label: "Memory depth",
    options: ["AUTO", "1k", "10k", "100k", "1M", "10M", "25M", "50M", "100M", "125M", "250M", "500M"].map((v) => ({ value: v, label: v === "AUTO" ? "Auto" : `${v}pts` })),
    primary: true,
    watch: true,
    after: ["acquire.srate"],
  },
  ":ACQuire:SRATe": { label: "Sample rate", unit: "Sa/s", primary: true, watch: true },
  ":ACQuire:BITS": { label: "High-res bits", when: { id: "acquire.type", is: ["HRESolution"] }, primary: true },
  // ---------------------------------------------------------------- trigger
  ":TRIGger:MODE": { label: "Type", primary: true, watch: true },
  ":TRIGger:SWEep": { label: "Sweep", primary: true, watch: true },
  ":TRIGger:COUPling": { primary: true },
  ":TRIGger:HOLDoff": { unit: "s", primary: true },
  ":TRIGger:NREJect": { primary: true },
  ":TRIGger:STATus": { label: "Status", hidden: true },
  ":TRIGger:POSition": { label: "Trigger position", hidden: true },
  ":TRIGger:EDGE:SOURce": { primary: true, watch: true },
  ":TRIGger:EDGE:SLOPe": { options: [{ value: "POSitive", label: "Rising" }, { value: "NEGative", label: "Falling" }, { value: "RFALl", label: "Either" }], primary: true, watch: true },
  ":TRIGger:EDGE:LEVel": { unit: "V", primary: true, watch: true },
  // ----------------------------------------------------------------- measure
  ":MEASure:ITEM": { hidden: true },
  ":MEASure:STATistic:ITEM": { hidden: true },
  ":MEASure:DELete": { label: "Clear all on instrument" },
  ":MEASure:THReshold:TYPE": { label: "Threshold type" },
  ":MEASure:SETup:MAX": { label: "Upper threshold" },
  ":MEASure:SETup:MID": { label: "Middle threshold" },
  ":MEASure:SETup:MIN": { label: "Lower threshold" },
  // --------------------------------------------------------------- generator
  ":SOURce<n>:OUTPut:STATe": { label: "Output", primary: true, watch: true, confirm: "Turn the generator output on? Whatever is connected to this GEN OUT will be driven." },
  ":SOURce<n>:FUNCtion": { primary: true },
  ":SOURce<n>:FREQuency": { unit: "Hz", primary: true, min: 0.002, max: 1e8, when: { id: "source.function", is: ["SINusoid", "SQUare", "RAMP", "ARB", "EXPRise", "EXPFall", "ECG1", "GAUSsian", "LORentz", "HAVersine", "SINC"] } },
  ":SOURce<n>:PERiod": { unit: "s", hidden: true },
  ":SOURce<n>:PHASe": { unit: "°", primary: true, min: 0, max: 360 },
  ":SOURce<n>:FUNCtion:RAMP:SYMMetry": { label: "Symmetry", unit: "%", when: { id: "source.function", is: ["RAMP"] }, primary: true },
  ":SOURce<n>:FUNCtion:SQUare:DUTY": { label: "Duty cycle", unit: "%", when: { id: "source.function", is: ["SQUare"] }, primary: true },
  ":SOURce<n>:VOLTage:AMPLitude": { label: "Amplitude", unit: "Vpp", primary: true, min: 0.001, max: 20 },
  ":SOURce<n>:VOLTage:OFFSet": { label: "Offset", unit: "V", primary: true },
  ":SOURce<n>:VOLTage:HIGH": { label: "High level", unit: "V" },
  ":SOURce<n>:VOLTage:LOW": { label: "Low level", unit: "V" },
  ":SOURce<n>:IMPedance": { label: "Load", options: [{ value: "OMEG", label: "High Z" }, { value: "FIFTy", label: "50 Ω" }], primary: true },
  ":SOURce<n>:MOD:STATe": { label: "Modulation", primary: true },
  ":SOURce<n>:MOD:TYPe": { label: "Modulation type", when: { id: "source.mod.state", is: ["ON"] } },
  ":SOURce<n>:MOD:AM:DEPTh": { unit: "%", when: { id: "source.mod.type", is: ["AM"] } },
  ":SOURce<n>:MOD:AM:INTernal:FREQuency": { label: "AM rate", unit: "Hz", when: { id: "source.mod.type", is: ["AM"] } },
  ":SOURce<n>:MOD:AM:INTernal:FUNCtion": { label: "AM shape", when: { id: "source.mod.type", is: ["AM"] } },
  ":SOURce<n>:MOD:FM:DEViation": { unit: "Hz", when: { id: "source.mod.type", is: ["FM"] } },
  ":SOURce<n>:MOD:FM:INTernal:FREQuency": { label: "FM rate", unit: "Hz", when: { id: "source.mod.type", is: ["FM"] } },
  ":SOURce<n>:MOD:FM:INTernal:FUNCtion": { label: "FM shape", when: { id: "source.mod.type", is: ["FM"] } },
  ":SOURce<n>:MOD:PM:DEViation": { unit: "°", when: { id: "source.mod.type", is: ["PM"] } },
  ":SOURce<n>:MOD:PM:INTernal:FREQuency": { label: "PM rate", unit: "Hz", when: { id: "source.mod.type", is: ["PM"] } },
  ":SOURce<n>:MOD:PM:INTernal:FUNCtion": { label: "PM shape", when: { id: "source.mod.type", is: ["PM"] } },
  // ---------------------------------------------------------- counter / dvm
  ":COUNter:ENABle": { primary: true },
  ":COUNter:SOURce": { primary: true },
  ":COUNter:MODE": { primary: true },
  ":COUNter:CURRent": { label: "Reading", hidden: true },
  ":DVM:ENABle": { primary: true },
  ":DVM:SOURce": { primary: true },
  ":DVM:MODE": { primary: true },
  ":DVM:CURRent": { label: "Reading", hidden: true },
  // -------------------------------------------------------------------- math
  ":MATH<n>:DISPlay": { label: "On", primary: true, watch: true },
  ":MATH<n>:OPERator": { primary: true },
  ":MATH<n>:SOURce1": { label: "Source A", primary: true },
  ":MATH<n>:SOURce2": { label: "Source B", primary: true, when: { id: "math.operator", is: ["ADD", "SUBTract", "MULTiply", "DIVision"] } },
  ":MATH<n>:LSOurce1": { label: "Logic A", when: { id: "math.operator", is: ["AND", "OR", "XOR", "NOT"] } },
  ":MATH<n>:LSOurce2": { label: "Logic B", when: { id: "math.operator", is: ["AND", "OR", "XOR"] } },
  ":MATH<n>:SCALe": { unit: "", step: "125" },
  ":MATH<n>:OFFSet": { unit: "" },
  ":MATH<n>:FFT:HSCale": { unit: "Hz" },
  ":MATH<n>:FFT:HCENter": { unit: "Hz" },
  ":MATH<n>:FFT:FREQuency:STARt": { label: "Start", unit: "Hz" },
  ":MATH<n>:FFT:FREQuency:END": { label: "Stop", unit: "Hz" },
  ":MATH<n>:FILTer:W1": { unit: "Hz" },
  ":MATH<n>:FILTer:W2": { unit: "Hz" },
  // ----------------------------------------------------------------- system
  "*IDN": { label: "Identity", kind: "readonly" },
  "*RST": { label: "Factory reset", confirm: "Reset the oscilloscope to its factory setup? Every setting on the instrument is lost (save a preset first)." },
  "*CLS": { label: "Clear status" },
  ":SYSTem:RESet": { label: "Restart instrument", confirm: "Restart the oscilloscope? The connection drops until it has booted again." },
  ":SYSTem:ERRor[:NEXT]": { label: "Next error", hidden: true },
  ":SYSTem:LOCKed": { label: "Lock front panel" },
  ":SYSTem:LANGuage": { label: "Language" },
  ":SYSTem:AUToscale": { label: "Autoscale key enabled" },
  ":SYSTem:LOWPower": { hidden: true },
  ":SYSTem:DATE": { hidden: true },
  ":SYSTem:TIME": { hidden: true },
  ":SYSTem:OPTion:STATus": { hidden: true },
  ":SYSTem:OPTion:VALid": { hidden: true },
  // ------------------------------------------------------------ run control
  ":RUN": { label: "Run" },
  ":STOP": { label: "Stop" },
  ":SINGle": { label: "Single" },
  ":TFORce": { label: "Force trigger" },
  ":CLEar": { label: "Clear display" },
  ":AUToset": { label: "Autoset", confirm: "Autoset rescales every channel, the timebase and the trigger. Continue?" },
  // ------------------------------------------------------------------ logic
  ":LA:ENABle": { label: "Logic analyser", primary: true },
  ":LA:DIGital:ENABle": { hidden: true },
  ":LA:DIGital:LABel": { hidden: true },
  ":LA:POD<n>:THReshold": { label: "Threshold", unit: "V" },
  // ------------------------------------------------------------------- bus
  ":BUS<n>:MODE": { label: "Protocol", primary: true },
  ":BUS<n>:DISPlay": { label: "On", primary: true },
  ":BUS<n>:EVENt": { label: "Event table" },
  ":BUS<n>:RS232:BAUD": { unit: "bps", step: 1 },
  ":BUS<n>:EEXPort": { label: "Export table to instrument path" },
  ":DISPlay:GRADing:TIME": { label: "Persistence" },
  ":DISPlay:WBRightness": { label: "Wave brightness", unit: "%" },
  ":DISPlay:GBRightness": { label: "Grid brightness", unit: "%" },
  ":DISPlay:CBRightness": { label: "Scale brightness", unit: "%" },
  ":DISPlay:COLor": { label: "Colour grade" },
  ":DISPlay:WHOLd": { label: "Freeze display" },
};

function build(): Control[] {
  const list: Control[] = [];
  const seen = new Set<string>();
  for (const e of (manual as { commands: ManualEntry[] }).commands) {
    const c = fromManual(e);
    const o = CURATED[e.header];
    if (o) {
      Object.assign(c, o);
      if (o.options === undefined && c.options && c.kind !== "enum") delete c.options;
    }
    // A handful of headers appear twice in the guide (e.g. :SAVE and :SAVe spellings); keep the first.
    if (seen.has(c.id)) continue;
    seen.add(c.id);
    list.push(c);
  }
  return list;
}

export const CONTROLS: Control[] = build();
export const BY_ID: Map<string, Control> = new Map(CONTROLS.map((c) => [c.id, c]));

/** A control bound to a suffix: "channel.scale@2". Unsuffixed controls use their id. */
export function key(id: string, n?: number | null): string {
  return n === undefined || n === null ? id : `${id}@${n}`;
}
export function parseKey(k: string): { id: string; n: number | null } {
  const i = k.indexOf("@");
  return i < 0 ? { id: k, n: null } : { id: k.slice(0, i), n: Number(k.slice(i + 1)) };
}

/** Every key (id × suffix) of a control. */
export function keysOf(c: Control): string[] {
  return c.suffix ? c.suffix.values.map((n) => key(c.id, n)) : [c.id];
}

/** Is this control relevant given the current values (its `when` rule, bound to the same suffix)? */
export function relevant(c: Control, n: number | null, get: (k: string) => unknown): boolean {
  if (!c.when) return true;
  const dep = BY_ID.get(c.when.id);
  const k = dep?.suffix ? key(c.when.id, n ?? 1) : c.when.id;
  const v = get(k);
  if (v === undefined || v === null) return true;
  const s = typeof v === "boolean" ? (v ? "ON" : "OFF") : String(v);
  return c.when.is.some((x) => x.toUpperCase() === s.toUpperCase() || shortForm(x) === shortForm(s));
}

export function groups(): { group: string; subs: (string | null)[] }[] {
  const m = new Map<string, Set<string | null>>();
  for (const c of CONTROLS) {
    if (c.hidden) continue;
    if (!m.has(c.group)) m.set(c.group, new Set());
    m.get(c.group)!.add(c.sub);
  }
  return [...m].map(([group, subs]) => ({ group, subs: [...subs] }));
}
