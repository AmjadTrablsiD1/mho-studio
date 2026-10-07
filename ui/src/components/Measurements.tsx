// Editing measurements after they are added: every row can change what it
// measures and on which channel(s) — in place, keeping its position — or be
// removed. Used by the table under the screen and by the inspector.

import type { Slot } from "../../../core/src/registry/measurements.ts";
import { attempt, getLive, post } from "../api.ts";
import { reg, useReg } from "../registry.ts";
import { getUi } from "../uistate.ts";
import { sourceLabel } from "../theme.ts";

const compact = { height: 24, padding: "0 4px", fontSize: 11 } as const;
const CATEGORY: Record<string, string> = { vertical: "Vertical", horizontal: "Horizontal", other: "Counts, delay, phase" };

const update = (id: string, patch: { item?: string; src1?: string; src2?: string }) => attempt(() => post("measure/update", { id, ...patch }));

/** Which quantity a row measures. */
export function ItemSelect({ slot, index }: { slot: Slot; index: number }) {
  const { measurements } = useReg();
  const cats = [...new Set(measurements.map((m) => m.category))];
  return (
    <select className="input" style={{ ...compact, minWidth: 0, width: "100%" }} aria-label={`Measurement ${index + 1}: quantity`} value={slot.item} onChange={(e) => void update(slot.id, { item: e.target.value })} data-test={`m-item-${index}`}>
      {cats.map((cat) => (
        <optgroup key={cat} label={CATEGORY[cat] ?? cat}>
          {measurements.filter((m) => m.category === cat).map((m) => <option key={m.item} value={m.item}>{m.label}</option>)}
        </optgroup>
      ))}
    </select>
  );
}

/** Which channel (or, for delay and phase, which two) a row measures. */
export function SourceSelect({ slot, index, which = "src1" }: { slot: Slot; index: number; which?: "src1" | "src2" }) {
  const { measureSources } = useReg();
  const value = which === "src1" ? slot.src1 : (slot.src2 ?? "");
  return (
    <select className="input" style={{ ...compact, width: 92 }} aria-label={`Measurement ${index + 1}: ${which === "src1" ? (slot.src2 ? "from" : "source") : "to"}`} value={value} onChange={(e) => void update(slot.id, { [which]: e.target.value })} data-test={`m-${which}-${index}`}>
      {measureSources.map((s) => <option key={s} value={s}>{sourceLabel(s)}</option>)}
    </select>
  );
}

export function RemoveButton({ slot, label }: { slot: Slot; label: string }) {
  return (
    <button className="icon-btn" style={{ width: 22, height: 22 }} aria-label={`Remove ${label}`} title="Remove this measurement" onClick={() => void attempt(() => post("measure/remove", { id: slot.id }))}>
      ×
    </button>
  );
}

/**
 * Add a measurement straight away — the instrument's peak-to-peak, or whatever the
 * last row measures, on the channel selected in the rail — to be changed in its row.
 */
export function addQuick(): Promise<unknown> {
  const r = reg();
  const rows = getLive().measure;
  const last = rows[rows.length - 1]?.slot;
  const ch = `CHANnel${getUi().channel}`;
  const src1 = r.measureSources.includes(ch) ? ch : r.measureSources[0];
  const item = last && r.measurements.some((m) => m.item === last.item) ? last.item : (r.measurements.find((m) => /^(VPP|PKPK)$/.test(m.item)) ?? r.measurements[0]).item;
  return attempt(() => post("measure/add", { item, src1, src2: r.measureSources.find((s) => s !== src1) }));
}
