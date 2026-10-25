// The title bar's scope controls: map, matches (last N), side, gun class and result. Every scope a view
// has lives here, in the title bar, and in the hash query, so a scoped view is a link
// (#/aim?map=de_dust2&n=10&side=t&guns=rifle). Pages never draw their own copies; the one exception
// is the Profile attributes panel's own Side and "Compared to" controls.
//
// How a view declares its controls: pass `scope` to BarContent (shell/Bar.tsx), in title-bar order,
// and read the values with useScope.
//
//   const scope = useScope();
//   const { list } = useCareer(scope);                    // data/hooks.ts: career set under map and N
//   <BarContent crumbs={[{ label: "Career aim" }]} scope={{ controls: ["map", "matches", "side", "guns"] }} />
//
// Match tabs with a side split (Overview, Utility, Positions, Aim) declare `scope={{ controls: ["side"] }}`
// on the match view's BarContent and read `useScope().side` instead of keeping their own Side control;
// for the side to carry across tabs, the tab links must pass it on (matchHref's query argument).
//
// A control that does not apply right now stays in place, disabled, with the reason as its tooltip,
// instead of disappearing: `off: { side: "No sides in a converted log" }`. A side the data lacks is
// disabled alone: `off: { "side:ct": "No CT rounds in this match" }`.
//
// Query keys: map (a map id; absent = all), n (5/10/20; absent = all), side (t/ct; absent = both),
// guns (rifle/sniper/smg/heavy/pistol; absent = all guns), result (W/L; absent = all).
import { useMemo } from "react";
import { careerEntries, mapsIn, SIDE_OPTIONS, WEAPON_CLASS_LABEL, type SideKey } from "../data/engine";
import { useData } from "../data/provider";
import { Segmented, Select, type Option } from "../components/controls";
import { mapName } from "../lib/format";
import { setQuery, useRoute } from "../router";

export type ScopeControl = "map" | "matches" | "side" | "guns" | "result";
/** Gun classes Career aim scopes to; "all" is every gun. */
export const GUN_CLASSES = ["rifle", "sniper", "smg", "heavy", "pistol"] as const;
export type GunClass = (typeof GUN_CLASSES)[number] | "all";
export type ResultScope = "all" | "W" | "L";

export interface Scope {
  /** a map id, or null for all maps */
  map: string | null;
  /** the last N career matches, or null for all */
  n: number | null;
  side: SideKey;
  guns: GunClass;
  result: ResultScope;
}

export interface ScopeDecl {
  /** the controls this view has, in title-bar order */
  controls: ScopeControl[];
  /** controls (or one side) that do not apply right now: shown disabled, the text says why */
  off?: Partial<Record<ScopeControl | "side:t" | "side:ct", string>>;
  /** which matches the Map list offers: the career set (default) or every listed match, pro demos included (Matches) */
  maps?: "career" | "all";
}

const LAST_N = [5, 10, 20];

/** The scope in the URL. Unknown values read as the default, so a hand-edited link never breaks a view. */
export function useScope(): Scope {
  const r = useRoute();
  return useMemo(() => {
    const q = r.query;
    const side = q.get("side");
    const n = Number(q.get("n"));
    const guns = q.get("guns");
    const result = q.get("result");
    return {
      map: q.get("map"),
      n: LAST_N.includes(n) ? n : null,
      side: side === "t" || side === "ct" ? side : "both",
      guns: (GUN_CLASSES as readonly string[]).includes(guns ?? "") ? (guns as GunClass) : "all",
      result: result === "W" || result === "L" ? result : "all",
    };
  }, [r]);
}

function MapControl({ off, pool }: { off?: string; pool: "career" | "all" }) {
  const { matches } = useData();
  const { map } = useScope();
  const maps = useMemo(() => mapsIn(pool === "all" ? matches : careerEntries(matches, null)), [matches, pool]);
  return (
    <Select
      label="Map"
      prefix="Map"
      value={map ?? "all"}
      disabled={off}
      onChange={(v) => setQuery("map", v === "all" ? null : v)}
      options={[{ value: "all", label: "All maps" }, ...maps.map((m) => ({ value: m, label: mapName(m) }))]}
    />
  );
}

function MatchesControl({ off }: { off?: string }) {
  const { matches } = useData();
  const { map, n } = useScope();
  const total = useMemo(() => careerEntries(matches, map).length, [matches, map]);
  const options: Option<string>[] = [{ value: "all", label: `All ${total}` }, ...LAST_N.filter((k) => k < total).map((k) => ({ value: String(k), label: `Last ${k}` }))];
  return (
    <Select
      label="Matches counted"
      prefix="Matches"
      value={n && n < total ? String(n) : "all"}
      disabled={off ?? (total === 0 ? "No matches yet" : undefined)}
      onChange={(v) => setQuery("n", v === "all" ? null : v)}
      options={options}
    />
  );
}

function SideControl({ off, offT, offCt }: { off?: string; offT?: string; offCt?: string }) {
  const { side } = useScope();
  const disabled = (k: SideKey) => !!off || (k === "t" && !!offT) || (k === "ct" && !!offCt);
  const tip = (k: SideKey) => off ?? (k === "t" ? offT : k === "ct" ? offCt : undefined);
  return (
    <Segmented
      label="Side"
      value={disabled(side) ? "both" : side}
      onChange={(v) => setQuery("side", v === "both" ? null : v)}
      options={SIDE_OPTIONS.map((o) => ({ ...o, side: o.value === "both" ? undefined : o.value, disabled: disabled(o.value), tip: tip(o.value) }))}
    />
  );
}

function GunsControl({ off }: { off?: string }) {
  const { guns } = useScope();
  return (
    <Select
      label="Gun class"
      prefix="Guns"
      value={guns}
      disabled={off}
      onChange={(v) => setQuery("guns", v === "all" ? null : v)}
      options={[{ value: "all", label: "All guns" }, ...GUN_CLASSES.map((c) => ({ value: c, label: WEAPON_CLASS_LABEL[c] }))]}
    />
  );
}

function ResultControl({ off }: { off?: string }) {
  const { result } = useScope();
  return (
    <Segmented
      label="Result"
      value={result}
      onChange={(v) => setQuery("result", v === "all" ? null : v)}
      options={[{ value: "all", label: "All", disabled: !!off, tip: off }, { value: "W", label: "Wins", disabled: !!off, tip: off }, { value: "L", label: "Losses", disabled: !!off, tip: off }]}
    />
  );
}

/** The declared controls, in order. BarContent renders this; views do not render it themselves. */
export function ScopeControls({ controls, off = {}, maps = "career" }: ScopeDecl) {
  return (
    <>
      {controls.map((c) => {
        switch (c) {
          case "map": return <MapControl key={c} off={off.map} pool={maps} />;
          case "matches": return <MatchesControl key={c} off={off.matches} />;
          case "side": return <SideControl key={c} off={off.side} offT={off["side:t"]} offCt={off["side:ct"]} />;
          case "guns": return <GunsControl key={c} off={off.guns} />;
          case "result": return <ResultControl key={c} off={off.result} />;
        }
      })}
    </>
  );
}

/**
 * Profile's in-page Side strip, kept only until the Profile attributes panel (views/profile/
 * AttributesPanel.tsx) takes its own Side control. Nothing else should use it: scope belongs in the
 * title bar.
 */
export const SideFilter = () => <SideControl />;
