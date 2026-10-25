// Positions: where kills and deaths happened on the radar, yours or everyone's, by side, with an
// optional line from killer to victim; where you moved (seconds alive per grid cell); and your top
// places by name (recorded matches).
import { useMemo, useState } from "react";
import { CELL, cellCentre } from "../../../stats/positions";
import { Card } from "../../components/Card";
import { Segmented } from "../../components/controls";
import { frameFor, RadarView } from "../../components/MapArt";
import { sideOf } from "../../data/match";
import { DeathIcon, SkullIcon } from "../../icons/game";
import { plural } from "../../lib/format";
import { Empty, NeedsDemo, PlaceList, SectionAside } from "../shared";
import type { TabProps } from "./MatchView";

type Who = "you" | "team" | "all";

export default function Positions({ v }: TabProps) {
  const [who, setWho] = useState<Who>("you");
  const [side, setSide] = useState<"both" | "t" | "ct">("both");
  const [lines, setLines] = useState(true);
  const [heat, setHeat] = useState(true);

  const events = useMemo(() => {
    const out: { kx: number; ky: number; vx: number; vy: number; killer: number | null; victim: number; ri: number; n: number; hs: boolean; side: "t" | "ct" }[] = [];
    for (const r of v.rounds) for (const k of r.kills) {
      if (!k.kpos || !k.vpos || !k.enemy) continue;
      const s = k.killerSide ?? sideOf(v, r, k.killer ?? k.victim);
      out.push({ kx: k.kpos[0], ky: k.kpos[1], vx: k.vpos[0], vy: k.vpos[1], killer: k.killer, victim: k.victim, ri: r.ri, n: r.number, hs: k.headshot, side: s === "T" ? "t" : "ct" });
    }
    return out;
  }, [v]);
  const cells = useMemo(() => Object.entries(v.b.presence?.cells ?? {}).map(([c, secs]) => ({ c: +c, secs, at: cellCentre(+c) })), [v]);
  const frame = useMemo(() => frameFor(v.map, [...events.flatMap((e) => [[e.kx, e.ky], [e.vx, e.vy]] as [number, number][]), ...cells.map((c) => c.at)]), [v.map, events, cells]);
  if (!events.length || !frame) {
    return <div className="tabpad"><div className="card"><Empty icon={<SkullIcon size={36} />} text={<NeedsDemo detail="This match has no kill positions." />} /></div></div>;
  }
  const human = v.human;
  const team = (pi: number | null) => (pi === null ? null : v.players[pi].team);
  const kills = events.filter((e) => (side === "both" || (e.killer === human ? e.side === side : true)) && (who === "you" ? e.killer === human : who === "team" ? team(e.killer) === "us" : true));
  const deaths = events.filter((e) => (who === "you" ? e.victim === human : who === "team" ? team(e.victim) === "us" : false) && (side === "both" || (sideOf(v, v.rounds[e.ri], e.victim) === "T" ? "t" : "ct") === side));
  const killsSided = side === "both" ? kills : kills.filter((e) => e.side === side);
  const maxCell = Math.max(1, ...cells.map((c) => c.secs));
  const cellPx = frame.to(CELL, 0)[0] - frame.to(0, 0)[0];

  return (
    <div className="tabpad positions">
      <div className="toolbar">
        <Segmented label="Whose" value={who} onChange={setWho} options={[{ value: "you", label: "You" }, { value: "team", label: "Your team" }, { value: "all", label: "All kills" }]} />
        <Segmented label="Side" value={side} onChange={setSide} options={[{ value: "both", label: "Both sides" }, { value: "t", label: "T", side: "t" }, { value: "ct", label: "CT", side: "ct" }]} />
        <label className="check"><input type="checkbox" checked={lines} onChange={(e) => setLines(e.target.checked)} /><span>Killer to victim</span></label>
        {cells.length > 0 && <label className="check"><input type="checkbox" checked={heat} onChange={(e) => setHeat(e.target.checked)} /><span>Where you moved</span></label>}
        <div className="toolbar__end">
          <SectionAside label="Kills" value={killsSided.length} color="var(--cream)" />
          {who !== "all" && <SectionAside label="Deaths" value={deaths.length} color="var(--poor-text)" />}
        </div>
      </div>
      <div className="positions__grid">
        <div className="positions__map card">
          <RadarView map={v.map} frame={frame} label={`${killsSided.length} kills and ${deaths.length} deaths on the radar`}>
            {heat && who === "you" && cells.map(({ c, secs, at }) => {
              const [x, y] = frame.to(...at);
              return <rect key={c} x={x - cellPx / 2} y={y - cellPx / 2} width={cellPx} height={cellPx} fill="var(--cream)" opacity={0.04 + 0.26 * Math.sqrt(secs / maxCell)} />;
            })}
            {lines && killsSided.map((e, i) => {
              const [x1, y1] = frame.to(e.kx, e.ky);
              const [x2, y2] = frame.to(e.vx, e.vy);
              return <line key={`l${i}`} x1={x1} y1={y1} x2={x2} y2={y2} stroke={e.side === "t" ? "var(--t)" : "var(--ct)"} strokeOpacity="0.45" strokeWidth="2" />;
            })}
            {killsSided.map((e, i) => {
              const [x, y] = frame.to(e.kx, e.ky);
              return (
                <g key={`k${i}`} transform={`translate(${x} ${y})`}>
                  <title>{`Round ${e.n}: ${e.killer === null ? "World" : v.players[e.killer].name} killed ${v.players[e.victim].name}${e.hs ? " (headshot)" : ""}`}</title>
                  <circle r="9" fill={e.side === "t" ? "var(--t)" : "var(--ct)"} stroke="var(--bg0)" strokeWidth="3" />
                  {e.hs && <circle r="3" fill="var(--bg0)" />}
                </g>
              );
            })}
            {deaths.map((e, i) => {
              const [x, y] = frame.to(e.vx, e.vy);
              return (
                <g key={`d${i}`} transform={`translate(${x} ${y})`} className="radar-death">
                  <title>{`Round ${e.n}: ${v.players[e.victim].name} died to ${e.killer === null ? "the world" : v.players[e.killer].name}`}</title>
                  <path d="M-9 -9L9 9M9 -9L-9 9" stroke="var(--bg0)" strokeWidth="7" strokeLinecap="round" />
                  <path d="M-9 -9L9 9M9 -9L-9 9" stroke="var(--poor-text)" strokeWidth="3.5" strokeLinecap="round" />
                </g>
              );
            })}
          </RadarView>
          <div className="legend positions__legend">
            <span><svg width="12" height="12" aria-hidden><circle cx="6" cy="6" r="5" fill="var(--t)" /></svg>Kill on T</span>
            <span><svg width="12" height="12" aria-hidden><circle cx="6" cy="6" r="5" fill="var(--ct)" /></svg>Kill on CT</span>
            <span><svg width="12" height="12" aria-hidden><circle cx="6" cy="6" r="5" fill="var(--ink2)" /><circle cx="6" cy="6" r="1.8" fill="var(--bg0)" /></svg>Headshot</span>
            <span><DeathIcon size={12} className="poor-text" />Death</span>
            {cells.length > 0 && <span><i className="swatch" style={{ background: "rgba(255,215,173,.4)" }} />Where you moved</span>}
            <span>Kills sit where the killer stood</span>
          </div>
        </div>
        <div className="positions__side">
          <PlacesCard v={v} />
          <Card title="Your duels" aside={<span className="meta">{plural(events.filter((e) => e.killer === human || e.victim === human).length, "duel")}</span>}>
            <ul className="duel-list">
              {events.filter((e) => e.killer === human || e.victim === human).slice(0, 14).map((e, i) => (
                <li key={i}>
                  <span className="num faint">R{e.n}</span>
                  {e.killer === human ? <SkullIcon hs={e.hs} size={11} className={e.hs ? "skull skull--hs" : "skull"} /> : <DeathIcon size={11} className="poor-text" />}
                  <span>{e.killer === human ? v.players[e.victim].name : e.killer === null ? "World" : v.players[e.killer].name}</span>
                  <span className={e.side === "t" ? "t-text" : "ct-text"}>{e.side.toUpperCase()}</span>
                </li>
              ))}
            </ul>
          </Card>
        </div>
      </div>
    </div>
  );
}

/** Your top places over the match: seconds alive per place name (your presence, rolled up). */
function PlacesCard({ v }: { v: TabProps["v"] }) {
  const places = v.b.presence?.places ?? {};
  return (
    <Card title="Top places" aside={Object.keys(places).length ? <span className="meta">Seconds alive</span> : undefined}>
      {Object.keys(places).length ? (
        <>
          <PlaceList places={places} />
          <p className="meta" style={{ marginTop: 10 }}>Where you spent each round is in the round panel on the Rounds tab.</p>
        </>
      ) : <p className="meta"><NeedsDemo detail="This match has kill positions but no movement samples." /></p>}
    </Card>
  );
}
