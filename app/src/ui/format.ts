const MAP_NAMES: Record<string, string> = {
  de_dust2: "Dust II", de_mirage: "Mirage", de_inferno: "Inferno", de_nuke: "Nuke", de_overpass: "Overpass",
  de_ancient: "Ancient", de_anubis: "Anubis", de_vertigo: "Vertigo", de_train: "Train", cs_office: "Office", cs_italy: "Italy",
};
export const mapName = (m: string) => MAP_NAMES[m] ?? m.replace(/^(de|cs)_/, "").replace(/^./, (c) => c.toUpperCase());

const dateFmt = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", year: "numeric" });
const timeFmt = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" });
export const fmtDate = (iso: string) => dateFmt.format(new Date(iso));
export const fmtTime = (iso: string) => timeFmt.format(new Date(iso));
export const fmtDuration = (a: string, b: string) => `${Math.round((Date.parse(b) - Date.parse(a)) / 60000)} min`;

export const ratingClass = (r: number) => (r >= 1.1 ? "pos" : r < 0.9 ? "neg" : "");
export const signed = (n: number, digits = 0) => (n > 0 ? "+" : n < 0 ? "−" : "±") + Math.abs(n).toFixed(digits);
/** win-probability points, e.g. 0.034 → "+3.4%" */
export const swingPct = (v: number | null) => (v === null ? "–" : `${signed(100 * v, 1)}%`);
export const money = (v: number | null) => (v === null ? "–" : `$${v.toLocaleString("en-US")}`);
