// Your kills and deaths by the map's zones (worker mapZones, merged per zone for the chosen side): deaths
// grow left from a centre line and kills right, on one scale for every row. A row picks its zone, and the
// radar beside it then draws that zone's kills and deaths over the rest (Positions ZoneMarks).
import { useState } from "react";
import { Card } from "../../components/Card";
import { placeName } from "../../data/match";
import { plural } from "../../lib/format";
import { Hint } from "./glyphs";
import { LoadFailed } from "./LoadFailed";
import type { Zone } from "./parity";

/** Rows shown before "Show all" (SYSTEM.md: ranked lists show eight). */
const TOP = 8;

export function ZonesCard({ zones, error, total, picked, onPick }: { zones: Zone[] | null; error: string | null; total: number; picked: string | null; onPick: (zone: string | null) => void }) {
  const [all, setAll] = useState(false);
  const title = <>Your zones <Hint tip="Your kills and deaths by the map's callouts. Pick one to see it on the radar." /></>;
  if (error) return <Card title={title}><LoadFailed what="Your zones" error={error} /></Card>;
  if (!zones) return <Card title={title}><div className="skel" style={{ height: 160 }} /></Card>;
  if (!zones.length) return <Card title={title}><p className="meta">None of your kills or deaths has a zone in this file.</p></Card>;
  const max = Math.max(1, ...zones.map((z) => Math.max(z.kills, z.deaths)));
  const shown = all ? zones : zones.slice(0, TOP);
  const sideText = (z: Zone) => (["T", "CT"] as const).flatMap((s) => (z.bySide[s] ? [`${s} ${z.bySide[s]!.kills}–${z.bySide[s]!.deaths}`] : [])).join(", ");
  return (
    <Card title={title} aside={<span className="meta">{zones.length} of {plural(total, "zone")}</span>}>
      <div className="zn__head caps" aria-hidden><span /><span className="zn__hd">Deaths</span><span className="zn__hk">Kills</span><span /></div>
      <ul className="zn">
        {shown.map((z) => {
          const on = picked === z.zone;
          const name = placeName(z.zone);
          return (
            <li key={z.zone}>
              <button
                className={`zn__row ${on ? "is-on" : ""}`}
                aria-pressed={on}
                onClick={() => onPick(on ? null : z.zone)}
                aria-label={`${name}: ${plural(z.kills, "kill")}, ${plural(z.deaths, "death")}${on ? ", shown on the radar" : ""}`}
                data-tip={`${name}: ${sideText(z)}`}
              >
                <span className="zn__l">{name}</span>
                <span className="zn__bars" aria-hidden>
                  <span className="zn__half zn__half--d"><i style={{ width: `${(100 * z.deaths) / max}%` }} /></span>
                  <span className="zn__half zn__half--k"><i style={{ width: `${(100 * z.kills) / max}%` }} /></span>
                </span>
                <span className="num zn__kd"><b>{z.kills}</b><span className="faint">–</span>{z.deaths}</span>
              </button>
            </li>
          );
        })}
      </ul>
      {zones.length > TOP && (
        <button className="btn btn--ghost btn--sm press zn__more" onClick={() => setAll((a) => !a)} aria-expanded={all}>
          {all ? "Show the top eight" : `Show all ${zones.length}`}
        </button>
      )}
    </Card>
  );
}
