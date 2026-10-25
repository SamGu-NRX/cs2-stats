// Playstyle: identity rather than performance (design/research-playstyle-viz.md).
// - Style compass: you and every bot career on two of the engine's role signals, with the zones
//   named in words.
// - Role signals: the same plain-language card as the profile.
// - Where you play: a radar of your movement, kills and deaths, for any map you have played.
// - Percentiles: one ranked list against bot careers, grouped by kind.
// - Rotations and first contact wait for analysis that has not been built; those panels say so.
import { useMemo, useState } from "react";
import { percentile } from "../../stats/attributes";
import { addCounters, emptyCounters, type Counters } from "../../stats/counters";
import { SUBSTAT_BY_ID } from "../../stats/hltv";
import { METRICS } from "../../stats/metrics";
import { CELL, GRID, HALF_EXTENT } from "../../stats/positions";
import { Card } from "../components/Card";
import { useWidth } from "../components/charts";
import { Select } from "../components/controls";
import { frameFor, RadarView } from "../components/MapArt";
import { filterSummaries, mapsIn, roleFor } from "../data/engine";
import { useMapPositions } from "../data/hooks";
import { useData } from "../data/provider";
import { totals } from "../data/series";
import { DeathIcon } from "../icons/game";
import { fmtPct, mapName, plural } from "../lib/format";
import { BarContent } from "../shell/Bar";
import { MapFilter, TimeFilter, useFilters } from "../shell/filters";
import { RoleCard } from "./profile/parts";
import { Empty } from "./shared";

interface Dot { key: string; name: string; you: boolean; x: number; y: number; label: string; rounds: number }

export default function Playstyle() {
  const { summaries } = useData();
  const { map, n } = useFilters();
  const list = useMemo(() => { const f = filterSummaries(summaries, map); return n ? f.slice(0, n) : f; }, [summaries, map, n]);
  const you = useMemo(() => totals(list).c, [list]);
  const careers = useMemo(() => {
    const m = new Map<string, { name: string; c: Counters }>();
    for (const s of list) for (const b of s.bots) {
      let e = m.get(b.key);
      if (!e) m.set(b.key, (e = { name: b.name, c: emptyCounters() }));
      addCounters(e.c, b.c);
    }
    return [...m.entries()].map(([key, e]) => ({ key, ...e })).filter((e) => e.c.fullRounds >= 20);
  }, [list]);
  const youRole = roleFor(you);
  const dots: Dot[] = useMemo(() => {
    const mk = (key: string, name: string, c: Counters, isYou: boolean): Dot | null => {
      const r = roleFor(c);
      const x = r.evidence.openingAttempts;
      const y = r.evidence.tradeAssistShare;
      if (x === null || y === null) return null;
      return { key, name, you: isYou, x, y, label: r.label, rounds: c.fullRounds };
    };
    return [...careers.map((e) => mk(e.key, e.name, e.c, false)), mk("you", "You", you, true)].filter((d): d is Dot => d !== null);
  }, [careers, you]);

  return (
    <div className="view view--capped">
      <BarContent crumbs={[{ label: "Playstyle" }]} tools={<><MapFilter /><TimeFilter /></>} />
      <div className="view__in playstyle">
        {!list.length ? <Card><Empty text="No matches in this filter." /></Card> : (
          <>
            <div className="ps-top">
              <Card title="Style compass" aside={<span className="meta">You and {plural(dots.length - 1, "bot career")}</span>}>
                <Compass dots={dots} />
              </Card>
              <RoleCard role={youRole} />
            </div>
            <WhereYouPlay />
            <Card title="Where you rank" aside={<span className="meta">Against {plural(careers.length, "bot career")} with 20+ rounds</span>}>
              <Ranks you={you} careers={careers.map((e) => e.c)} />
            </Card>
            <p className="meta ps-next">Rotations between callouts and where you first meet the enemy arrive with the movement analysis and line-of-sight tracing.</p>
          </>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- compass

const ENTRY_X = 0.25;
const SUPPORT_Y = 0.45;

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
  const zones = [
    { x: pad.l, y: pad.t, w: ex - pad.l, h: sy - pad.t, label: "Support", sub: "plays off teammates", fill: "rgba(43,163,224,.07)" },
    { x: ex, y: pad.t, w: w - pad.r - ex, h: sy - pad.t, label: "Entry and support", sub: "opens and trades", fill: "rgba(172,149,122,.08)" },
    { x: ex, y: sy, w: w - pad.r - ex, h: h - pad.b - sy, label: "Entry", sub: "takes first duels", fill: "rgba(219,136,28,.07)" },
    { x: pad.l, y: sy, w: ex - pad.l, h: h - pad.b - sy, label: "Rifler", sub: "neither signal", fill: "transparent" },
  ];
  return (
    <div ref={ref} className="chart compass">
      <svg width={w} height={h} role="img" aria-label={`Style compass: you ${me ? `at ${Math.round(100 * me.x)}% opening attempts and ${Math.round(100 * me.y)}% trades and assists` : "not placed"}`}>
        {zones.map((z) => (
          <g key={z.label}>
            <rect x={z.x} y={z.y} width={Math.max(0, z.w)} height={Math.max(0, z.h)} fill={z.fill} />
            <text x={z.x + 10} y={z.y + 20} className="compass__zone">{z.label}</text>
            <text x={z.x + 10} y={z.y + 34} className="ax">{z.sub}</text>
          </g>
        ))}
        <line x1={ex} x2={ex} y1={pad.t} y2={h - pad.b} stroke="var(--line2)" strokeDasharray="3 3" />
        <line x1={pad.l} x2={w - pad.r} y1={sy} y2={sy} stroke="var(--line2)" strokeDasharray="3 3" />
        <text x={ex + 4} y={h - pad.b - 6} className="ax">{Math.round(ENTRY_X * 100)}%</text>
        <text x={w - pad.r - 4} y={sy - 6} textAnchor="end" className="ax">{Math.round(SUPPORT_Y * 100)}%</text>
        <text x={pad.l} y={h - 14} className="ax ax--label">Takes the first duel of the round more often →</text>
        <text x={w - pad.r} y={h - 14} textAnchor="end" className="ax">share of rounds in the opening duel</text>
        {dots.filter((d) => !d.you).map((d) => (
          <circle key={d.key} cx={X(d.x)} cy={Y(d.y)} r="4.5" fill="var(--ink3)" opacity={hover?.key === d.key ? 1 : 0.55} onPointerEnter={() => setHover(d)} onPointerLeave={() => setHover(null)} />
        ))}
        {me && (
          <g transform={`translate(${X(me.x)} ${Y(me.y)})`}>
            <circle r="16" fill="rgba(255,215,173,.14)" />
            <circle r="7" fill="var(--cream)" />
            <text x="14" y="-12" className="compass__you">You, {me.label}</text>
          </g>
        )}
        {hover && (
          <g transform={`translate(${Math.min(w - 180, X(hover.x) + 12)} ${Math.max(pad.t, Y(hover.y) - 46)})`} pointerEvents="none">
            <rect width="170" height="40" rx="6" fill="var(--bg0)" stroke="var(--line2)" />
            <text x="10" y="16" className="ax ax--strong" style={{ fill: "var(--ink)" }}>{hover.name}</text>
            <text x="10" y="31" className="ax">{hover.label}, {hover.rounds} rounds</text>
          </g>
        )}
      </svg>
      <p className="meta">Up: more of your kills and assists are trades or assists. Right: you are in the first duel of more rounds. Grey dots are bots from the same matches.</p>
    </div>
  );
}

// ---------------------------------------------------------------- where you play

export function WhereYouPlay() {
  const { summaries } = useData();
  const maps = mapsIn(summaries);
  const { map: filtered } = useFilters();
  const [map, setMap] = useState<string>(filtered ?? maps[0] ?? "de_dust2");
  const pos = useMapPositions(map).data;
  const frame = useMemo(() => (pos ? frameFor(map, pos, [...pos.kills, ...pos.deaths]) : null), [map, pos]);
  const matches = summaries.filter((s) => s.map === map).length;
  const recorded = summaries.filter((s) => s.map === map && s.hasPos).length;
  const cells = pos?.human ?? {};
  const maxCell = Math.max(1, ...Object.values(cells));
  const places = pos ? Object.entries(pos.places).sort((a, b) => b[1] - a[1]).slice(0, 8) : [];
  const total = places.reduce((a, [, s]) => a + s, 0) || 1;
  return (
    <Card title="Where you play" aside={<Select label="Map" prefix="Map" value={map} onChange={setMap} options={maps.map((m) => ({ value: m, label: mapName(m) }))} />}>
      {!pos || !frame ? <div className="skel" style={{ height: 360 }} /> : (
        <div className="wyp">
          <div className="wyp__map">
            <RadarView map={map} frame={frame} label={`Where you moved, killed and died on ${mapName(map)}`}>
              {Object.entries(cells).map(([c, k]) => {
                const cx = (+c % GRID) * CELL - HALF_EXTENT + CELL / 2;
                const cy = Math.floor(+c / GRID) * CELL - HALF_EXTENT + CELL / 2;
                const [x, y] = frame.to(cx, cy);
                const s = frame.to(CELL, 0)[0] - frame.to(0, 0)[0];
                return <rect key={c} x={x - s / 2} y={y - s / 2} width={s} height={s} fill="var(--cream)" opacity={0.04 + 0.3 * Math.sqrt(k / maxCell)} />;
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
            <div className="wyp__count"><b className="num">{matches}</b><span className="meta">{plural(matches, "match", "matches")} on {mapName(map)}, {recorded} with movement</span></div>
            <div className="wyp__count"><b className="num good-text">{pos.kills.length}</b><span className="meta">kills placed</span><b className="num poor-text">{pos.deaths.length}</b><span className="meta">deaths placed</span></div>
            {places.length ? (
              <ul className="places">
                {places.map(([p, secs]) => <li key={p}><span>{p}</span><span className="hbar"><i style={{ width: `${(100 * secs) / places[0][1]}%` }} /></span><b className="num">{fmtPct((100 * secs) / total, 0)}</b></li>)}
              </ul>
            ) : <p className="meta">Movement comes from recorded matches; converted logs place kills and deaths only.</p>}
          </div>
        </div>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------- percentiles

const RANKS: { tag: string; ids: { id: string; sub?: boolean }[] }[] = [
  { tag: "Aim and damage", ids: [{ id: "kpr" }, { id: "adr" }, { id: "perfectKills", sub: true }] },
  { tag: "Style", ids: [{ id: "openAttempts" }, { id: "openSuccess" }, { id: "tradeKillsPct" }, { id: "rws", sub: true }] },
  { tag: "Positioning", ids: [{ id: "timeAlive" }, { id: "firstDuelTime", sub: true }, { id: "clutchPointsPR" }] },
  { tag: "Utility", ids: [{ id: "utilDmgPR" }, { id: "flashAssistsPR" }] },
];

function Ranks({ you, careers }: { you: Counters; careers: Counters[] }) {
  if (careers.length < 5) return <p className="meta">Needs at least five bot careers with 20 rounds.</p>;
  return (
    <div className="ranks">
      {RANKS.map((g) => (
        <section key={g.tag} className="ranks__group">
          <h3 className="caps">{g.tag}</h3>
          <ul>
            {g.ids.map(({ id, sub }) => {
              const s = sub ? SUBSTAT_BY_ID[id] : null;
              const m = METRICS[id];
              const val = s ? s.value(you) : m.value(you);
              const vals = careers.map((c) => (s ? s.value(c) : m.value(c))).filter((x): x is number => x !== null);
              const p = val === null || !vals.length ? null : percentile(vals, val, m?.lowerIsBetter ?? false);
              const fmt = s ? s.fmt : m.fmt;
              const text = val === null ? "–" : fmt === "pct" ? fmtPct(val) : fmt === "secs" ? `${val.toFixed(1)} s` : val.toFixed(2);
              const tone = p === null ? "" : p >= 67 ? "is-high" : p < 33 ? "is-low" : "";
              return (
                <li key={id} className={tone} data-tip={s?.def ?? m.def}>
                  <span className="ranks__l">{s?.name ?? m.label}</span>
                  <b className="num ranks__v">{text}</b>
                  <span className="ranks__track"><i style={{ left: `${p ?? 0}%` }} /><em style={{ left: "50%" }} /></span>
                  <span className="ranks__p num">{p === null ? "–" : p >= 50 ? `Top ${Math.max(1, Math.round(100 - p))}%` : `Bottom ${Math.max(1, Math.round(p))}%`}</span>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
      <p className="meta ranks__note">The dot shows where you sit among the bot careers, worst on the left; the tick is the middle.</p>
    </div>
  );
}
