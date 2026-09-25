// Line icons, 16×16, stroke = currentColor. Drawn here so nothing is fetched.

const P = { fill: "none", stroke: "currentColor", strokeWidth: 1.5, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };

export const Icon = {
  scope: () => (
    <svg viewBox="0 0 16 16" {...P}><rect x="1.5" y="2.5" width="13" height="11" rx="1.5" /><path d="M3 10c1.5 0 1.5-5 3-5s1.5 5 3 5 1.5-5 3-5 1 2 1 2" /></svg>
  ),
  spectrum: () => (
    <svg viewBox="0 0 16 16" {...P}><path d="M2 14h12M3.5 14V11M6 14V5M8.5 14V9M11 14V3M13.5 14v-4" /></svg>
  ),
  bode: () => (
    <svg viewBox="0 0 16 16" {...P}><path d="M2 4h5c2 0 3 2 4 5l2 5" /><path d="M2 10h4c3 0 4 1 8-2" strokeDasharray="1.5 2" /></svg>
  ),
  deep: () => (
    <svg viewBox="0 0 16 16" {...P}><path d="M2 8h1.5l1-4 1.5 8 1.5-9 1.5 10 1.5-7 1 2H14" /><path d="M1.5 14.5h13" /></svg>
  ),
  decode: () => (
    <svg viewBox="0 0 16 16" {...P}><path d="M1.5 5h2l1-2h3l1 2h6M1.5 11h3l1 2h3l1-2h5" /><path d="M5.5 5v6M10.5 5v6" /></svg>
  ),
  console: () => (
    <svg viewBox="0 0 16 16" {...P}><rect x="1.5" y="2.5" width="13" height="11" rx="1.5" /><path d="M4 6l2 2-2 2M8 10h4" /></svg>
  ),
  instrument: () => (
    <svg viewBox="0 0 16 16" {...P}><rect x="1.5" y="3" width="13" height="10" rx="1.5" /><rect x="3" y="4.5" width="6.5" height="5" rx=".5" /><circle cx="12" cy="6" r="1" /><circle cx="12" cy="10" r="1" /></svg>
  ),
  settings: () => (
    <svg viewBox="0 0 16 16" {...P}><path d="M2 4h7M12 4h2M2 8h2M7 8h7M2 12h9M14 12h0" /><circle cx="10.5" cy="4" r="1.5" /><circle cx="5.5" cy="8" r="1.5" /><circle cx="12.5" cy="12" r="1.5" /></svg>
  ),
  camera: () => (
    <svg viewBox="0 0 16 16" {...P}><path d="M2 5.5h2.5l1.2-2h4.6l1.2 2H14v7.5H2z" /><circle cx="8" cy="9" r="2.3" /></svg>
  ),
  sun: () => (
    <svg viewBox="0 0 16 16" {...P}><circle cx="8" cy="8" r="3" /><path d="M8 1v1.5M8 13.5V15M1 8h1.5M13.5 8H15M3 3l1 1M12 12l1 1M13 3l-1 1M4 12l-1 1" /></svg>
  ),
  moon: () => (
    <svg viewBox="0 0 16 16" {...P}><path d="M13.5 9.5A5.5 5.5 0 0 1 6.5 2.5a5.5 5.5 0 1 0 7 7z" /></svg>
  ),
  panel: () => (
    <svg viewBox="0 0 16 16" {...P}><rect x="1.5" y="2.5" width="13" height="11" rx="1.5" /><path d="M10 2.5v11" /></svg>
  ),
  x: () => (
    <svg viewBox="0 0 16 16" {...P}><path d="M4 4l8 8M12 4l-8 8" /></svg>
  ),
  download: () => (
    <svg viewBox="0 0 16 16" {...P}><path d="M8 2v8M5 7l3 3 3-3M2.5 13.5h11" /></svg>
  ),
  persist: () => (
    <svg viewBox="0 0 16 16" {...P}><path d="M2 10c2 0 2-5 4-5s2 5 4 5 2-5 4-5" opacity=".35" /><path d="M2 12c2 0 2-5 4-5s2 5 4 5 2-5 4-5" /></svg>
  ),
};
