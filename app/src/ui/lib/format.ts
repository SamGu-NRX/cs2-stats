// Number and text formats. Stats follow HLTV's formats: Rating 1.46, Swing +5.03%, KAST 71.0%,
// ADR 86.2, KPR 0.84. Missing values render as an en dash so columns keep their width.

export const DASH = "–";
const MINUS = "−";

const MAP_NAMES: Record<string, string> = {
  de_dust2: "Dust II", de_mirage: "Mirage", de_inferno: "Inferno", de_nuke: "Nuke", de_overpass: "Overpass",
  de_ancient: "Ancient", de_anubis: "Anubis", de_vertigo: "Vertigo", de_train: "Train", cs_office: "Office", cs_italy: "Italy",
};
export const mapName = (m: string) => MAP_NAMES[m] ?? m.replace(/^(de|cs|ar)_/, "").replace(/^./, (c) => c.toUpperCase());

const ok = (v: number | null | undefined): v is number => v !== null && v !== undefined && Number.isFinite(v);

/** Sign prefix with a true minus sign; zero gets no sign. */
export function signed(v: number, digits: number): string {
  const s = Math.abs(v).toFixed(digits);
  if (Number(s) === 0) return (0).toFixed(digits);
  return (v > 0 ? "+" : MINUS) + s;
}

export const fmtRating = (v: number | null | undefined) => (ok(v) ? v.toFixed(2) : DASH);
/** Swing is stored as a win-probability fraction: 0.0503 → "+5.03%". */
export const fmtSwing = (v: number | null | undefined) => (ok(v) ? `${signed(100 * v, 2)}%` : DASH);
/** Percent already on a 0–100 scale: 71 → "71.0%". */
export const fmtPct = (v: number | null | undefined, digits = 1) => (ok(v) ? `${v.toFixed(digits)}%` : DASH);
export const fmtRatio = (a: number, b: number, digits = 1) => (b > 0 ? fmtPct((100 * a) / b, digits) : DASH);
export const fmtDec = (v: number | null | undefined, digits = 2) => (ok(v) ? v.toFixed(digits) : DASH);
export const fmtAdr = (v: number | null | undefined) => fmtDec(v, 1);
export const fmtInt = (v: number | null | undefined) => (ok(v) ? String(Math.round(v)) : DASH);
export const fmtDiff = (v: number | null | undefined) => (ok(v) ? signed(v, 0) : DASH);
export const fmtMs = (v: number | null | undefined) => (ok(v) ? `${Math.round(v)} ms` : DASH);
export const fmtDeg = (v: number | null | undefined, digits = 1) => (ok(v) ? `${v.toFixed(digits)}°` : DASH);
export const fmtSecs = (v: number | null | undefined, digits = 1) => (ok(v) ? `${v.toFixed(digits)} s` : DASH);
export const fmtMoney = (v: number | null | undefined) => (ok(v) ? `$${Math.round(v).toLocaleString("en-US")}` : DASH);
/** $4,750 → "$4.8k"; under $1,000 stays exact. */
export const fmtMoneyShort = (v: number | null | undefined) => (!ok(v) ? DASH : Math.abs(v) < 1000 ? `$${Math.round(v)}` : `$${(v / 1000).toFixed(1)}k`);

/** Round clock: seconds since freeze end → "1:07". */
export function fmtClock(secs: number | null | undefined): string {
  if (!ok(secs)) return DASH;
  const s = Math.max(0, Math.round(secs));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

const dateFmt = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" });
const yearFmt = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" });
/**
 * Match dates are calendar days ("2026-10-24"). Date parses that form as UTC midnight, which
 * formats as the previous day west of UTC, so it is read as a local date.
 */
function day(d: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d);
  return m ? new Date(+m[1], +m[2] - 1, +m[3]) : new Date(d);
}
export const fmtDate = (d: string | null) => (d ? dateFmt.format(day(d)) : DASH);
export const fmtDateYear = (d: string | null) => (d ? yearFmt.format(day(d)) : DASH);

/** "3 matches", "1 match" */
export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Initials for a name: "m0NESY" → "M0", "Twistzz" → "TW". */
export function initials(name: string): string {
  const parts = name.trim().split(/[\s_-]+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}
