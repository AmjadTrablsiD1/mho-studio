// The MHO984's automatic measurements (guide §3.17.2), with labels, units and
// whether they need two sources. The table and the "Add measurement" picker
// are generated from this list.

export type Measurement = {
  item: string;
  label: string;
  unit: string;
  category: "vertical" | "horizontal" | "other";
  dual?: boolean;
  /** Measured in percent of amplitude or period. */
  percent?: boolean;
  /** The app's own computation of the same quantity (a key of measureAll), when `item` is not one. */
  cross?: string;
};

export const MEASUREMENTS: Measurement[] = [
  { item: "VMAX", label: "Maximum", unit: "V", category: "vertical" },
  { item: "VMIN", label: "Minimum", unit: "V", category: "vertical" },
  { item: "VPP", label: "Peak-peak", unit: "V", category: "vertical" },
  { item: "VTOP", label: "Top", unit: "V", category: "vertical" },
  { item: "VBASe", label: "Base", unit: "V", category: "vertical" },
  { item: "VAMP", label: "Amplitude", unit: "V", category: "vertical" },
  { item: "VAVG", label: "Mean", unit: "V", category: "vertical" },
  { item: "VRMS", label: "RMS", unit: "V", category: "vertical" },
  { item: "PVRMs", label: "Period RMS", unit: "V", category: "vertical" },
  { item: "ACRMs", label: "AC RMS", unit: "V", category: "vertical" },
  { item: "VUPPer", label: "Upper level", unit: "V", category: "vertical" },
  { item: "VMID", label: "Middle level", unit: "V", category: "vertical" },
  { item: "VLOWer", label: "Lower level", unit: "V", category: "vertical" },
  { item: "OVERshoot", label: "Overshoot", unit: "%", category: "vertical", percent: true },
  { item: "PREShoot", label: "Preshoot", unit: "%", category: "vertical", percent: true },
  { item: "MARea", label: "Area", unit: "Vs", category: "vertical" },
  { item: "MPARea", label: "Period area", unit: "Vs", category: "vertical" },
  { item: "PERiod", label: "Period", unit: "s", category: "horizontal" },
  { item: "FREQuency", label: "Frequency", unit: "Hz", category: "horizontal" },
  { item: "RTIMe", label: "Rise time", unit: "s", category: "horizontal" },
  { item: "FTIMe", label: "Fall time", unit: "s", category: "horizontal" },
  { item: "PWIDth", label: "+Width", unit: "s", category: "horizontal" },
  { item: "NWIDth", label: "−Width", unit: "s", category: "horizontal" },
  { item: "PDUTy", label: "+Duty", unit: "%", category: "horizontal", percent: true },
  { item: "NDUTy", label: "−Duty", unit: "%", category: "horizontal", percent: true },
  { item: "TVMAX", label: "Time of max", unit: "s", category: "horizontal" },
  { item: "TVMIN", label: "Time of min", unit: "s", category: "horizontal" },
  { item: "PSLewrate", label: "+Slew rate", unit: "V/s", category: "horizontal" },
  { item: "NSLewrate", label: "−Slew rate", unit: "V/s", category: "horizontal" },
  { item: "PPULses", label: "+Pulses", unit: "", category: "other" },
  { item: "NPULses", label: "−Pulses", unit: "", category: "other" },
  { item: "PEDGes", label: "Rising edges", unit: "", category: "other" },
  { item: "NEDGes", label: "Falling edges", unit: "", category: "other" },
  { item: "RRDelay", label: "Delay ↑↑", unit: "s", category: "other", dual: true },
  { item: "RFDelay", label: "Delay ↑↓", unit: "s", category: "other", dual: true },
  { item: "FRDelay", label: "Delay ↓↑", unit: "s", category: "other", dual: true },
  { item: "FFDelay", label: "Delay ↓↓", unit: "s", category: "other", dual: true },
  { item: "RRPHase", label: "Phase ↑↑", unit: "°", category: "other", dual: true },
  { item: "RFPHase", label: "Phase ↑↓", unit: "°", category: "other", dual: true },
  { item: "FRPHase", label: "Phase ↓↑", unit: "°", category: "other", dual: true },
  { item: "FFPHase", label: "Phase ↓↓", unit: "°", category: "other", dual: true },
];

export const MEASUREMENT_BY_ITEM = new Map(MEASUREMENTS.map((m) => [m.item, m]));

/** Sources a measurement can use. D0–D15 only when the logic probe is fitted. */
export const ANALOG_SOURCES = ["CHANnel1", "CHANnel2", "CHANnel3", "CHANnel4"];
export const MATH_SOURCES = ["MATH1", "MATH2", "MATH3", "MATH4"];
export const DIGITAL_SOURCES = Array.from({ length: 16 }, (_, i) => `D${i}`);

/** A measurement slot the user added. */
export type Slot = { id: string; item: string; src1: string; src2?: string };
