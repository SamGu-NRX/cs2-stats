// Playstyle: identity rather than performance (design/research-playstyle-viz.md).
// - Role: the engine's role blend per side, with its evidence in words.
// - Where you play: your kills and deaths on the radar, for any map you have played.
// - Where you rank: one ranked list of percentiles against pro players, grouped by kind.
// - Rotations and first contact wait for analysis that has not been built; the page says so.
import { useMemo, useState } from "react";
import { compare } from "../../stats/compare";
import { METRIC } from "../../stats/metrics";
import type { Summary } from "../../stats/rollup";
import { Card } from "../components/Card";
import { Select } from "../components/controls";
import { frameFor, RadarView } from "../components/MapArt";
import { filterEntries, fmtMetric, mapsIn } from "../data/engine";
import { usePositions, useRollups } from "../data/hooks";
import { useData } from "../data/provider";
import { DeathIcon } from "../icons/game";
import { mapName, plural } from "../lib/format";
import { BarContent } from "../shell/Bar";
import { MapFilter, TimeFilter, useFilters } from "../shell/filters";
import { RoleCard, rankText } from "./profile/parts";
import { Empty } from "./shared";

export default function Playstyle() {
  const { matches, you } = useData();
  const { map, n } = useFilters();
  const list = useMemo(() => { const f = filterEntries(matches, map); return n ? f.slice(0, n) : f; }, [matches, map, n]);
  const files = useMemo(() => list.map((e) => e.file), [list]);
  const qs = useMemo(() => (list.length && you.length ? [
    { files, filter: { player: you } },
    { files, filter: { player: you, sides: ["T" as const] } },
    { files, filter: { player: you, sides: ["CT" as const] } },
  ] : null), [list, files, you]);
  const sums = useRollups(qs).data;
  const ready = sums?.length === 3 ? sums : null;

  return (
    <div className="view view--capped">
      <BarContent crumbs={[{ label: "Playstyle" }]} tools={<><MapFilter /><TimeFilter /></>} />
      <div className="view__in playstyle">
        {!list.length ? <Card><Empty text="No matches in this filter." /></Card> : !ready ? <div className="skel" style={{ height: 340 }} /> : (
          <>
            <div className="identity">
              <RoleCard t={ready[1]} ct={ready[2]} />
              <WhereYouPlay />
            </div>
            <Ranks you={ready[0]} />
            <p className="meta ps-next">Rotations between callouts and where you first meet the enemy arrive with the movement analysis and line-of-sight tracing.</p>
          </>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- where you play

export function WhereYouPlay() {
  const { matches, you } = useData();
  const maps = mapsIn(matches);
  const { map: filtered } = useFilters();
  const [map, setMap] = useState<string>(filtered ?? maps[0] ?? "de_dust2");
  const onMap = useMemo(() => matches.filter((s) => s.match.map === map), [matches, map]);
  const q = useMemo(() => (onMap.length && you.length ? { files: onMap.map((e) => e.file), filter: { player: you, maps: [map] } } : null), [onMap, you, map]);
  const pos = usePositions(q).data;
  const frame = useMemo(() => (pos ? frameFor(map, [...pos.kills, ...pos.deaths]) : null), [map, pos]);
  return (
    <Card title="Where you play" aside={<Select label="Map" prefix="Map" value={map} onChange={setMap} options={maps.map((m) => ({ value: m, label: mapName(m) }))} />}>
      {!pos ? <div className="skel" style={{ height: 360 }} /> : !frame ? <Empty text={`No kill or death positions on ${mapName(map)} yet.`} /> : (
        <div className="wyp">
          <div className="wyp__map">
            <RadarView map={map} frame={frame} label={`Where you killed and died on ${mapName(map)}`}>
              {pos.kills.map(([x0, y0], i) => { const [x, y] = frame.to(x0, y0); return <circle key={`k${i}`} cx={x} cy={y} r="7" fill="var(--good-text)" stroke="var(--bg0)" strokeWidth="2.5" opacity="0.9" />; })}
              {pos.deaths.map(([x0, y0], i) => { const [x, y] = frame.to(x0, y0); return <path key={`d${i}`} transform={`translate(${x} ${y})`} d="M-7 -7L7 7M7 -7L-7 7" stroke="var(--poor-text)" strokeWidth="3" strokeLinecap="round" />; })}
            </RadarView>
            <div className="legend">
              <span><svg width="10" height="10" aria-hidden><circle cx="5" cy="5" r="4" fill="var(--good-text)" /></svg>Your kills</span>
              <span><DeathIcon size={11} className="poor-text" />Your deaths</span>
            </div>
          </div>
          <div className="wyp__side">
            <div className="wyp__count"><b className="num">{onMap.length}</b><span className="meta">{plural(onMap.length, "match", "matches")} on {mapName(map)}</span></div>
            <div className="wyp__count"><b className="num good-text">{pos.kills.length}</b><span className="meta">kills placed</span><b className="num poor-text">{pos.deaths.length}</b><span className="meta">deaths placed</span></div>
            <p className="meta">Kills sit where you stood, deaths where you fell.</p>
          </div>
        </div>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------- percentiles

const RANKS: { tag: string; ids: string[] }[] = [
  { tag: "Aim and damage", ids: ["kpr", "adr", "perfectKpr"] },
  { tag: "Style", ids: ["openingAttempts", "openingSuccess", "tradeKillsPct", "rws"] },
  { tag: "Positioning", ids: ["timeAlive", "firstDuelTime", "clutches24"] },
  { tag: "Utility", ids: ["flashesPR", "assistsPerFlash", "dmgPerHe"] },
];

function Ranks({ you }: { you: Summary }) {
  const { baselines, baselinesError } = useData();
  const p = useMemo(() => (baselines ? compare(you, baselines, { pool: "all" }) : null), [you, baselines]);
  return (
    <Card title="Where you rank" aside={<span className="meta">{baselines ? `Against ${baselines.n.all?.both ?? 0} pro players` : ""}</span>}>
      {!p ? <p className="meta">{baselinesError ?? "Loading the pro baselines."}</p> : (
        <div className="ranks">
          {RANKS.map((g) => (
            <section key={g.tag} className="ranks__group">
              <h3 className="caps">{g.tag}</h3>
              <ul>
                {g.ids.map((id) => {
                  const m = METRIC[id];
                  const x = p[id];
                  const tone = x.pct === null || m.kind === "identity" ? "" : x.pct >= 67 ? "is-high" : x.pct < 33 ? "is-low" : "";
                  return (
                    <li key={id} className={tone} data-tip={m.def}>
                      <span className="ranks__l">{m.label}</span>
                      <b className="num ranks__v">{fmtMetric(id, x.value)}</b>
                      <span className="ranks__track"><i style={{ left: `${x.pct ?? 0}%` }} /><em style={{ left: "50%" }} /></span>
                      <span className="ranks__p num">{m.kind === "identity" ? (x.pct === null ? "–" : `Above ${Math.round(x.pct)}%`) : rankText(x.pct)}</span>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
          <p className="meta ranks__note">The dot shows where you sit among pro players, lowest on the left; the tick is the middle. Style numbers have no better or worse, so they say how many pros you are above.</p>
        </div>
      )}
    </Card>
  );
}
