// The "all measure" table for the channel chosen with RIGOL :MEASure:AMSource:
// every single-source parameter, computed by the app from the screen record it
// already reads (server/scope.ts → computeAllMeasure) — no queries, and nothing
// added to the scope's own measurement list. The scope's exact value of any one
// of them: add it as a measurement.

import { C } from "../../../core/src/constants.ts";
import { fmt } from "../../../core/src/format.ts";
import { attempt, post, useLive } from "../api.ts";
import { useReg } from "../registry.ts";
import { sourceLabel, sourceVar } from "../theme.ts";

export function AllMeasureGrid({ compact = false }: { compact?: boolean }) {
  const all = useLive((s) => s.allMeasure);
  const { measurements } = useReg();
  if (!all) return null;
  return (
    <div data-test="all-measure" style={{ display: "grid", gap: 8 }}>
      {all.srcs.map((src) => (
        <div key={src}>
          <div className="row" style={{ gap: 6, marginBottom: 4 }}>
            <span className="swatch" style={{ background: sourceVar(src), display: "inline-block" }} />
            <span className="section-title" style={{ margin: 0 }}>All measurements · {sourceLabel(src)}</span>
            <span className="muted" style={{ fontSize: 10 }} data-test="all-measure-note">
              computed by MHO Studio from the {all.points}-point screen record, every {C.measure.all_period_ms / 1000} s — no extra commands to the scope. For the scope's own value of one, add it as a measurement.
            </span>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: `repeat(auto-fill, minmax(${compact ? 130 : 150}px, 1fr))`, gap: "2px 12px" }}>
            {all.values.filter((v) => v.src === src).map((v) => {
              const m = measurements.find((x) => x.item === v.item);
              return (
                <div key={v.item} className="metric-row" style={{ fontSize: 11 }} data-test={`all-${v.item}`}>
                  <span className="muted" title={v.item}>{m?.label ?? v.item}</span>
                  <strong className="mono">{v.value === null ? "—" : fmt(v.value, m?.unit ?? "", 4)}</strong>
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

/** Make the scope's measurement list exactly the app's (clears items left on it, e.g. by 0.4.3). */
export function SyncMeasurementsButton() {
  return (
    <button className="btn small" data-test="measure-sync" title="Clear the scope's measurement list and put back only the measurements listed in the app" onClick={() => void attempt(() => post("measure/sync"), "The scope now shows only the app's measurements")}>
      Show only these on the scope
    </button>
  );
}
