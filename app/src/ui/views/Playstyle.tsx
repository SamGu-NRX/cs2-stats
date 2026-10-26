// Panels of Profile's Playstyle tab: identity rather than performance (design/research-playstyle-viz.md).
// - Style compass: you and every bot career in your matches on two signals, how often you take the
//   opening duel and how much of your work is trades and assists, with the zones named in words.
// - Where you play: a radar of your movement, kills and deaths, for any map you have played, with the
//   places you spend your time.
// - Ranks by topic: one ranked list of percentiles, grouped by topic. Performance rows rank against pro
//   players; style (identity) rows against the bot careers in the same matches (worker/ranking.ts).
import { useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { SideKey as PoolSide } from "../../stats/compare";
import type { Measures } from "../../stats/facts";
import type { MatchEntry } from "../data/match";
import { CELL, cellCentre } from "../../stats/positions";
import { Card } from "../components/Card";
import { MetricList, MetricRow, ShareTrack } from "../components/MetricRow";
import { Num } from "../components/bits";
import { Select } from "../components/controls";
import { useWidth } from "../components/charts";
import { frameFor, RadarView } from "../components/MapArt";
import { botIds, botPopulation, fmtMetric, mapsIn, sidesOf, type SideKey } from "../data/engine";
import { useCall, useRollups } from "../data/hooks";
import { metric } from "../data/meta";
import { PANEL_TIP, PROVISIONAL_TIP, tipOf } from "../data/tips";
import { calloutName } from "../lib/callouts";
import { useData } from "../data/provider";
import { fmtPct, mapName, plural } from "../lib/format";
import { useScope } from "../shell/filters";
import type { Query } from "../../worker/protocol";
import { Empty, NeedsDemo } from "./shared";


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
export function StyleCompass({ list, q }: { list: MatchEntry[]; q: Query }) {
  const bots = useMemo(() => botIds(list), [list]);
  const names = useMemo(() => new Map(list.flatMap((e) => e.players.filter((p) => p.bot).map((p) => [p.id, p.name] as const))), [list]);
  // the bots on the same side as you (q's side filter)
  const qs = useMemo(() => [q, ...bots.map((id) => ({ files: q.files, filter: { ...q.filter, player: [id] } }))], [q, bots]);
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
    <Card title="Style compass" tip="You and the bots in your matches, by opening duels and trades." aside={<span className="meta" tabIndex={0} data-tip={`Bot careers with ${COMPASS_MIN_ROUNDS} or more rounds in your matches.`}>{sums ? `You and ${plural(dots.filter((d) => !d.you).length, "bot career")} (${COMPASS_MIN_ROUNDS}+ rounds)` : ""}</span>}>
      {!sums ? <div className="skel" style={{ height: 340 }} /> : <Compass dots={dots} />}
    </Card>
  );
}

/** A bot's hover card text, also its name for assistive tech. */
const dotText = (d: Dot) => `${d.name}: ${zoneOf(d).label}, ${d.rounds} rounds. Opening duels in ${Math.round(100 * d.x)}% of rounds, ${Math.round(100 * d.y)}% trades and assists.`;

/**
 * The bots are one tab stop: Tab lands on the focused bot, the arrow keys (and Home and End) move
 * between bots left to right, and the focused bot shows the same card a pointer hover does.
 */
function Compass({ dots }: { dots: Dot[] }) {
  const [ref, w] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<Dot | null>(null);
  const bots = useMemo(() => dots.filter((d) => !d.you).sort((a, b) => a.x - b.x || a.y - b.y), [dots]);
  const [cursor, setCursor] = useState(0);
  const at = Math.min(cursor, Math.max(0, bots.length - 1));
  const dotRefs = useRef<(SVGGElement | null)[]>([]);
  const move = (e: KeyboardEvent<SVGGElement>) => {
    const n = bots.length;
    const next = e.key === "ArrowRight" || e.key === "ArrowDown" ? (at + 1) % n
      : e.key === "ArrowLeft" || e.key === "ArrowUp" ? (at - 1 + n) % n
      : e.key === "Home" ? 0 : e.key === "End" ? n - 1 : null;
    if (next === null || !n) return;
    e.preventDefault();
    setCursor(next);
    dotRefs.current[next]?.focus();
  };
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
      <svg width={w} height={h} role="group" aria-label={`Style compass: you ${me ? `at ${Math.round(100 * me.x)}% opening duels and ${Math.round(100 * me.y)}% trades and assists, ${zoneOf(me).label}` : "not placed"}; ${plural(bots.length, "bot career")}, arrow keys move between them`}>
        {ZONES.map((z, i) => (
          <g key={z.id} aria-hidden>
            <rect x={rects[i].x} y={rects[i].y} width={Math.max(0, rects[i].w)} height={Math.max(0, rects[i].h)} fill={rects[i].fill} />
            <text x={rects[i].x + 10} y={rects[i].y + 20} className="compass__zone">{z.label}</text>
            <text x={rects[i].x + 10} y={rects[i].y + 34} className="ax">{z.sub}</text>
          </g>
        ))}
        <g aria-hidden>
          <line x1={ex} x2={ex} y1={pad.t} y2={h - pad.b} stroke="var(--line2)" strokeDasharray="3 3" />
          <line x1={pad.l} x2={w - pad.r} y1={sy} y2={sy} stroke="var(--line2)" strokeDasharray="3 3" />
          <text x={ex + 4} y={h - pad.b - 6} className="ax">{Math.round(ENTRY_X * 100)}%</text>
          <text x={w - pad.r - 4} y={sy - 6} textAnchor="end" className="ax">{Math.round(SUPPORT_Y * 100)}%</text>
          <text x={pad.l} y={h - 14} className="ax ax--label">Takes the first duel of the round more often →</text>
          <text x={w - pad.r} y={h - 14} textAnchor="end" className="ax">↑ more trades and assists</text>
        </g>
        <g onKeyDown={move}>
          {bots.map((d, i) => (
            <g key={d.key} ref={(el) => { dotRefs.current[i] = el; }} className="compass__dot" transform={`translate(${X(d.x)} ${Y(d.y)})`}
              tabIndex={i === at ? 0 : -1} aria-label={dotText(d)}
              onPointerEnter={() => setHover(d)} onPointerLeave={() => setHover(null)}
              onFocus={() => { setCursor(i); setHover(d); }} onBlur={() => setHover(null)}>
              <circle r="10" fill="transparent" />
              <circle className="compass__mark" r="4.5" fill="var(--ink3)" opacity={hover?.key === d.key ? 1 : 0.55} />
            </g>
          ))}
        </g>
        {me && (
          <g transform={`translate(${X(me.x)} ${Y(me.y)})`} aria-hidden>
            <circle r="16" fill="rgba(255,215,173,.14)" />
            <circle r="7" fill="var(--cream)" />
            <text x="14" y="-12" className="compass__you">You, {zoneOf(me).label}</text>
          </g>
        )}
        {hover && (
          <g transform={`translate(${Math.min(w - 180, X(hover.x) + 12)} ${Math.max(pad.t, Y(hover.y) - 46)})`} pointerEvents="none" aria-hidden>
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
  const allPlaces = Object.entries(pos?.presence?.places ?? {}).sort((a, b) => b[1] - a[1]);
  const places = allPlaces.slice(0, 8);
  const total = Object.values(pos?.presence?.places ?? {}).reduce((a, s) => a + s, 0) || 1;
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
              {/* map markers are dots (SYSTEM.md): kills filled, deaths ringed */}
              {pos.deaths.map(([x0, y0], i) => { const [x, y] = frame.to(x0, y0); return <circle key={`d${i}`} cx={x} cy={y} r="6" fill="none" stroke="var(--poor-text)" strokeWidth="2.5" opacity="0.9" />; })}
            </RadarView>
            <div className="legend">
              <span><svg width="10" height="10" aria-hidden><circle cx="5" cy="5" r="4" fill="var(--good-text)" /></svg>Your kills</span>
              <span><svg width="10" height="10" aria-hidden><circle cx="5" cy="5" r="3.5" fill="none" stroke="var(--poor-text)" strokeWidth="2" /></svg>Your deaths</span>
              <span><i className="swatch" style={{ background: "rgba(255,215,173,.4)" }} />Where you moved</span>
              <span className="help" data-tip="Kills sit where you stood, deaths where you fell." tabIndex={0} aria-label="Where the marks sit">?</span>
            </div>
          </div>
          <div className="wyp__side">
            <div className="wyp__count"><b className="num">{onMap.length}</b><span className="meta">{plural(onMap.length, "match", "matches")} on {mapName(map)}, {recorded} with movement</span></div>
            <div className="wyp__count"><b className="num good-text">{pos.kills.length}</b><span className="meta">kills placed</span><b className="num poor-text">{pos.deaths.length}</b><span className="meta">deaths placed</span></div>
            {places.length ? (
              <ul className="places lslist" aria-label="Where you spend your time alive">
                {places.map(([p, secs]) => <li key={p}><span className="places__l">{calloutName(p)}</span><ShareTrack value={secs} max={places[0][1]} /><b className="num"><Num v={fmtPct((100 * secs) / total, 0)} /></b></li>)}
                {allPlaces.length > places.length && <li className="places__more meta">and {plural(allPlaces.length - places.length, "more place", "more places")}</li>}
              </ul>
            ) : <p className="meta"><NeedsDemo detail="Time spent per place needs movement, which converted logs lack." /></p>}
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
  { tag: "Positioning", ids: ["timeAlive", "firstDuelTime", "clutchPointsPR", "clutches24"] },
  { tag: "Utility", ids: ["utilDmgPR", "flashAssistsPR", "flashesPR", "assistsPerFlash", "dmgPerHe"] },
];

export function Ranks({ q, side = "both" }: { q: Query; side?: PoolSide }) {
  const { baselines, baselinesError } = useData();
  const pros = useCall("compare", baselines ? [q, { pool: "all", side }] : null);
  const bots = useCall("style", [q, { pool: "all", side }]);
  const proP = pros.data?.p ?? null;
  const botP = bots.data?.p ?? null;
  const careers = bots.data?.careers ?? null;
  const error = pros.error ?? bots.error ?? (baselines ? null : baselinesError);
  const n = { pros: baselines?.n.all?.[side] ?? 0, bots: bots.data?.n ?? 0 };
  return (
    <Card title="Ranks by topic" tip={PANEL_TIP.ranksByTopic} aside={
      <span className="card__aside-row">
        <span className="meta">{proP && botP && careers ? `How well against ${n.pros} pros, style against ${botPopulation(careers, { n: n.bots, role: "all" }).text}` : ""}</span>
        {careers?.provisional && <span className="chip chip--outline" data-tip={PROVISIONAL_TIP} tabIndex={0}>Provisional</span>}
      </span>
    }>
      {!proP || !botP ? (error ? <p className="meta">{error}</p> : <div className="skel" style={{ height: 240 }} />) : (
        <div className="ranks">
          {RANKS.map((g) => (
            <section key={g.tag} className="ranks__group">
              <h3 className="caps">{g.tag}</h3>
              <MetricList label={g.tag} rank>
                {g.ids.map((id) => {
                  const m = metric(id);
                  const style = m.kind === "identity";
                  const x = (style ? botP : proP)[id];
                  return (
                    <MetricRow key={id} label={m.label} value={x.value === null ? null : fmtMetric(id, x.value)} pct={x.pct} kind={style ? "style" : "performance"}
                      population={style && careers ? botPopulation(careers, { n: n.bots, role: "all" }).text : `${n.pros} pros`} tip={tipOf(id)} reason={x.reason} approx={m.status === "approx"} rank />
                  );
                })}
              </MetricList>
            </section>
          ))}
        </div>
      )}
    </Card>
  );
}
