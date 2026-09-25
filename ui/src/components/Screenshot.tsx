// :DISPlay:DATA? PNG — a picture of the instrument's own display, as it is now.

import { useEffect, useState } from "react";
import { Icon } from "./Icons.tsx";

export function ScreenshotModal({ onClose }: { onClose: () => void }) {
  const [src, setSrc] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [at, setAt] = useState(0);
  useEffect(() => {
    let url: string | null = null;
    setSrc(null);
    setErr(null);
    fetch(`./api/screenshot.png?t=${at}`)
      .then(async (r) => {
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? r.statusText);
        url = URL.createObjectURL(await r.blob());
        setSrc(url);
      })
      .catch((e) => setErr((e as Error).message));
    return () => {
      if (url) URL.revokeObjectURL(url);
    };
  }, [at]);
  return (
    <div className="modal-back" role="dialog" aria-modal="true" aria-labelledby="shot-title" onClick={onClose}>
      <div className="modal wide" onClick={(e) => e.stopPropagation()}>
        <div className="title-row" style={{ marginBottom: 0 }}>
          <h2 id="shot-title">Instrument display</h2>
          <div className="row">
            <button className="btn small" onClick={() => setAt(Date.now())}>Refresh</button>
            <a className="btn small" href="./api/screenshot.png?download=1" download><Icon.download /> Save PNG</a>
            <button className="icon-btn" aria-label="Close" onClick={onClose}><Icon.x /></button>
          </div>
        </div>
        {err && <p className="body-text" style={{ color: "var(--coral)" }}>{err}</p>}
        {!src && !err && <p className="body-text">Reading the display from the instrument…</p>}
        {src && <img src={src} alt="The oscilloscope's display" data-test="screenshot-img" />}
      </div>
    </div>
  );
}
