// Playstyle: identity rather than performance (design/research-playstyle-viz.md).
// - Style compass: you and every bot career your style ranks against, on opening attempts and the
//   trade/assist share, with the Entry and Support thresholds as zones (identity.ts ROLE_SIGNALS).
// - Role: the engine's role blend per side, with its evidence in words, and main's role signals.
// - Where you play: a radar of your movement, kills and deaths, for any map you have played, with the
//   places you spend your time.
// - Where you rank: one ranked list of percentiles, grouped by topic. Performance rows rank against pro
//   players; style (identity) rows against the bot careers in the same matches (worker/ranking.ts).
// - Rotations and first contact wait for analysis that has not been built; the page says so.
import { useMemo, useRef, useState, type KeyboardEvent } from "react";
import { CELL, cellCentre } from "../../stats/positions";
import { Card } from "../components/Card";
import { useWidth } from "../components/charts";
import { Select } from "../components/controls";
import { frameFor, RadarView } from "../components/MapArt";
import { BOTS_TIP, careerEntries, fmtMetric, mapsIn, rankText } from "../data/engine";
import { useCall } from "../data/hooks";
import { metric, roleSignals } from "../data/meta";
import { useData } from "../data/provider";
import { DeathIcon } from "../icons/game";
import { fmtPct, mapName, plural } from "../lib/format";
import { BarContent } from "../shell/Bar";
import { MapFilter, TimeFilter, useFilters } from "../shell/filters";
import type { CompassResult, Query } from "../../worker/protocol";
import type { StylePoint } from "../../stats/identity";
import { RoleCard } from "./profile/parts";
import { Empty, NeedsDemo, NotCompared, Provisional } from "./shared";

export default function Playstyle() {
  const { matches, you } = useData();
  const { map, n } = useFilters();
  const list = useMemo(() => { const f = careerEntries(matches, map); return n ? f.slice(0, n) : f; }, [matches, map, n]);
  const q = useMemo(() => (list.length && you.length ? { files: list.map((e) => e.file), filter: { player: you } } : null), [list, you]);
  return (
    <div className="view view--capped">
      <BarContent crumbs={[{ label: "Playstyle" }]} tools={<><MapFilter /><TimeFilter /></>} />
      <div className="view__in playstyle">
        {!q ? <Card><Empty text="No matches in this filter." /></Card> : (
          <>
            <div className="ps-top">
              <StyleCompass q={q} />
              <RoleCard q={q} />
            </div>
            <WhereYouPlay />
            <Ranks q={q} />
            <p className="meta ps-next">Rotations between callouts and where you first meet the enemy arrive with the movement analysis and line-of-sight tracing.</p>
          </>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- compass

function StyleCompass({ q }: { q: Query }) {
  const r = useCall("compass", [q]);
  const c = r.data;
  return (
    <Card title="Style compass" aside={c ? (
      <span className="card__aside-row">
        <Provisional c={c.careers} />
        <span className="meta" data-tip={BOTS_TIP}>{c.careers.unit === "careers" ? `You and ${plural(c.bots.length, "bot career")} with ${c.careers.minRounds}+ rounds` : `You and ${plural(c.bots.length, "bot match", "bot matches")}`}</span>
      </span>
    ) : undefined}>
      {!c ? (r.error ? <p className="meta">{r.error}</p> : <div className="skel" style={{ height: 340 }} />) : <Compass c={c} />}
    </Card>
  );
}

/**
 * Main's compass: x is opening attempts, y the trade/assist share, both in percent, split into four
 * zones by the Entry and Support thresholds. Each bot dot is keyboard-reachable as one stop: Tab enters
 * the dots, the arrow keys move between them left to right, and the tooltip names the bot.
 */
function Compass({ c }: { c: CompassResult }) {
  const [ref, w] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const [cursor, setCursor] = useState(0);
  const dotRefs = useRef<(SVGGElement | null)[]>([]);
  const sig = roleSignals();
  const entryX = sig.find((x) => x.id === "Entry")!.threshold;
  const supportY = sig.find((x) => x.id === "Support")!.threshold;
  const bots = useMemo(() => [...c.bots].sort((a, b) => a.x - b.x || a.y - b.y), [c.bots]);
  const dots: StylePoint[] = c.you ? [...bots, c.you] : bots;
  const h = 340;
  const pad = { l: 16, r: 16, t: 16, b: 40 };
  const xmax = Math.max(50, ...dots.map((d) => d.x)) * 1.08;
  const ymax = Math.max(90, ...dots.map((d) => d.y)) * 1.04;
  const X = (x: number) => pad.l + (x / xmax) * (w - pad.l - pad.r);
  const Y = (y: number) => h - pad.b - (y / ymax) * (h - pad.t - pad.b);
  const ex = X(entryX);
  const sy = Y(supportY);
  const me = c.you;
  const zones = [
    { x: pad.l, y: pad.t, w: ex - pad.l, h: sy - pad.t, label: "Support", sub: "plays off teammates", fill: "rgba(43,163,224,.07)" },
    { x: ex, y: pad.t, w: w - pad.r - ex, h: sy - pad.t, label: "Entry and support", sub: "opens and trades", fill: "rgba(172,149,122,.08)" },
    { x: ex, y: sy, w: w - pad.r - ex, h: h - pad.b - sy, label: "Entry", sub: "takes first duels", fill: "rgba(219,136,28,.07)" },
    { x: pad.l, y: sy, w: ex - pad.l, h: h - pad.b - sy, label: "Rifler", sub: "neither signal", fill: "transparent" },
  ];
  const move = (e: KeyboardEvent<SVGGElement>) => {
    const step = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
    if (!step || !bots.length) return;
    e.preventDefault();
    const next = (cursor + step + bots.length) % bots.length;
    setCursor(next);
    dotRefs.current[next]?.focus();
  };
  const tipOf = (d: StylePoint) => `${d.name}: ${d.label}, ${d.rounds} rounds. Opening attempts ${Math.round(d.x)}%, trades and assists ${Math.round(d.y)}%.`;
  const meX = me ? X(me.x) : 0;
  const flip = meX > w - 170;
  return (
    <div ref={ref} className="chart compass">
      <svg width={w} height={h} role="group" aria-label={`Style compass: you ${me ? `at ${Math.round(me.x)}% opening attempts and ${Math.round(me.y)}% trades and assists, ${me.label}` : "not placed"}; ${plural(bots.length, "bot career")}`}>
        {zones.map((z) => (
          <g key={z.label} aria-hidden>
            <rect x={z.x} y={z.y} width={Math.max(0, z.w)} height={Math.max(0, z.h)} fill={z.fill} />
            <text x={z.x + 10} y={z.y + 20} className="compass__zone">{z.label}</text>
            <text x={z.x + 10} y={z.y + 34} className="ax">{z.sub}</text>
          </g>
        ))}
        <g aria-hidden>
          <line x1={ex} x2={ex} y1={pad.t} y2={h - pad.b} stroke="var(--line2)" strokeDasharray="3 3" />
          <line x1={pad.l} x2={w - pad.r} y1={sy} y2={sy} stroke="var(--line2)" strokeDasharray="3 3" />
          <text x={ex + 4} y={h - pad.b - 6} className="ax">{entryX}%</text>
          <text x={w - pad.r - 4} y={sy - 6} textAnchor="end" className="ax">{supportY}%</text>
          <text x={pad.l} y={h - 14} className="ax ax--label">Takes the first duel of the round more often →</text>
          <text x={w - pad.r} y={h - 14} textAnchor="end" className="ax">share of rounds in the opening duel</text>
        </g>
        <g onKeyDown={move}>
          {bots.map((d, i) => (
            <g
              key={`${d.name}-${i}`}
              ref={(el) => { dotRefs.current[i] = el; }}
              className="compass__dot"
              transform={`translate(${X(d.x)} ${Y(d.y)})`}
              tabIndex={i === cursor ? 0 : -1}
              aria-label={tipOf(d)}
              data-tip={tipOf(d)}
              onPointerEnter={() => setHover(i)}
              onPointerLeave={() => setHover(null)}
              onFocus={() => { setCursor(i); setHover(i); }}
              onBlur={() => setHover(null)}
            >
              <circle r="10" fill="transparent" />
              <circle className="compass__mark" r="4.5" fill="var(--ink3)" opacity={hover === i ? 1 : 0.55} />
            </g>
          ))}
        </g>
        {me && (
          <g transform={`translate(${meX} ${Y(me.y)})`} aria-hidden>
            <circle r="16" fill="rgba(255,215,173,.14)" />
            <circle r="7" fill="var(--cream)" />
            <text x={flip ? -14 : 14} y="-12" textAnchor={flip ? "end" : "start"} className="compass__you">You, {me.label}</text>
          </g>
        )}
      </svg>
      <p className="meta">Up: more of your kills and assists are trades or assists. Right: you are in the first duel of more rounds. Grey dots are the bots your style is ranked against, {c.careers.unit === "careers" ? `one per bot career with ${c.careers.minRounds}+ rounds` : `one per bot per match until ${c.careers.minPool} bot careers have ${c.careers.minRounds}+ rounds`}.</p>
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
            ) : <p className="meta"><NeedsDemo detail="Where you spend your time comes from movement samples; converted logs place kills and deaths only." /></p>}
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
  { tag: "Positioning", ids: ["timeAlive", "firstDuelTime", "clutchPointsPR", "clutches24"] },
  { tag: "Utility", ids: ["utilDmgPR", "flashAssistsPR", "flashesPR", "assistsPerFlash", "dmgPerHe"] },
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
    <Card title="Where you rank" aside={
      <span className="card__aside-row">
        {careers && <Provisional c={careers} />}
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
                    <li key={id} className={tone} data-tip={m.def}>
                      <span className="ranks__l">{m.label}<span className="ranks__pop" data-tip={style ? BOTS_TIP : undefined}>{style ? "vs bots" : "vs pros"}</span></span>
                      <b className="num ranks__v">{fmtMetric(id, x.value)}</b>
                      <span className={`ranks__track ${style ? "is-style" : ""}`}>{x.pct !== null && <i style={{ left: `${x.pct}%` }} />}<em style={{ left: "50%" }} /></span>
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
