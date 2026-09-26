// One widget for every registry control: the kind picks the widget, the
// registry supplies label, unit, options, steps and relevance. Every write
// shows what the instrument actually accepted.

import { useEffect, useMemo, useRef, useState } from "react";
import { BY_ID, CONTROLS, key, relevant, type Control } from "../../../core/src/registry/controls.ts";
import { fmt, parseSI } from "../../../core/src/format.ts";
import { step125, stepFine } from "../../../core/src/wave/steps.ts";
import type { Value } from "../../../core/src/scpi/values.ts";
import { action, attempt, getLive, readGroup, toast, useLive, writeControl, type WriteResult } from "../api.ts";
import { GROUP_LABEL, mnemonicLabel } from "../../../core/src/registry/labels.ts";

/** The key a `when` rule depends on, bound to the same suffix. */
function depKey(c: Control, n: number | null): string | null {
  if (!c.when) return null;
  const dep = BY_ID.get(c.when.id);
  return dep?.suffix ? key(c.when.id, n ?? 1) : c.when.id;
}

/** A sensible knob step for values the registry cannot give one for. */
export function smartStep(c: Control, n: number | null, v: number): number {
  const vals = getLive().values;
  if (typeof c.step === "number") return c.step;
  if (c.id === "channel.offset" || c.id === "channel.position") return Number(vals[key("channel.scale", n ?? 1)] ?? 0.1) / 5;
  if (/level$/.test(c.id) && c.group === "trigger") {
    const src = /(\d)$/.exec(String(vals["trigger.edge.source"] ?? ""))?.[1] ?? "1";
    return Number(vals[key("channel.scale", Number(src))] ?? 0.1) / 10;
  }
  if (c.id === "timebase.offset") return Number(vals["timebase.scale"] ?? 1e-6);
  if (c.id === "timebase.delay.offset") return Number(vals["timebase.delay.scale"] ?? 1e-7);
  const a = Math.abs(v);
  return a > 0 ? 10 ** (Math.floor(Math.log10(a)) - 1) : c.unit === "s" ? 1e-9 : 0.01;
}

export function nextValue(c: Control, n: number | null, v: number, dir: 1 | -1, fine = false): number {
  if (c.step === "125" && !fine) return step125(v, dir);
  if (c.step === "125" || c.step === "fine") return stepFine(v, dir);
  const s = smartStep(c, n, v);
  const x = v + dir * s;
  const r = Number(x.toPrecision(6));
  return c.min !== undefined && r < c.min ? c.min : c.max !== undefined && r > c.max ? c.max : r;
}

export function valueText(c: Control, v: Value | undefined): string {
  if (v === undefined || v === null) return "—";
  if (c.kind === "bool") return v ? "On" : "Off";
  if (c.kind === "enum") return c.options?.find((o) => o.value === v)?.label ?? String(v);
  if (typeof v === "number") return fmt(v, c.unit ?? "", 4);
  return String(v);
}

type Note = { text: string; err?: boolean } | null;

export function useWrite(k: string): [(v: Value) => Promise<void>, Note, boolean] {
  const [note, setNote] = useState<Note>(null);
  const [busy, setBusy] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const write = async (v: Value) => {
    setBusy(true);
    const r: WriteResult | null = await attempt(() => writeControl(k, v));
    setBusy(false);
    clearTimeout(timer.current);
    if (!r) return;
    const c = BY_ID.get(k.split("@")[0])!;
    if (r.errors.length) setNote({ text: r.errors.map((e) => `${e.code} ${e.message}`).join("; "), err: true });
    else if (r.coerced) setNote({ text: `asked ${valueText(c, r.requested)} — instrument set ${valueText(c, r.value)}` });
    else setNote(null);
    timer.current = setTimeout(() => setNote(null), 6000);
  };
  useEffect(() => () => clearTimeout(timer.current), []);
  return [write, note, busy];
}

export function Ctl({ id, n = null, label, hideLabel }: { id: string; n?: number | null; label?: string; hideLabel?: boolean }) {
  const c = BY_ID.get(id);
  const k = c ? key(id, c.suffix ? (n ?? 1) : null) : id;
  const v = useLive((s) => s.values[k]);
  const dk = c ? depKey(c, n) : null;
  const dv = useLive((s) => (dk ? s.values[dk] : undefined));
  const connected = useLive((s) => s.link?.state === "connected");
  const unanswered = useLive((s) => s.unsupported.includes(id));
  const [write, note, busy] = useWrite(k);
  if (!c) return <div className="ctl"><span className="c-label">unknown {id}</span></div>;
  if (c.when && !relevant(c, n, () => dv)) return null;
  const name = label ?? c.label;
  if (unanswered && c.kind !== "action")
    return (
      <div className="ctl" data-ctl={k}>
        {!hideLabel && <span className="c-label" title={`${c.header}  (guide §${c.section})`}><span>{name}</span></span>}
        <div className="c-ro muted" title={`${c.header}? got no reply from this instrument's firmware; the app no longer asks it`}>not answered by this firmware</div>
      </div>
    );
  return (
    <div className="ctl" data-ctl={k}>
      {!hideLabel && (
        <label className="c-label" title={`${c.header}  (guide §${c.section})`} htmlFor={`ctl-${k}`}>
          <span>{name}</span>
        </label>
      )}
      <Widget c={c} n={n} k={k} v={v} write={write} disabled={!connected || busy} name={name} />
      {note && <div className={`c-note${note.err ? " err" : ""}`}>{note.text}</div>}
    </div>
  );
}

function Widget({ c, n, k, v, write, disabled, name }: { c: Control; n: number | null; k: string; v: Value | undefined; write: (v: Value) => Promise<void>; disabled: boolean; name: string }) {
  switch (c.kind) {
    case "bool":
      return (
        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <button id={`ctl-${k}`} className="switch" role="switch" aria-checked={v === true} aria-label={name} disabled={disabled} onClick={() => void write(!(v === true))} />
        </div>
      );
    case "enum": {
      const opts = c.options ?? [];
      const seg = opts.length <= 4 && opts.every((o) => o.label.length <= 9);
      if (seg)
        return (
          <div className="ctl-seg" role="radiogroup" aria-label={name}>
            {opts.map((o) => (
              <button key={o.value} role="radio" aria-checked={v === o.value} className={v === o.value ? "active" : ""} disabled={disabled} onClick={() => void write(o.value)}>
                {o.label}
              </button>
            ))}
          </div>
        );
      return (
        <select id={`ctl-${k}`} className="input" aria-label={name} value={typeof v === "string" ? v : ""} disabled={disabled} onChange={(e) => void write(e.target.value)}>
          {typeof v !== "string" || !opts.some((o) => o.value === v) ? <option value="">{v === undefined || v === null ? "—" : String(v)}</option> : null}
          {opts.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
      );
    }
    case "number":
      return <NumberField c={c} n={n} k={k} v={typeof v === "number" ? v : null} write={write} disabled={disabled} name={name} />;
    case "string":
      return <TextField k={k} v={v === undefined || v === null ? "" : String(v)} write={write} disabled={disabled} name={name} />;
    case "action":
      return (
        <button className="btn small" disabled={disabled} onClick={() => void attempt(() => action(c.id, n), `${name} sent`)}>
          {name}
        </button>
      );
    default:
      return <div className="c-ro" aria-label={name}>{valueText(c, v)}</div>;
  }
}

export function NumberField({ c, n, k, v, write, disabled, name }: { c: Control; n: number | null; k: string; v: number | null; write: (v: Value) => Promise<void>; disabled: boolean; name: string }) {
  const [text, setText] = useState<string | null>(null);
  const shown = text ?? (v === null ? "—" : fmt(v, c.unit ?? "", 4));
  const commit = () => {
    if (text === null) return;
    const x = parseSI(text);
    setText(null);
    if (x === null) return toast("error", `${name}: "${text}" is not a number`);
    void write(x);
  };
  const bump = (dir: 1 | -1, fine = false) => {
    if (v === null) return;
    void write(nextValue(c, n, v, dir, fine));
  };
  return (
    <div className="stepper" onWheel={(e) => {
      if (disabled || document.activeElement?.closest(".stepper") !== e.currentTarget) return;
      bump(e.deltaY < 0 ? 1 : -1, e.shiftKey);
    }}>
      <button aria-label={`decrease ${name}`} disabled={disabled || v === null} onClick={(e) => bump(-1, e.shiftKey)}>‹</button>
      <input
        id={`ctl-${k}`}
        aria-label={name}
        value={shown}
        disabled={disabled}
        onFocus={() => setText(v === null ? "" : fmt(v, c.unit ?? "", 6))}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          if (e.key === "Escape") {
            setText(null);
            (e.target as HTMLInputElement).blur();
          }
          if (e.key === "ArrowUp" || e.key === "ArrowDown") {
            e.preventDefault();
            setText(null);
            bump(e.key === "ArrowUp" ? 1 : -1, e.shiftKey);
          }
        }}
      />
      <button aria-label={`increase ${name}`} disabled={disabled || v === null} onClick={(e) => bump(1, e.shiftKey)}>›</button>
    </div>
  );
}

function TextField({ k, v, write, disabled, name }: { k: string; v: string; write: (v: Value) => Promise<void>; disabled: boolean; name: string }) {
  const [text, setText] = useState<string | null>(null);
  return (
    <input
      id={`ctl-${k}`}
      className="input"
      aria-label={name}
      value={text ?? v}
      disabled={disabled}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => {
        if (text !== null && text !== v) void write(text);
        setText(null);
      }}
      onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
    />
  );
}

/** Every visible control of a group (and sub-group), read back from the instrument when shown. */
export function GroupPanel({ group, sub, n, title, exclude = [] }: { group: string; sub?: string | null; n?: number; title?: string; exclude?: string[] }) {
  const connected = useLive((s) => s.link?.state === "connected");
  const options = useLive((s) => s.options);
  const list = useMemo(
    () => CONTROLS.filter((c) => c.group === group && (sub === undefined || c.sub === sub) && !c.hidden && !exclude.includes(c.id)),
    [group, sub, exclude.join(",")],
  );
  useEffect(() => {
    if (connected) void readGroup(group, sub, n).catch(() => {});
  }, [connected, group, sub, n]);
  const needs = list.find((c) => c.needs)?.needs;
  const has = !needs || (needs === "AFG" ? options.AFG100 || options.AFG50 : options[needs]);
  return (
    <div className="section">
      <div className="section-title">
        <span>{title ?? (sub ? `${GROUP_LABEL[group] ?? group} · ${mnemonicLabel(sub.toUpperCase())}` : GROUP_LABEL[group] ?? group)}</span>
        {needs && !has && <span className="badge warn">needs {needs === "AFG" ? "AFG option" : needs}</span>}
      </div>
      {list.map((c) => (
        <Ctl key={c.id} id={c.id} n={c.suffix ? (n ?? 1) : null} />
      ))}
    </div>
  );
}
