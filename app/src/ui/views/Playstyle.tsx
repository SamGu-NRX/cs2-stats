// Playstyle: identity rather than performance (design/research-playstyle-viz.md).
// - Style compass: you and every bot career in your matches on two signals, how often you take the
//   opening duel and how much of your work is trades and assists, with the zones named in words.
// - Role: the engine's role blend per side.
// - Where you play: a radar of your movement, kills and deaths, for any map you have played, with the
//   places you spend your time.
// - Where you rank: one ranked list of percentiles, grouped by topic. Performance rows rank against pro
//   players; style (identity) rows against the bot careers in the same matches (worker/ranking.ts).
// - Rotations and first contact wait for analysis that has not been built; the page says so.
import { useMemo, useState } from "react";
import type { Measures } from "../../stats/facts";
import type { MatchEntry } from "../data/match";
import { CELL, cellCentre } from "../../stats/positions";
import { Card } from "../components/Card";
import { Select } from "../components/controls";
import { useWidth } from "../components/charts";
import { frameFor, RadarView } from "../components/MapArt";
import { botIds, careerEntries, fmtMetric, mapsIn, rankText, sidesOf, type SideKey } from "../data/engine";
import { useCall, useRollups } from "../data/hooks";
import { metric } from "../data/meta";
import { PANEL_TIP, PROVISIONAL_TIP, tipOf } from "../data/tips";
import { calloutName } from "../lib/callouts";
import { GameIcon } from "../components/GameIcon";
import { useGameIcon } from "../data/icons";
import { useData } from "../data/provider";
import { DeathIcon } from "../icons/game";
import { fmtPct, mapName, plural } from "../lib/format";
import { BarContent } from "../shell/Bar";
import { useScope } from "../shell/filters";
import type { Query } from "../../worker/protocol";
import { RoleCard } from "./profile/parts";
import { Empty, NeedsDemo, NotCompared } from "./shared";

export default function Playstyle() {
  const { matches, you } = useData();
  const { map, n } = useScope();
  const list = useMemo(() => { const f = careerEntries(matches, map); return n ? f.slice(0, n) : f; }, [matches, map, n]);
  const q = useMemo(() => (list.length && you.length ? { files: list.map((e) => e.file), filter: { player: you } } : null), [list, you]);
  return (
    <div className="view view--capped">
      <BarContent crumbs={[{ label: "Playstyle" }]} scope={{ controls: ["map", "matches"] }} />
      <div className="view__in playstyle">
        {!q ? <Card><Empty text="No matches in this filter." /></Card> : (
          <>
            <div className="ps-top">
              <StyleCompass list={list} q={q} />
              <RoleCard q={q} maps={mapsIn(list)} />
            </div>
            <WhereYouPlay list={list} side="both" />
            <Ranks q={q} />
            <p className="meta ps-next">Rotations between callouts and where you first meet the enemy arrive with the movement analysis and line-of-sight tracing.</p>
          </>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- style compass

/** A bot career needs this many rounds before it is placed (main's compass used the same cut). */
const COMPASS_MIN_ROUNDS = 20;
/** The zone lines: the share of rounds in the opening duel, and the share of kills and assists that are trades or assists. */
const ENTRY_X = 0.25;
const SUPPORT_Y = 0.45;

interface Dot { key: string; name: string; you: boolean; x: number; y: number; rounds: number }

/** The two signals from a rollup's measures, or null without the rounds or kills to read them. */
function signals(m: Measures): { x: number; y: number } | null {
  if (!m.rounds || m.kills + m.assists === 0) return null;
  return { x: (m.openingKills + m.openingDeaths) / m.rounds, y: (m.tradeKills + m.assists) / (m.kills + m.assists) };
}

const ZONES = [
  { id: "support", label: "Support", sub: "plays off teammates" },
  { id: "both", label: "Entry and support", sub: "opens and trades" },
  { id: "entry", label: "Entry", sub: "takes first duels" },
  { id: "rifler", label: "Rifler", sub: "neither signal" },
] as const;
const zoneOf = (d: { x: number; y: number }) => ZONES[d.y >= SUPPORT_Y ? (d.x >= ENTRY_X ? 1 : 0) : d.x >= ENTRY_X ? 2 : 3];

/**
 * You and every bot career from the same matches on two signals, each career summed over those
 * matches (one bot name is one career, as worker/ranking.ts counts them). Restored from main's
 * Playstyle, now read from the engine's rollups.
 */
function StyleCompass({ list, q }: { list: MatchEntry[]; q: Query }) {
  const bots = useMemo(() => botIds(list), [list]);
  const names = useMemo(() => new Map(list.flatMap((e) => e.players.filter((p) => p.bot).map((p) => [p.id, p.name] as const))), [list]);
  const qs = useMemo(() => [q, ...bots.map((id) => ({ files: q.files, filter: { player: [id] } }))], [q, bots]);
  const sums = useRollups(qs).data;
  const dots = useMemo((): Dot[] => {
    if (!sums) return [];
    return sums.flatMap((r, i) => {
      const sig = signals(r.m);
      if (!sig || (i > 0 && r.m.rounds < COMPASS_MIN_ROUNDS)) return [];
      return [{ key: i === 0 ? "you" : bots[i - 1], name: i === 0 ? "You" : names.get(bots[i - 1]) ?? "Bot", you: i === 0, rounds: r.m.rounds, ...sig }];
    });
  }, [sums, bots, names]);
  return (
    <Card title="Style compass" tip="You and the bots in your matches, by opening duels and trades." aside={<span className="meta">{sums ? `You and ${plural(dots.filter((d) => !d.you).length, "bot career")}` : ""}</span>}>
      {!sums ? <div className="skel" style={{ height: 340 }} /> : <Compass dots={dots} />}
    </Card>
  );
}

function Compass({ dots }: { dots: Dot[] }) {
  const [ref, w] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<Dot | null>(null);
  const h = 340;
  const pad = { l: 16, r: 16, t: 16, b: 40 };
  const xmax = Math.max(0.5, ...dots.map((d) => d.x)) * 1.08;
  const ymax = Math.max(0.9, ...dots.map((d) => d.y)) * 1.04;
  const X = (x: number) => pad.l + (x / xmax) * (w - pad.l - pad.r);
  const Y = (y: number) => h - pad.b - (y / ymax) * (h - pad.t - pad.b);
  const ex = X(ENTRY_X);
  const sy = Y(SUPPORT_Y);
  const me = dots.find((d) => d.you);
  const rects = [
    { x: pad.l, y: pad.t, w: ex - pad.l, h: sy - pad.t, fill: "rgba(43,163,224,.07)" },
    { x: ex, y: pad.t, w: w - pad.r - ex, h: sy - pad.t, fill: "rgba(172,149,122,.08)" },
    { x: ex, y: sy, w: w - pad.r - ex, h: h - pad.b - sy, fill: "rgba(219,136,28,.07)" },
    { x: pad.l, y: sy, w: ex - pad.l, h: h - pad.b - sy, fill: "transparent" },
  ];
  return (
    <div ref={ref} className="chart compass">
      <svg width={w} height={h} role="img" aria-label={`Style compass: you ${me ? `at ${Math.round(100 * me.x)}% opening duels and ${Math.round(100 * me.y)}% trades and assists, ${zoneOf(me).label}` : "not placed"}`}>
        {ZONES.map((z, i) => (
          <g key={z.id}>
            <rect x={rects[i].x} y={rects[i].y} width={Math.max(0, rects[i].w)} height={Math.max(0, rects[i].h)} fill={rects[i].fill} />
            <text x={rects[i].x + 10} y={rects[i].y + 20} className="compass__zone">{z.label}</text>
            <text x={rects[i].x + 10} y={rects[i].y + 34} className="ax">{z.sub}</text>
          </g>
        ))}
        <line x1={ex} x2={ex} y1={pad.t} y2={h - pad.b} stroke="var(--line2)" strokeDasharray="3 3" />
        <line x1={pad.l} x2={w - pad.r} y1={sy} y2={sy} stroke="var(--line2)" strokeDasharray="3 3" />
        <text x={ex + 4} y={h - pad.b - 6} className="ax">{Math.round(ENTRY_X * 100)}%</text>
        <text x={w - pad.r - 4} y={sy - 6} textAnchor="end" className="ax">{Math.round(SUPPORT_Y * 100)}%</text>
        <text x={pad.l} y={h - 14} className="ax ax--label">Takes the first duel of the round more often →</text>
        <text x={w - pad.r} y={h - 14} textAnchor="end" className="ax">↑ more trades and assists</text>
        {dots.filter((d) => !d.you).map((d) => (
          <circle key={d.key} cx={X(d.x)} cy={Y(d.y)} r="4.5" fill="var(--ink3)" opacity={hover?.key === d.key ? 1 : 0.55} onPointerEnter={() => setHover(d)} onPointerLeave={() => setHover(null)} />
        ))}
        {me && (
          <g transform={`translate(${X(me.x)} ${Y(me.y)})`}>
            <circle r="16" fill="rgba(255,215,173,.14)" />
            <circle r="7" fill="var(--cream)" />
            <text x="14" y="-12" className="compass__you">You, {zoneOf(me).label}</text>
          </g>
        )}
        {hover && (
          <g transform={`translate(${Math.min(w - 180, X(hover.x) + 12)} ${Math.max(pad.t, Y(hover.y) - 46)})`} pointerEvents="none">
            <rect width="170" height="40" rx="6" fill="var(--bg0)" stroke="var(--line2)" />
            <text x="10" y="16" className="ax ax--strong" style={{ fill: "var(--ink)" }}>{hover.name}</text>
            <text x="10" y="31" className="ax">{zoneOf(hover).label}, {hover.rounds} rounds</text>
          </g>
        )}
      </svg>
    </div>
  );
}

// ---------------------------------------------------------------- where you play

/**
 * Where you moved, killed and died, over the page's career matches (`list`, already narrowed by the
 * title bar's Map and Matches) on the page's side. The title bar's map wins; without one, the card's
 * own map menu picks among the maps in `list`.
 */
export function WhereYouPlay({ list, side }: { list: MatchEntry[]; side: SideKey }) {
  const { you } = useData();
  const maps = useMemo(() => mapsIn(list), [list]);
  const { map: scoped } = useScope();
  const [pick, setPick] = useState<string | null>(null);
  const map = scoped ?? (pick && maps.includes(pick) ? pick : maps[0] ?? "de_dust2");
  const onMap = useMemo(() => list.filter((s) => s.match.map === map), [list, map]);
  const q = useMemo(() => (onMap.length && you.length ? { files: onMap.map((e) => e.file), filter: { player: you, maps: [map], ...sidesOf(side) } } : null), [onMap, you, map, side]);
  const pos = useCall("positions", q ? [q] : null).data;
  const cells = useMemo(() => Object.entries(pos?.presence?.cells ?? {}).map(([c, secs]) => ({ c: +c, secs, at: cellCentre(+c) })), [pos]);
  const frame = useMemo(() => (pos ? frameFor(map, [...pos.kills, ...pos.deaths, ...cells.map((c) => c.at)]) : null), [map, pos, cells]);
  const recorded = onMap.filter((s) => s.hasPos).length;
  const maxCell = Math.max(1, ...cells.map((c) => c.secs));
  const places = Object.entries(pos?.presence?.places ?? {}).sort((a, b) => b[1] - a[1]).slice(0, 8);
  const total = Object.values(pos?.presence?.places ?? {}).reduce((a, s) => a + s, 0) || 1;
  // deaths are marked with the game's skull from the icon pack, tinted; without the pack, a cross
  const skull = useGameIcon("elimination");
  return (
    <Card title="Where you play" tip={PANEL_TIP.whereYouPlay} aside={scoped ? <span className="meta">{mapName(map)}</span> : <Select label="Map" prefix="Map" value={map} onChange={setPick} options={maps.map((m) => ({ value: m, label: mapName(m) }))} />}>
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
              {skull && (
                <defs>
                  <filter id="wyp-skull" colorInterpolationFilters="sRGB">
                    <feFlood style={{ floodColor: "var(--poor-text)" }} />
                    <feComposite in2="SourceAlpha" operator="in" />
                  </filter>
                </defs>
              )}
              {pos.deaths.map(([x0, y0], i) => {
                const [x, y] = frame.to(x0, y0);
                return skull
                  ? <image key={`d${i}`} href={skull} x={x - 9} y={y - 9} width="18" height="18" filter="url(#wyp-skull)" />
                  : <path key={`d${i}`} transform={`translate(${x} ${y})`} d="M-7 -7L7 7M7 -7L-7 7" stroke="var(--poor-text)" strokeWidth="3" strokeLinecap="round" />;
              })}
            </RadarView>
            <div className="legend">
              <span><svg width="10" height="10" aria-hidden><circle cx="5" cy="5" r="4" fill="var(--good-text)" /></svg>Your kills</span>
              <span><span className="poor-text"><GameIcon id="elimination" width={11} fallback={<DeathIcon size={11} />} /></span>Your deaths</span>
              <span><i className="swatch" style={{ background: "rgba(255,215,173,.4)" }} />Where you moved</span>
            </div>
          </div>
          <div className="wyp__side">
            <div className="wyp__count"><b className="num">{onMap.length}</b><span className="meta">{plural(onMap.length, "match", "matches")} on {mapName(map)}, {recorded} with movement</span></div>
            <div className="wyp__count"><b className="num good-text">{pos.kills.length}</b><span className="meta">kills placed</span><b className="num poor-text">{pos.deaths.length}</b><span className="meta">deaths placed</span></div>
            {places.length ? (
              <ul className="places" aria-label="Where you spend your time alive">
                {places.map(([p, secs]) => <li key={p}><span>{calloutName(p)}</span><span className="hbar"><i style={{ width: `${(100 * secs) / places[0][1]}%` }} /></span><b className="num">{fmtPct((100 * secs) / total, 0)}</b></li>)}
              </ul>
            ) : <p className="meta"><NeedsDemo detail="Time spent per place needs movement, which converted logs lack." /></p>}
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

function Ranks({ q }: { q: Query }) {
  const { baselines, baselinesError } = useData();
  const pros = useCall("compare", baselines ? [q, { pool: "all" }] : null);
  const bots = useCall("style", [q, { pool: "all" }]);
  const proP = pros.data?.p ?? null;
  const botP = bots.data?.p ?? null;
  const careers = bots.data?.careers ?? null;
  const error = pros.error ?? bots.error ?? (baselines ? null : baselinesError);
  const n = { pros: baselines?.n.all?.both ?? 0, bots: bots.data?.n ?? 0 };
  return (
    <Card title="Where you rank" tip={PANEL_TIP.whereYouRank} aside={
      <span className="card__aside-row">
        <span className="meta">{proP && botP ? `How well against ${n.pros} pros; style against ${n.bots} bot ${n.bots === 1 ? "career" : "careers"}` : ""}</span>
      </span>
    }>
      {!proP || !botP ? (error ? <p className="meta">{error}</p> : <div className="skel" style={{ height: 240 }} />) : (
        <div className="ranks">
          {RANKS.map((g) => (
            <section key={g.tag} className="ranks__group">
              <h3 className="caps">{g.tag}</h3>
              <ul>
                {g.ids.map((id) => {
                  const m = metric(id);
                  const style = m.kind === "identity";
                  const x = (style ? botP : proP)[id];
                  const tone = x.pct === null || style ? "" : x.pct >= 67 ? "is-high" : x.pct < 33 ? "is-low" : "";
                  return (
                    <li key={id} className={tone} data-tip={tipOf(id)}>
                      <span className="ranks__l">{m.label}<span className="ranks__pop" data-tip={style ? "Ranked against bots in your matches." : "Ranked against pros."}>{style ? "vs bots" : "vs pros"}</span></span>
                      <b className="num ranks__v">{fmtMetric(id, x.value)}</b>
                      <span className={`ranks__track ${style ? "is-style" : ""} ${style && careers?.provisional ? "is-prov" : ""}`} {...(style && careers?.provisional ? { "data-tip": PROVISIONAL_TIP, tabIndex: 0, "aria-label": "Provisional" } : {})}>{x.pct !== null && <i style={{ left: `${x.pct}%` }} />}<em style={{ left: "50%" }} /></span>
                      <span className="ranks__p num">{x.reason ? <NotCompared reason={x.reason} /> : style ? (x.pct === null ? "–" : `Above ${Math.round(x.pct)}% of bots`) : rankText(x.pct)}</span>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
          <p className="meta ranks__note">The dot shows where you sit, lowest on the left; the tick is the middle. Rows marked vs pros measure how well you play and rank against pro players. Rows marked vs bots describe your style and rank against the bots in your own matches, each bot name one career; style has no better or worse, so they say how many bot careers you are above.</p>
        </div>
      )}
    </Card>
  );
}
