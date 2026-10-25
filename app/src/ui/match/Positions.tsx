// Positions: where you spent the match, where you got kills and died, and time per map place.
import { useMemo, useState } from "react";
import { cellOf, emptyPos } from "../../stats/positions";
import { MapCanvas, PlaceBars, type Mark } from "../MapCanvas";
import { Segmented } from "../Segmented";
import type { TabProps } from "./MatchPage";

type Mode = "heat" | "you" | "all";

export default function Positions({ v }: TabProps) {
  const [mode, setMode] = useState<Mode>(v.hasPos ? "heat" : "you");
  const allKills = useMemo(() => v.rounds.flatMap((r) => r.kills), [v]);
  // Without position samples, kill and death spots of every player outline the map instead.
  const pos = useMemo(() => {
    if (v.hasPos) return v.pos;
    const p = emptyPos(v.map);
    for (const k of allKills) for (const q of [k.kpos, k.vpos]) if (q) {
      const c = cellOf(q[0], q[1]);
      if (c >= 0) p.all[c] = (p.all[c] ?? 0) + 1;
    }
    return p;
  }, [v, allKills]);
  const marks: Mark[] = useMemo(() => {
    if (mode === "all") {
      return allKills.filter((k) => k.vpos && k.killer !== null).map((k) => ({ x: k.vpos![0], y: k.vpos![1], kind: v.players[k.victim].team === "us" ? ("us" as const) : ("them" as const) }));
    }
    if (mode === "you") {
      return [
        ...v.pos.kills.map(([x, y]) => ({ x, y, kind: "kill" as const })),
        ...v.pos.deaths.map(([x, y]) => ({ x, y, kind: "death" as const })),
      ];
    }
    return [];
  }, [mode, allKills, v]);

  const legend = mode === "heat" ? "Your time alive: blue = little, red = most. Grey = where any player went." :
    mode === "you" ? "Green dots: where you stood when you got a kill. Red crosses: where you died." :
      "Every death this match: blue = your team died here, grey = an opponent died here.";

  return (
    <div className="grid-map">
      <section className="glass card" aria-label="Map">
        <div className="card__head">
          <h2 className="card__title">Map</h2>
          <Segmented size="sm" label="Map layer" value={mode} onChange={setMode} options={[
            { value: "heat", label: "Heatmap", disabled: !v.hasPos, tip: v.hasPos ? undefined : "This match has no position samples" },
            { value: "you", label: "Your kills & deaths" },
            { value: "all", label: "All deaths" },
          ]} />
        </div>
        <MapCanvas pos={pos} marks={marks} showHeat={mode === "heat"} label={legend} />
        <p className="note" style={{ marginTop: 8 }}>{legend}</p>
      </section>
      <section className="glass card" aria-label="Time per place">
        <div className="card__head"><h2 className="card__title has-tip" tabIndex={0} data-tip="Share of your time alive spent in each map place (the game's place names), from position samples 4 times a second.">Time per place</h2></div>
        {v.hasPos ? <PlaceBars places={v.pos.places} /> : <p className="note">This match has no position samples. The capture plugin records them for new matches.</p>}
      </section>
    </div>
  );
}
