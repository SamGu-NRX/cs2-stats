// Playstyle: identity rather than performance (design/research-playstyle-viz.md).
// - Role: the engine's role blend per side, with its evidence in words.
// - Where you play: a radar of your movement, kills and deaths, for any map you have played, with the
//   places you spend your time.
// - Where you rank: one ranked list of percentiles against pro players, grouped by kind.
// - Rotations and first contact wait for analysis that has not been built; the page says so.
import { useMemo, useState } from "react";
import { CELL, cellCentre } from "../../stats/positions";
import { Card } from "../components/Card";
import { Select } from "../components/controls";
import { frameFor, RadarView } from "../components/MapArt";
import { filterEntries, fmtMetric, mapsIn, rankText } from "../data/engine";
import { useCall } from "../data/hooks";
import { metric } from "../data/meta";
import { useData } from "../data/provider";
import { DeathIcon } from "../icons/game";
import { fmtPct, mapName, plural } from "../lib/format";
import { BarContent } from "../shell/Bar";
import { MapFilter, TimeFilter, useFilters } from "../shell/filters";
import { RoleCard } from "./profile/parts";
import { Empty } from "./shared";

export default function Playstyle() {
  const { matches, you } = useData();
  const { map, n } = useFilters();
  const list = useMemo(() => { const f = filterEntries(matches, map); return n ? f.slice(0, n) : f; }, [matches, map, n]);
  const q = useMemo(() => (list.length && you.length ? { files: list.map((e) => e.file), filter: { player: you } } : null), [list, you]);
  return (
    <div className="view view--capped">
      <BarContent crumbs={[{ label: "Playstyle" }]} tools={<><MapFilter /><TimeFilter /></>} />
      <div className="view__in playstyle">
        {!q ? <Card><Empty text="No matches in this filter." /></Card> : (
          <>
            <div className="identity">
              <RoleCard q={q} />
              <WhereYouPlay />
            </div>
            <Ranks q={q} />
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
  const pos = useCall("positions", q ? [q] : null).data;
  const cells = useMemo(() => Object.entries(pos?.presence?.cells ?? {}).map(([c, secs]) => ({ c: +c, secs, at: cellCentre(+c) })), [pos]);
  const frame = useMemo(() => (pos ? frameFor(map, [...pos.kills, ...pos.deaths, ...cells.map((c) => c.at)]) : null), [map, pos, cells]);
  const recorded = onMap.filter((s) => s.hasPos).length;
  const maxCell = Math.max(1, ...cells.map((c) => c.secs));
  const places = Object.entries(pos?.presence?.places ?? {}).sort((a, b) => b[1] - a[1]).slice(0, 8);
  const total = Object.values(pos?.presence?.places ?? {}).reduce((a, s) => a + s, 0) || 1;
  return (
    <Card title="Where you play" aside={<Select label="Map" prefix="Map" value={map} onChange={setMap} options={maps.map((m) => ({ value: m, label: mapName(m) }))} />}>
      {!pos ? <div className="skel" style={{ height: 360 }} /> : !frame ? <Empty text={`No kill, death or movement positions on ${mapName(map)} yet.`} /> : (
        <div className="wyp">
          <div className="wyp__map">
            <RadarView map={map} frame={frame} label={`Where you moved, killed and died on ${mapName(map)}`}>
              {cells.map(({ c, secs, at }) => {
                const [x, y] = frame.to(...at);
                const s = frame.to(CELL, 0)[0] - frame.to(0, 0)[0];
                return <rect key={c} x={x - s / 2} y={y - s / 2} width={s} height={s} fill="var(--cream)" opacity={0.04 + 0.3 * Math.sqrt(secs / maxCell)} />;
              })}
              {pos.kills.map(([x0, y0], i) => { const [x, y] = frame.to(x0, y0); return <circle key={`k${i}`} cx={x} cy={y} r="7" fill="var(--good-text)" stroke="var(--bg0)" strokeWidth="2.5" opacity="0.9" />; })}
              {pos.deaths.map(([x0, y0], i) => { const [x, y] = frame.to(x0, y0); return <path key={`d${i}`} transform={`translate(${x} ${y})`} d="M-7 -7L7 7M7 -7L-7 7" stroke="var(--poor-text)" strokeWidth="3" strokeLinecap="round" />; })}
            </RadarView>
            <div className="legend">
              <span><svg width="10" height="10" aria-hidden><circle cx="5" cy="5" r="4" fill="var(--good-text)" /></svg>Your kills</span>
              <span><DeathIcon size={11} className="poor-text" />Your deaths</span>
              <span><i className="swatch" style={{ background: "rgba(255,215,173,.4)" }} />Where you moved</span>
            </div>
          </div>
          <div className="wyp__side">
            <div className="wyp__count"><b className="num">{onMap.length}</b><span className="meta">{plural(onMap.length, "match", "matches")} on {mapName(map)}, {recorded} with movement</span></div>
            <div className="wyp__count"><b className="num good-text">{pos.kills.length}</b><span className="meta">kills placed</span><b className="num poor-text">{pos.deaths.length}</b><span className="meta">deaths placed</span></div>
            {places.length ? (
              <ul className="places" aria-label="Where you spend your time alive">
                {places.map(([p, secs]) => <li key={p}><span>{p}</span><span className="hbar"><i style={{ width: `${(100 * secs) / places[0][1]}%` }} /></span><b className="num">{fmtPct((100 * secs) / total, 0)}</b></li>)}
              </ul>
            ) : <p className="meta">Movement comes from recorded matches; converted logs place kills and deaths only.</p>}
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

function Ranks({ q }: { q: { files: string[]; filter: { player: string[] } } }) {
  const { baselines, baselinesError } = useData();
  const r = useCall("compare", [q, { pool: "all" }]);
  const p = r.data?.p ?? null;
  return (
    <Card title="Where you rank" aside={<span className="meta">{baselines ? `Against ${baselines.n.all?.both ?? 0} pro players` : ""}</span>}>
      {!p ? <p className="meta">{r.error ?? baselinesError ?? "Loading the pro baselines."}</p> : (
        <div className="ranks">
          {RANKS.map((g) => (
            <section key={g.tag} className="ranks__group">
              <h3 className="caps">{g.tag}</h3>
              <ul>
                {g.ids.map((id) => {
                  const m = metric(id);
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
