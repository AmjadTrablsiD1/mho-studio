// Human names for SCPI mnemonics and option values. Labels are ours, not the
// guide's text; anything not listed falls back to the long form, capitalised.

export const MNEMONIC: Record<string, string> = {
  ACTive: "Active channel", ADDBits: "Address bits", ADDRess: "Address", ALEVel: "Level A", ALIGnment: "Alignment",
  AM: "AM", AMP: "Amplitude", AMPLitude: "Amplitude", AMSource: "All-measure source", AOUTput: "Aux output",
  APPLy: "Apply", ARBitrary: "Arbitrary file", AREA: "Region", ASLop: "Edge A", AUDio: "Audio", AUToconnect: "Auto connect",
  AUToip: "Auto IP", AUToscale: "Autoscale", AUTosort: "Order", AVCNt: "Average count", AVERages: "Averages", AWIDth: "Address width",
  AX: "Cursor A X", AXValue: "A X value", AY: "Cursor A Y", AYValue: "A Y value", BASE: "Base", BAUD: "Baud rate", BEEPer: "Beeper",
  BITS: "High-res bits", BITX: "Bit", BLEVel: "Level B", BOTTom: "Bottom", BSLop: "Edge B", BUS: "Bus", BUSer: "User baud",
  BWLimit: "Bandwidth limit", BX: "Cursor B X", BXValue: "B X value", BY: "Cursor B Y", BYValue: "B Y value", CABX: "Region A–B",
  CATegory: "Category", CAX: "Cursor A X", CAY: "Cursor A Y", CBRightness: "Scale brightness", CBX: "Cursor B X", CBY: "Cursor B Y",
  CH: "Channel", CHANnel: "Channel", CHECk: "Check", CLEVel: "Clock level", CLEar: "Clear", CLK: "Clock", CLOCk: "Clock", CODE: "Code",
  COLor: "Colour", CONNect: "Connect", CONState: "Connection", CONTent: "Text", COUNt: "Count", COUNter: "Counter", COUPling: "Coupling",
  CREate: "Create", CS: "Chip select", CSRC: "Clock source", CSV: "Save CSV", CURRbit: "Current bit", CURRent: "Current",
  CYCComp: "Cycle compare", DATA: "Data", DATComp: "Data compare", DATE: "Date", DATValue: "Data value", DBIT: "Data bit",
  DBITs: "Data bits", DBYTes: "Data bytes", DEFault: "Default", DEFine: "Define", DELay: "Delay", DELete: "Delete all", DEPTh: "Depth",
  DESCription: "Description", DEViation: "Deviation", DGSTatus: "Generator status", DHCP: "DHCP", DIGital: "Digital", DIRection: "Direction",
  DISMode: "Display mode", DISPlay: "Display", DISTance: "Distance", DLEVel: "Data level", DMAX: "Data max", DMIN: "Data min",
  DNS: "DNS", DRTA: "RTA", DSA: "Delay source A", DSB: "Delay source B", DSERver: "DHCP server", DSRC: "Data source", DUTY: "Duty cycle",
  DWIDth: "Data width", EDGE: "Edge", ENABle: "Enable", ENAble: "Enable", END: "End", ENDian: "Bit order", ERRor: "Error", EVENt: "Event table",
  EXCHange: "Swap SCL/SDA", EXCursion: "Excursion", EXPand: "Expand about", EXTended: "Extended ID", FAILed: "Failed", FCURrent: "Current frame",
  FDBaud: "FD baud", FDSPoint: "FD sample point", FEND: "End frame", FINTerval: "Frame interval", FMAX: "Max frames", FORMat: "Format",
  FRAMe: "Frame", FRAMes: "Frames", FREQuency: "Frequency", FSTart: "Start frame", FUNCtion: "Waveform", GAINcurve: "Gain curve",
  GAMount: "Grid count", GATeway: "Gateway", GBRightness: "Grid brightness", GRADing: "Persistence", GRID: "Grid", HCENter: "Centre",
  HEADer: "Header", HEIGht: "Height", HIGH: "High level", HOLDoff: "Holdoff", HOST: "Host", HOTKeys: "Hot key", HREFerence: "Reference",
  HSCale: "Span", HTIMe: "Hold time", ID: "ID", IDCmp: "ID compare", IDLE: "Idle time", IMAGe: "Image", IMPedance: "Impedance",
  IN: "Input", INDicator: "Indicator", INSTall: "Install licence", INTernal: "Internal", INVert: "Invert", IPADdress: "IP address",
  ITEM: "Item", IXDelta: "1/ΔX", KEEPcoup: "Keep coupling", LABel: "Label", LANGuage: "Language", LEFT: "Left", LEVel: "Level",
  LINE: "Line", LOAD: "Load", LOCK: "Lock", LOCKed: "Keyboard lock", LOW: "Low level", LOWPower: "Low power", LSOurce1: "Logic source 1",
  LSOurce2: "Logic source 2", LWIDth: "Lower width", MAC: "MAC", MANual: "Manual", MAX: "Upper", MAXCy: "Max cycle", MAXid: "Max ID",
  MDEPth: "Memory depth", MDNS: "mDNS", MID: "Middle", MIN: "Lower", MINCy: "Min cycle", MINid: "Min ID", MISO: "MISO", MOD: "Modulation",
  MODE: "Mode", MODules: "Modules", MOSI: "MOSI", MOVE: "Move", NAME: "Name", NDIGits: "Digits", NEXT: "Next", NREJect: "Noise reject",
  NUM: "Count", OFFSet: "Offset", OPENch: "Only open channels", OPERate: "Run", OPERation: "Operation", OPERator: "Operator", ORDer: "Order",
  OUT: "Output", OUTPut: "Output", OVERlap: "Overwrite", PARity: "Parity", PASSed: "Passed", PASSword: "Password", PATHname: "Path",
  PATTern: "Pattern", PEAK: "Peak", PERiod: "Period", PHASEcurve: "Phase curve", PHASe: "Phase", PLAY: "Play", PM: "PM", POD: "Pod",
  POINts: "Points", POLarity: "Polarity", PON: "Power-on setup", POS: "Position", POSition: "Position", PREFix: "Prefix",
  PROBe: "Probe", PROMpt: "Prompt", PSA: "Source A", PSB: "Source B", PSTatus: "Power status", QUALifier: "Qualifier", RANGe: "Range",
  RECewidth: "Receive width", REF: "Reference", RES: "Results", RESet: "Reset", RESult: "Result", RIGHt: "Right", ROLL: "Roll",
  RULers: "Rulers", RUNStop: "Run", RWIDth: "Word width", RX: "RX", SA: "Source A", SAMPlepoint: "Sample point", SB: "Source B",
  SBITs: "Stop bits", SCALe: "Scale", SCL: "SCL", SCLK: "SCLK", SDA: "SDA", SENSitivity: "Sensitivity", SERVerpath: "Server path",
  SETup: "Setup", SHOW: "Show", SIZE: "Size", SLEVel: "CS level", SLOPe: "Slope", SMASk: "Subnet mask", SOURce: "Source",
  SOURce1: "Source 1", SOURce2: "Source 2", SPEed: "Speed", SPOint: "Sample point", SRATe: "Sample rate", SS: "Chip select",
  STANdard: "Standard", STARt: "Start", STATe: "State", STATus: "Status", STIMe: "Setup time", STOP: "Stop", STYPe: "Signal type",
  SWEep: "Sweep", SWEeptype: "Sweep type", SYMBol: "Symbol", SYMMetry: "Symmetry", SYNC: "Sync", SYNChronize: "Align phase",
  TCALibrate: "Deskew", THReshold: "Threshold", THReshold1: "Threshold 1", THReshold2: "Threshold 2", THReshold3: "Threshold 3",
  THReshold4: "Threshold 4", TIME: "Time", TITLe: "Title", TLOWer: "Lower time", TOP: "Top", TOTal: "Total", TOTalize: "Totalize",
  TUNit: "Time unit", TUPPer: "Upper time", TX: "TX", TYPE: "Type", TYPe: "Type", UNINstall: "Uninstall", UNIT: "Unit", UNITs: "Units",
  USERname: "User name", UWIDth: "Upper width", VALid: "Valid", VALue: "Value", VERNier: "Fine", VERSion: "Version", VISA: "VISA address",
  VOFFset: "Offset", VOLTage: "Amplitude", VSCale: "Scale", VUNit: "Voltage unit", W1: "Frequency 1", W2: "Frequency 2",
  WAVetype: "Window", WBRightness: "Wave brightness", WHEN: "When", WHOLd: "Hold", WIDTh: "Width", WINDow: "Window", WINDows: "Window",
  WLOWer: "Lower width", WSELect: "Word select", WSLow: "WS low", WUPPer: "Upper width", X: "X source", XDELta: "ΔX", XY: "XY",
  Y: "Y source", YDELta: "ΔY", DEPTH: "Depth",
};

export const GROUP_LABEL: Record<string, string> = {
  channel: "Channel", timebase: "Horizontal", acquire: "Acquire", trigger: "Trigger", measure: "Measure", math: "Math",
  source: "Generator", counter: "Counter", dvm: "Voltmeter", display: "Display", la: "Logic", bus: "Decode", system: "System",
  cursor: "Cursor", histogram: "Histogram", mask: "Pass/fail", record: "Record", reference: "Reference", save: "Save", load: "Load",
  search: "Search", navigate: "Navigate", lan: "LAN", bodeplot: "Bode (built-in)", autoset: "Autoset", quick: "Quick action",
  root: "Run control", common: "IEEE 488.2", waveform: "Waveform", "save.smb": "Network share",
};

export const OPTION: Record<string, string> = {
  POSitive: "Positive", NEGative: "Negative", RFALl: "Either", RFALI: "Either", NORMal: "Normal", AUTO: "Auto", SINGle: "Single",
  HRESolution: "High res", AVERages: "Average", PEAK: "Peak detect", OMEG: "1 MΩ", FIFTy: "50 Ω", AC: "AC", DC: "DC", GND: "GND",
  LFReject: "LF reject", HFReject: "HF reject", VOLTage: "Volts", AMPere: "Amps", WATT: "Watts", UNKNown: "Unknown",
  MAIN: "YT", XY: "XY", ROLL: "Roll", CENTer: "Centre", LB: "Left", RB: "Right", TRIG: "Trigger", USER: "User",
  SINusoid: "Sine", SQUare: "Square", RAMP: "Ramp", NOISe: "Noise", ARB: "Arbitrary", EXPRise: "Exp rise", EXPFall: "Exp fall",
  ECG1: "ECG", GAUSsian: "Gaussian", LORentz: "Lorentz", HAVersine: "Haversine", SINC: "Sinc",
  GREater: "Greater than", LESS: "Less than", GLESs: "Inside range", EDGE: "Edge", PULSe: "Pulse", SLOPe: "Slope", VIDeo: "Video",
  PATTern: "Pattern", DURation: "Duration", TIMeout: "Timeout", RUNT: "Runt", WINDow: "Window", DELay: "Delay", SETup: "Setup/hold",
  NEDGe: "Nth edge", RS232: "UART", IIC: "I²C", SPI: "SPI", CAN: "CAN", LIN: "LIN", IIS: "I²S", FLEXray: "FlexRay", M1553: "MIL-1553",
  PARallel: "Parallel", HEX: "Hex", ASCii: "ASCII", DEC: "Decimal", BIN: "Binary", ADD: "A + B", SUBTract: "A − B", MULTiply: "A × B",
  DIVision: "A ÷ B", AND: "AND", OR: "OR", XOR: "XOR", NOT: "NOT", FFT: "FFT", INTG: "∫ dt", DIFF: "d/dt", SQRT: "√", LG: "log₁₀",
  LN: "ln", EXP: "exp", ABS: "|A|", LPASs: "Low-pass", HPASs: "High-pass", BPASs: "Band-pass", BSTop: "Band-stop", AXB: "aX + b",
  RECTangle: "Rectangular", BLACkman: "Blackman", HANNing: "Hann", HAMMing: "Hamming", FLATtop: "Flat top", TRIangle: "Triangle",
  VRMS: "Vrms", DB: "dB", AVERage: "Average", MAXHold: "Max hold", FULL: "Full", HALF: "Half", NONE: "None", ON: "On", OFF: "Off",
  PERCent: "Percent", ABSolute: "Absolute", MINimum: "Minimum", MAXimum: "Maximum", CURRent: "Current", DEViation: "Std dev", CNT: "Count",
  LOG: "Log", LINE: "Linear", LATest: "Last", DEFault: "Default", OPEN: "Open", SMALl: "Small", MEDium: "Medium", LARGe: "Large",
  ENGLish: "English", GERMan: "German", FRENch: "French", SPAN: "Spanish", RUSSian: "Russian", SCHinese: "简体中文", TCHinese: "繁體中文",
  JAPanese: "日本語", KORean: "한국어", PORTuguese: "Portuguese", POLish: "Polish", THAI: "Thai", INDonesian: "Indonesian",
  TOUT: "Trigger out", PFAil: "Pass/fail", FREQuency: "Frequency", PERiod: "Period", TOTalize: "Totalize", ACRMs: "AC RMS", DCRMs: "DC RMS",
  INFinite: "Infinite", MIN: "Minimum", VECTors: "Vectors", BYTE: "Byte", WORD: "Word", RAW: "Raw", MAXimumW: "Max",
  COLor: "Colour", GRAY: "Grey", PNG: "PNG", BMP: "BMP", JPG: "JPEG", ODD: "Odd", EVEN: "Even", LSB: "LSB first", MSB: "MSB first",
  CS: "Chip select", RUN: "Run", STOP: "Stop", D0D15: "D0 → D15", D15D0: "D15 → D0", ZOOM: "Zoom",
};

/** "UWIDth" → "Upper width"; unknown ones → "Uwidth". */
export function mnemonicLabel(m: string): string {
  const bare = m.replace(/<\w+>/, "");
  if (MNEMONIC[bare]) return MNEMONIC[bare];
  const s = bare.toLowerCase();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function optionLabel(o: string): string {
  if (OPTION[o]) return OPTION[o];
  const ch = /^CHANnel(\d+)$/.exec(o);
  if (ch) return `CH${ch[1]}`;
  const m = /^MATH(\d+)$/.exec(o);
  if (m) return `Math ${m[1]}`;
  const r = /^REF(\d+)$/.exec(o);
  if (r) return `Ref ${r[1]}`;
  if (/^[0-9]/.test(o) || /^D\d+$/.test(o)) return o;
  const s = o.toLowerCase();
  return s.charAt(0).toUpperCase() + s.slice(1);
}
