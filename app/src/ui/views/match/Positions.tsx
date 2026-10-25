// Positions: where kills and deaths happened on the radar, yours or everyone's, by side, with an
// optional line from killer to victim; plus where you spent the round (recorded matches).
import { useMemo, useState } from "react";
import { CELL, GRID, HALF_EXTENT } from "../../../stats/positions";
import { Card } from "../../components/Card";
import { Segmented } from "../../components/controls";
import { frameFor, RadarView } from "../../components/MapArt";
import { playerSide } from "../../data/engine";
import { useMapPositions } from "../../data/hooks";
import { DeathIcon, SkullIcon } from "../../icons/game";
import { fmtSecs, plural } from "../../lib/format";
import { SectionAside, Empty } from "../shared";
import type { TabProps } from "./MatchView";

type Who = "you" | "team" | "all";

export default function Positions({ v }: TabProps) {
  const pos = useMapPositions(v.map).data;
  const [who, setWho] = useState<Who>("you");
  const [side, setSide] = useState<"both" | "t" | "ct">("both");
  const [lines, setLines] = useState(true);
  const [heat, setHeat] = useState(true);

  const events = useMemo(() => {
    const out: { kx: number; ky: number; vx: number; vy: number; killer: number | null; victim: number; ri: number; hs: boolean; side: "t" | "ct" }[] = [];
    for (const r of v.rounds) for (const k of r.kills) {
      if (!k.kpos || !k.vpos || k.teamKill || k.suicide) continue;
      const s = k.killer !== null ? playerSide(v, r, k.killer) : playerSide(v, r, k.victim);
      out.push({ kx: k.kpos[0], ky: k.kpos[1], vx: k.vpos[0], vy: k.vpos[1], killer: k.killer, victim: k.victim, ri: r.ri, hs: (k.flags & 1) !== 0, side: s === 2 ? "t" : "ct" });
    }
    return out;
  }, [v]);
  const frame = useMemo(() => frameFor(v.map, pos, events.flatMap((e) => [[e.kx, e.ky], [e.vx, e.vy]] as [number, number][])), [v.map, pos, events]);
  if (!events.length || !frame) {
    return <div className="tabpad"><div className="card"><Empty icon={<SkullIcon size={36} />} text="This match has no kill positions." /></div></div>;
  }
  const human = v.human;
  const team = (pi: number | null) => (pi === null ? null : v.players[pi].team);
  const kills = events.filter((e) => (side === "both" || (e.killer === human ? e.side === side : true)) && (who === "you" ? e.killer === human : who === "team" ? team(e.killer) === "us" : true));
  const deaths = events.filter((e) => (who === "you" ? e.victim === human : who === "team" ? team(e.victim) === "us" : false) && (side === "both" || (() => { const r = v.rounds[e.ri]; return (playerSide(v, r, e.victim) === 2 ? "t" : "ct") === side; })()));
  const killsSided = side === "both" ? kills : kills.filter((e) => e.side === side);
  const cells = v.pos.human;
  const maxCell = Math.max(1, ...Object.values(cells));
  const places = Object.entries(v.pos.places).sort((a, b) => b[1] - a[1]).slice(0, 10);
  const placeMax = places[0]?.[1] ?? 1;
  const cellPx = frame.to(CELL, 0)[0] - frame.to(0, 0)[0];

  return (
    <div className="tabpad positions">
      <div className="toolbar">
        <Segmented label="Whose" value={who} onChange={setWho} options={[{ value: "you", label: "You" }, { value: "team", label: "Your team" }, { value: "all", label: "All kills" }]} />
        <Segmented label="Side" value={side} onChange={setSide} options={[{ value: "both", label: "Both sides" }, { value: "t", label: "T", side: "t" }, { value: "ct", label: "CT", side: "ct" }]} />
        <label className="check"><input type="checkbox" checked={lines} onChange={(e) => setLines(e.target.checked)} /><span>Killer to victim</span></label>
        {v.hasPos && <label className="check"><input type="checkbox" checked={heat} onChange={(e) => setHeat(e.target.checked)} /><span>Where you moved</span></label>}
        <div className="toolbar__end">
          <SectionAside label="Kills" value={killsSided.length} color="var(--cream)" />
          {who !== "all" && <SectionAside label="Deaths" value={deaths.length} color="var(--poor-text)" />}
        </div>
      </div>
      <div className="positions__grid">
        <div className="positions__map card">
          <RadarView map={v.map} frame={frame} label={`${killsSided.length} kills and ${deaths.length} deaths on the radar`}>
            {heat && v.hasPos && who === "you" && Object.entries(cells).map(([c, n]) => {
              const cx = (+c % GRID) * CELL - HALF_EXTENT + CELL / 2;
              const cy = Math.floor(+c / GRID) * CELL - HALF_EXTENT + CELL / 2;
              const [x, y] = frame.to(cx, cy);
              return <rect key={c} x={x - cellPx / 2} y={y - cellPx / 2} width={cellPx} height={cellPx} fill="var(--cream)" opacity={0.04 + 0.26 * Math.sqrt(n / maxCell)} />;
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
                  <title>{`Round ${e.ri + 1}: ${e.killer === null ? "World" : v.players[e.killer].name} killed ${v.players[e.victim].name}${e.hs ? " (headshot)" : ""}`}</title>
                  <circle r="9" fill={e.side === "t" ? "var(--t)" : "var(--ct)"} stroke="var(--bg0)" strokeWidth="3" />
                  {e.hs && <circle r="3" fill="var(--bg0)" />}
                </g>
              );
            })}
            {deaths.map((e, i) => {
              const [x, y] = frame.to(e.vx, e.vy);
              return (
                <g key={`d${i}`} transform={`translate(${x} ${y})`} className="radar-death">
                  <title>{`Round ${e.ri + 1}: ${v.players[e.victim].name} died to ${e.killer === null ? "the world" : v.players[e.killer].name}`}</title>
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
            <span>Kills sit where the killer stood</span>
          </div>
        </div>
        <div className="positions__side">
          <Card title="Where you spent the round" aside={v.hasPos ? <span className="meta">Seconds alive</span> : undefined}>
            {places.length ? (
              <ul className="places">
                {places.map(([p, secs]) => (
                  <li key={p}><span>{p}</span><span className="hbar"><i style={{ width: `${(secs / placeMax) * 100}%` }} /></span><b className="num">{fmtSecs(secs, 0)}</b></li>
                ))}
              </ul>
            ) : <p className="meta">Movement is recorded by the capture plugin; this match has kill positions only.</p>}
          </Card>
          <Card title="Your duels" aside={<span className="meta">{plural(events.filter((e) => e.killer === human || e.victim === human).length, "duel")}</span>}>
            <ul className="duel-list">
              {events.filter((e) => e.killer === human || e.victim === human).slice(0, 14).map((e, i) => (
                <li key={i}>
                  <span className="num faint">R{e.ri + 1}</span>
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
