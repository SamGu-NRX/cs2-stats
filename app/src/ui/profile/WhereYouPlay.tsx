// "Where you play": your positions summed over every match on a map. Positions are read from the
// on-disk cache only when this view opens.
import { useEffect, useState } from "react";
import { cellOf, type PosAgg } from "../../stats/positions";
import { useData } from "../data";
import { mapName } from "../format";
import { MapCanvas, PlaceBars, type Mark } from "../MapCanvas";
import { Segmented } from "../Segmented";
import type { ProfileTabProps } from "./ProfilePage";

export default function WhereYouPlay({ p }: ProfileTabProps) {
  const { client } = useData();
  const maps = p.maps.map((m) => m.map);
  const [map, setMap] = useState(p.posMaps[0] ?? maps[0]);
  const [pos, setPos] = useState<PosAgg | null>(null);
  const [layer, setLayer] = useState<"heat" | "kd">(p.posMaps.includes(map) ? "heat" : "kd");

  useEffect(() => {
    if (!client || !map) return;
    let alive = true;
    setPos(null);
    client.profilePositions(map).then((x) => alive && setPos(x));
    return () => { alive = false; };
  }, [client, map]);

  const hasHeat = !!pos && Object.keys(pos.human).length > 0;
  // A map without position samples cannot show the heatmap; fall back to kills and deaths.
  useEffect(() => {
    if (pos && !hasHeat && layer === "heat") setLayer("kd");
  }, [pos, hasHeat, layer]);
  const marks: Mark[] = pos && layer === "kd" ? [...pos.kills.map(([x, y]) => ({ x, y, kind: "kill" as const })), ...pos.deaths.map(([x, y]) => ({ x, y, kind: "death" as const }))] : [];
  // Without samples, your kill and death spots outline the map.
  const backdrop = pos && !Object.keys(pos.all).length ? { ...pos, all: Object.fromEntries([...pos.kills, ...pos.deaths].map(([x, y]) => [cellOf(x, y), 1]).filter(([c]) => c >= 0)) } : pos;

  return (
    <div className="grid-map">
      <section className="glass card" aria-label="Where you play">
        <div className="card__head" style={{ flexWrap: "wrap" }}>
          {maps.length > 1 ? <Segmented size="sm" label="Map" value={map} onChange={setMap} options={maps.map((m) => ({ value: m, label: mapName(m) }))} /> : <h2 className="card__title">{mapName(map)}</h2>}
          <Segmented size="sm" label="Layer" value={layer} onChange={setLayer} options={[
            { value: "heat", label: "Heatmap", disabled: !hasHeat, tip: hasHeat ? undefined : "No position samples on this map yet" },
            { value: "kd", label: "Kills & deaths" },
          ]} />
        </div>
        {backdrop ? <MapCanvas pos={backdrop} marks={marks} showHeat={layer === "heat"} label={`Your ${layer === "heat" ? "time alive" : "kill and death spots"} on ${mapName(map)}`} /> : <div className="skeleton mapcv" />}
        <p className="note" style={{ marginTop: 8 }}>{layer === "heat" ? "Your time alive across all matches on this map: blue = little, red = most." : "Green dots: where you stood for a kill. Red crosses: where you died."}</p>
      </section>
      <section className="glass card" aria-label="Time per place">
        <div className="card__head"><h2 className="card__title has-tip" tabIndex={0} data-tip="Share of your time alive spent in each map place, across all matches on this map.">Time per place</h2></div>
        {pos && hasHeat ? <PlaceBars places={pos.places} /> : <p className="note">No position samples on this map yet. The capture plugin records them for new matches.</p>}
      </section>
    </div>
  );
}
