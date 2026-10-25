// View-scoped filters for the app bar, kept in the hash query so a filtered view is a link.
import { mapsIn, SIDE_OPTIONS, type SideKey } from "../data/engine";
import { useData } from "../data/provider";
import { Segmented, Select } from "../components/controls";
import { mapName } from "../lib/format";
import { setQuery, useRoute } from "../router";

export function useFilters() {
  const r = useRoute();
  const side = (r.query.get("side") as SideKey) || "both";
  const n = Number(r.query.get("n")) || null;
  return { map: r.query.get("map"), side: (["both", "t", "ct"].includes(side) ? side : "both") as SideKey, n };
}

export function MapFilter() {
  const { matches } = useData();
  const { map } = useFilters();
  const maps = mapsIn(matches);
  return (
    <Select
      label="Map"
      prefix="Map"
      value={map ?? "all"}
      onChange={(v) => setQuery("map", v === "all" ? null : v)}
      options={[{ value: "all", label: "All maps" }, ...maps.map((m) => ({ value: m, label: mapName(m) }))]}
    />
  );
}

export function TimeFilter() {
  const { n } = useFilters();
  return (
    <Select
      label="Time"
      prefix="Matches"
      value={String(n ?? "all")}
      onChange={(v) => setQuery("n", v === "all" ? null : v)}
      options={[{ value: "all", label: "All" }, { value: "20", label: "Last 20" }, { value: "10", label: "Last 10" }, { value: "5", label: "Last 5" }]}
    />
  );
}

export function SideFilter() {
  const { side } = useFilters();
  return (
    <Segmented
      label="Side"
      value={side}
      onChange={(v) => setQuery("side", v === "both" ? null : v)}
      options={SIDE_OPTIONS.map((o) => ({ ...o, side: o.value === "both" ? undefined : o.value }))}
    />
  );
}
