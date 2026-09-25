// The right column: the front panel, one section at a time. Every field is a
// registry control, so what is here is exactly what the instrument accepts.

import { useEffect, useState } from "react";
import { C } from "../../../core/src/constants.ts";
import { key } from "../../../core/src/registry/controls.ts";
import { fmt } from "../../../core/src/format.ts";
import { MEASUREMENTS, ANALOG_SOURCES, MATH_SOURCES } from "../../../core/src/registry/measurements.ts";
import { action, attempt, post, readGroup, useLive } from "../api.ts";
import { setUi, useUi, type Section } from "../uistate.ts";
import { Ctl, GroupPanel } from "./Controls.tsx";
import { sourceLabel } from "../theme.ts";

const SECTIONS: { id: Section; label: string }[] = [
  { id: "vertical", label: "Vertical" },
  { id: "horizontal", label: "Horizontal" },
  { id: "trigger", label: "Trigger" },
  { id: "acquire", label: "Acquire" },
  { id: "measure", label: "Measure" },
  { id: "math", label: "Math" },
  { id: "generator", label: "Generator" },
  { id: "counter", label: "Counter" },
];

/** :TRIGger:MODE option → the registry sub-group that holds its fields. */
export const TRIGGER_SUB: Record<string, string> = {
  EDGE: "edge", PULSe: "pulse", SLOPe: "slope", VIDeo: "video", PATTern: "pattern", DURation: "duration", TIMeout: "timeout",
  RUNT: "runt", WINDow: "windows", DELay: "delay", SETup: "shold", NEDGe: "nedge", RS232: "rs232", IIC: "iic", SPI: "spi",
  CAN: "can", LIN: "lin", IIS: "iis", FLEXray: "flexray", M1553: "m1553",
};

export function Inspector() {
  const section = useUi((u) => u.section);
  return (
    <aside className="inspector" aria-label="Inspector">
      <div className="inspector-chips" role="tablist">
        {SECTIONS.map((s) => (
          <button key={s.id} role="tab" aria-selected={section === s.id} className={`chip${section === s.id ? " active" : ""}`} onClick={() => setUi({ section: s.id })} data-test={`sec-${s.id}`}>
            {s.label}
          </button>
        ))}
      </div>
      <div className="inspector-scroll">
        {section === "vertical" && <Vertical />}
        {section === "horizontal" && <Horizontal />}
        {section === "trigger" && <Trigger />}
        {section === "acquire" && <Acquire />}
        {section === "measure" && <Measure />}
        {section === "math" && <MathSection />}
        {section === "generator" && <Generator />}
        {section === "counter" && <Counter />}
      </div>
    </aside>
  );
}

/** Read a group back from the instrument when its section opens (values that are not polled). */
function useRead(group: string, n?: number, sub?: string | null) {
  const connected = useLive((s) => s.link?.state === "connected");
  useEffect(() => {
    if (connected) void readGroup(group, sub, n).catch(() => {});
  }, [connected, group, n, sub]);
}

function Picker({ count, value, onChange, prefix, color }: { count: number; value: number; onChange: (n: number) => void; prefix: string; color: (n: number) => string }) {
  return (
    <div className="ctl-seg" role="radiogroup" aria-label={`${prefix} select`} style={{ marginBottom: 10 }}>
      {Array.from({ length: count }, (_, i) => i + 1).map((n) => (
        <button key={n} role="radio" aria-checked={value === n} className={value === n ? "active" : ""} onClick={() => onChange(n)} style={{ color: value === n ? color(n) : undefined }}>
          {prefix}{n}
        </button>
      ))}
    </div>
  );
}

function Vertical() {
  const n = useUi((u) => u.channel);
  useRead("channel", n);
  const scale = useLive((s) => s.values[key("channel.scale", n)]);
  const on = useLive((s) => s.values[key("channel.display", n)] === true);
  return (
    <>
      <Picker count={4} value={n} onChange={(c) => setUi({ channel: c })} prefix="CH" color={(c) => `var(--ch${c})`} />
      <div className="title-row">
        <h2><span className="swatch" style={{ background: `var(--ch${n})` }} /> Channel {n}</h2>
        <span className={`badge ${on ? "ok" : "neutral"}`}>{on ? "on" : "off"}</span>
      </div>
      <div className="hero" style={{ marginBottom: 10 }} data-test="ch-scale-hero">
        {typeof scale === "number" ? fmt(scale, "V", 3).split(" ")[0] : "—"}
        <small>{typeof scale === "number" ? `${fmt(scale, "V", 3).split(" ")[1]}/div` : ""}</small>
      </div>
      <div className="section">
        <Ctl id="channel.display" n={n} />
        <Ctl id="channel.scale" n={n} />
        <Ctl id="channel.offset" n={n} />
        <Ctl id="channel.coupling" n={n} />
        <Ctl id="channel.bwlimit" n={n} />
        <Ctl id="channel.impedance" n={n} />
        <Ctl id="channel.probe" n={n} />
      </div>
      <div className="section">
        <div className="section-title">More</div>
        <Ctl id="channel.invert" n={n} />
        <Ctl id="channel.vernier" n={n} />
        <Ctl id="channel.units" n={n} />
        <Ctl id="channel.position" n={n} />
        <Ctl id="channel.tcalibrate" n={n} />
        <Ctl id="channel.label.show" n={n} />
        <Ctl id="channel.label.content" n={n} />
      </div>
      <p className="body-text">Wheel over the screen with <span className="key">Shift</span> steps this channel's V/div; drag its marker on the left edge to move the offset. Hold <span className="key">Shift</span> on the ‹ › buttons for fine steps.</p>
    </>
  );
}

function Horizontal() {
  useRead("timebase");
  const srate = useLive((s) => s.values["acquire.srate"]);
  const mdepth = useLive((s) => s.values["acquire.mdepth"]);
  const tb = useLive((s) => s.values["timebase.scale"]);
  const mode = useLive((s) => String(s.values["timebase.mode"] ?? ""));
  return (
    <>
      <div className="title-row"><h2>Horizontal</h2></div>
      <div className="hero" style={{ marginBottom: 10 }}>
        {typeof tb === "number" ? fmt(tb, "s", 3).split(" ")[0] : "—"}
        <small>{typeof tb === "number" ? `${fmt(tb, "s", 3).split(" ")[1]}/div` : ""}</small>
      </div>
      <div className="section">
        <Ctl id="timebase.scale" />
        <Ctl id="timebase.offset" />
        <Ctl id="timebase.mode" />
        <Ctl id="timebase.vernier" />
        <Ctl id="timebase.hreference.mode" />
        <Ctl id="timebase.hreference.position" />
      </div>
      <div className="section">
        <div className="section-title">Zoom (delayed timebase)</div>
        <Ctl id="timebase.delay.enable" />
        <Ctl id="timebase.delay.scale" />
        <Ctl id="timebase.delay.offset" />
      </div>
      {mode.toUpperCase().startsWith("XY") && <GroupPanel group="timebase" sub="xy" title="XY mode" />}
      <div className="section">
        <div className="metric-row"><span>Sample rate</span><strong>{fmt(srate as number, "Sa/s", 3)}</strong></div>
        <div className="metric-row"><span>Memory depth</span><strong>{String(mdepth ?? "—")}</strong></div>
        <div className="metric-row"><span>Record length</span><strong>{typeof srate === "number" && typeof tb === "number" ? fmt(srate * tb * C.instrument.divisions_x, "pts", 3) : "—"}</strong></div>
      </div>
      <p className="body-text">Wheel over the screen steps the timebase; drag the T marker at the top to move the trigger point.</p>
    </>
  );
}

function Trigger() {
  useRead("trigger", undefined, null);
  const mode = useLive((s) => String(s.values["trigger.mode"] ?? "EDGE"));
  const status = useLive((s) => s.status);
  const sub = TRIGGER_SUB[mode];
  return (
    <>
      <div className="title-row">
        <h2>Trigger</h2>
        <span className={`badge ${status === "TD" ? "ok" : status === "WAIT" ? "warn" : status === "STOP" ? "alarm" : "neutral"}`}>{(C.instrument.trigger_status as Record<string, string>)[status] ?? status}</span>
      </div>
      <div className="section">
        <Ctl id="trigger.mode" />
        <Ctl id="trigger.sweep" />
        <Ctl id="trigger.coupling" />
        <Ctl id="trigger.holdoff" />
        <Ctl id="trigger.nreject" />
        <div className="row" style={{ marginTop: 6 }}>
          <button className="btn small" onClick={() => void attempt(() => action("root.tforce"), "Trigger forced")}>Force trigger</button>
          <button className="btn small" onClick={() => void attempt(() => action("root.single"))}>Single</button>
        </div>
      </div>
      {sub && <GroupPanel key={sub} group="trigger" sub={sub} />}
      <p className="body-text">Drag the T marker on the right edge to set the edge level. Other trigger types show only the fields that apply to them, as the guide lists them.</p>
    </>
  );
}

function Acquire() {
  useRead("acquire");
  return (
    <>
      <div className="title-row"><h2>Acquire</h2></div>
      <div className="section">
        <Ctl id="acquire.type" />
        <Ctl id="acquire.averages" />
        <Ctl id="acquire.bits" />
        <Ctl id="acquire.mdepth" />
        <Ctl id="acquire.srate" />
      </div>
      <GroupPanel group="display" title="Display" />
      <p className="body-text">Memory depth and sample rate trade against each other and against the number of channels on: 4 GSa/s with one channel, 2 GSa/s with two, 1 GSa/s with three or four (datasheet).</p>
    </>
  );
}

function Measure() {
  useRead("measure", undefined, null);
  const rows = useLive((s) => s.measure);
  const [item, setItem] = useState("VPP");
  const [src1, setSrc1] = useState("CHANnel1");
  const [src2, setSrc2] = useState("CHANnel2");
  const m = MEASUREMENTS.find((x) => x.item === item)!;
  const sources = [...ANALOG_SOURCES, ...MATH_SOURCES];
  return (
    <>
      <div className="title-row"><h2>Measure</h2><span className="badge neutral">{rows.length}/{C.measure.max_items}</span></div>
      <div className="section">
        <div className="field" style={{ marginBottom: 8 }}>
          <label htmlFor="m-item">Measurement</label>
          <select id="m-item" className="input" value={item} onChange={(e) => setItem(e.target.value)} data-test="measure-item">
            {(["vertical", "horizontal", "other"] as const).map((cat) => (
              <optgroup key={cat} label={cat === "other" ? "Counts, delay, phase" : cat[0].toUpperCase() + cat.slice(1)}>
                {MEASUREMENTS.filter((x) => x.category === cat).map((x) => <option key={x.item} value={x.item}>{x.label}</option>)}
              </optgroup>
            ))}
          </select>
        </div>
        <div className="row" style={{ marginBottom: 8 }}>
          <div className="field grow">
            <label htmlFor="m-src1">{m.dual ? "From" : "Source"}</label>
            <select id="m-src1" className="input" value={src1} onChange={(e) => setSrc1(e.target.value)}>
              {sources.map((s) => <option key={s} value={s}>{sourceLabel(s)}</option>)}
            </select>
          </div>
          {m.dual && (
            <div className="field grow">
              <label htmlFor="m-src2">To</label>
              <select id="m-src2" className="input" value={src2} onChange={(e) => setSrc2(e.target.value)}>
                {sources.map((s) => <option key={s} value={s}>{sourceLabel(s)}</option>)}
              </select>
            </div>
          )}
        </div>
        <button className="btn primary block" data-test="measure-add" onClick={() => void attempt(() => post("measure/add", { item, src1, src2: m.dual ? src2 : undefined }))}>Add measurement</button>
      </div>
      <div className="section">
        <div className="section-title"><span>Active</span>{rows.length > 0 && <button className="btn small" onClick={() => void attempt(() => post("measure/reset"))}>Reset statistics</button>}</div>
        {rows.length === 0 && <p className="body-text">None yet. They appear under the screen with running statistics and the app's own cross-check.</p>}
        {rows.map((r) => {
          const def = MEASUREMENTS.find((x) => x.item === r.slot.item);
          return (
            <div key={r.slot.id} className="metric-row">
              <span>{def?.label} · {sourceLabel(r.slot.src1)}{r.slot.src2 ? `→${sourceLabel(r.slot.src2)}` : ""}</span>
              <span className="row" style={{ gap: 6 }}>
                <strong>{fmt(r.value, def?.unit ?? "", 4)}</strong>
                <button className="icon-btn" style={{ width: 20, height: 20 }} aria-label="Remove" onClick={() => void attempt(() => post("measure/remove", { id: r.slot.id }))}>×</button>
              </span>
            </div>
          );
        })}
      </div>
      <GroupPanel group="measure" sub="threshold" title="Threshold type" />
      <GroupPanel group="measure" sub="setup" title="Reference levels" />
      <div className="section">
        <div className="section-title">All-measure</div>
        <Ctl id="measure.amsource" />
        <Ctl id="measure.statistic.display" label="Stats on screen" />
      </div>
    </>
  );
}

function MathSection() {
  const n = useUi((u) => u.math);
  useRead("math", n, null);
  return (
    <>
      <Picker count={4} value={n} onChange={(m) => setUi({ math: m })} prefix="M" color={(m) => `var(--math${m})`} />
      <div className="title-row"><h2><span className="swatch" style={{ background: `var(--math${n})` }} /> Math {n}</h2></div>
      <div className="section">
        <Ctl id="math.display" n={n} />
        <Ctl id="math.operator" n={n} />
        <Ctl id="math.source1" n={n} />
        <Ctl id="math.source2" n={n} />
        <Ctl id="math.lsource1" n={n} />
        <Ctl id="math.lsource2" n={n} />
        <Ctl id="math.scale" n={n} />
        <Ctl id="math.offset" n={n} />
        <Ctl id="math.invert" n={n} />
      </div>
      <GroupPanel group="math" sub="fft" n={n} title="FFT" />
      <GroupPanel group="math" sub="filter" n={n} title="Filter" />
      <p className="body-text">The Spectrum view computes its own FFT from the waveform with a known window and scaling; Math FFT here is the instrument's.</p>
    </>
  );
}

function Generator() {
  const n = useUi((u) => u.awg);
  useRead("source", n);
  const options = useLive((s) => s.options);
  const has = options.AFG100 || options.AFG50;
  const on = useLive((s) => s.values[key("source.output.state", n)] === true);
  return (
    <>
      <Picker count={C.instrument.awg_channels} value={n} onChange={(g) => setUi({ awg: g })} prefix="GEN " color={() => "var(--text)"} />
      <div className="title-row">
        <h2>Generator {n}</h2>
        <span className={`badge ${on ? "alarm" : "neutral"}`}>{on ? "output on" : "output off"}</span>
      </div>
      {!has && <p className="body-text" style={{ color: "var(--gold)" }}>:SYSTem:OPTion:STATus? reports neither AFG50 nor AFG100, so the generator commands will be refused by this instrument.</p>}
      <div className="section">
        <Ctl id="source.output.state" n={n} />
        <Ctl id="source.function" n={n} />
        <Ctl id="source.frequency" n={n} />
        <Ctl id="source.voltage.amplitude" n={n} />
        <Ctl id="source.voltage.offset" n={n} />
        <Ctl id="source.phase" n={n} />
        <Ctl id="source.function.square.duty" n={n} />
        <Ctl id="source.function.ramp.symmetry" n={n} />
        <Ctl id="source.impedance" n={n} />
        <div className="row" style={{ marginTop: 6 }}>
          <button className="btn small" onClick={() => void attempt(() => action("source.phase.synchronize", n), "Phases aligned")}>Align phases</button>
        </div>
      </div>
      <div className="section">
        <div className="section-title">Modulation</div>
        <Ctl id="source.mod.state" n={n} />
        <Ctl id="source.mod.type" n={n} />
        <Ctl id="source.mod.am.depth" n={n} />
        <Ctl id="source.mod.am.internal.frequency" n={n} />
        <Ctl id="source.mod.am.internal.function" n={n} />
        <Ctl id="source.mod.fm.deviation" n={n} />
        <Ctl id="source.mod.fm.internal.frequency" n={n} />
        <Ctl id="source.mod.fm.internal.function" n={n} />
        <Ctl id="source.mod.pm.deviation" n={n} />
        <Ctl id="source.mod.pm.internal.frequency" n={n} />
        <Ctl id="source.mod.pm.internal.function" n={n} />
      </div>
    </>
  );
}

function Counter() {
  useRead("counter");
  useRead("dvm");
  const r = useLive((s) => s.readings);
  const mode = useLive((s) => String(s.values["counter.mode"] ?? ""));
  return (
    <>
      <div className="title-row"><h2>Frequency counter</h2></div>
      <div className="hero" data-test="counter-hero">
        {r.counter === null ? "—" : fmt(r.counter, mode.startsWith("PER") ? "s" : "Hz", 7).split(" ")[0]}
        <small>{r.counter === null ? "" : fmt(r.counter, mode.startsWith("PER") ? "s" : "Hz", 7).split(" ")[1]}</small>
      </div>
      <div className="section" style={{ marginTop: 8 }}>
        <Ctl id="counter.enable" />
        <Ctl id="counter.source" />
        <Ctl id="counter.mode" />
        <Ctl id="counter.ndigits" />
        <Ctl id="counter.totalize.enable" />
      </div>
      <div className="title-row"><h2>Voltmeter</h2></div>
      <div className="hero" data-test="dvm-hero">{r.dvm === null ? "—" : fmt(r.dvm, "V", 5).split(" ")[0]}<small>{r.dvm === null ? "" : fmt(r.dvm, "V", 5).split(" ")[1]}</small></div>
      <div className="section" style={{ marginTop: 8 }}>
        <Ctl id="dvm.enable" />
        <Ctl id="dvm.source" />
        <Ctl id="dvm.mode" />
      </div>
    </>
  );
}
