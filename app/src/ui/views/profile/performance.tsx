// Profile's Performance half: how well you play, both sides, ranked against pros where a rank exists.
// Round swing, the how-good tables, rating by match, maps, the moments behind clutches and multi-kills,
// which numbers go with winning, and how you play by what you bought.
import { useId, useMemo, useState } from "react";
import type { Measures } from "../../../stats/facts";
import type { ClutchRow, CompareResult, Query, Rolled, SideRatings } from "../../../worker/protocol";
import { MapThumb, Num } from "../../components/bits";
import { Card } from "../../components/Card";
import { TrendLine } from "../../components/charts";
import { DataTable } from "../../components/DataTable";
import { ApproxMark, Percentile } from "../../components/Percentile";
import { BUY_CLASSES, entryRating, fmtMetric, mapsIn, multiKillRows, proPoolName, RATING_LABEL, RATING_POOLED, ratingHeadline } from "../../data/engine";
import { useCall, useRatings, useRollups } from "../../data/hooks";
import type { MatchEntry } from "../../data/match";
import { metric } from "../../data/meta";
import { useData } from "../../data/provider";
import type { BuyClass } from "../../../stats/economy";
import { fmtAdr, fmtMatchDay, fmtPct, fmtRating, fmtSwing, mapName, plural, signed } from "../../lib/format";
import { ratingText, scoreText, swingScore } from "../../lib/scale";
import { matchHref } from "../../router";
import { NeedsDemo } from "../shared";
import { MetricSlot, pctProps } from "./parts";

// ---------------------------------------------------------------- round swing

export function SwingCard({ you, cmp }: { you: Rolled; cmp: CompareResult | null }) {
  const swing = you.v.swing === null ? null : you.v.swing / 100;
  const pop = cmp ? proPoolName(cmp.role) : "pros";
  return (
    <Card title="Round swing" aside={<span className="meta">{plural(you.m.swingRounds, "round")}</span>} className="swingcard">
      <b className="swingcard__big num" style={{ color: swing === null ? undefined : scoreText(swingScore(swing)) }}><Num v={fmtSwing(swing)} /></b>
      <p className="swingcard__say">
        {swing === null ? <NeedsDemo detail="No round in these matches has swing: a converted log values a round only where every player's equipment is known." />
          : `Each round, your kills, damage and trades ${swing >= 0 ? "add" : "take"} ${Math.abs(100 * swing).toFixed(2)} percentage points ${swing >= 0 ? "to" : "from"} your team's chance of winning it.`}
      </p>
      {cmp && swing !== null && <Percentile {...pctProps("swing", cmp.p.swing, you.v.swing)} kind="performance" population={pop} />}
    </Card>
  );
}

// ---------------------------------------------------------------- how good

/** HLTV's "how good" metrics, in the order HLTV lists them beside Rating 3.0 (design/identity.md). */
const HOW_GOOD = ["tradeKillSuccess", "tradedDeathSuccess", "openingSuccess", "oneVsOne", "awpDuelWin", "openingSwing", "clutchSwing", "awpSwing", "flashSwing", "assistsPerFlash", "dmgPerHe", "grenadeDmgTaken"];

/** The sample behind a rate, where the measures hold it: a small one is named in the phrase. */
function sampleOf(id: string, m: Measures): string | undefined {
  if (id === "oneVsOne") return m.clutch1 ? plural(m.clutch1, "1v1") : undefined;
  if (id === "openingSuccess") { const n = m.openingKills + m.openingDeaths; return n ? plural(n, "opening duel") : undefined; }
  return undefined;
}

/** The performance tables HLTV pairs with Rating 3.0, each against pros, both sides. */
export function HowGood({ cmp, error, m }: { cmp: CompareResult | null; error: string | null; m: Measures }) {
  const ids = cmp ? HOW_GOOD.filter((id) => cmp.p[id] && metric(id).status !== "unavailable") : [];
  return (
    <Card title="How good" aside={<span className="meta">{cmp ? `Against ${cmp.n} ${proPoolName(cmp.role)}` : ""}</span>}>
      {!cmp ? (error ? <p className="meta">{error}</p> : <div className="skel" style={{ height: 240 }} />) : (
        <div className="howgood">
          {ids.map((id) => <Percentile key={id} {...pctProps(id, cmp.p[id], cmp.p[id].value)} kind="performance" population={proPoolName(cmp.role)} sample={sampleOf(id, m)} />)}
        </div>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------- rating by match

export function RatingByMatch({ list, pooled }: { list: MatchEntry[]; pooled: number | null }) {
  const pts = [...list].reverse().map((f) => ({ key: f.file, value: entryRating(f), label: fmtMatchDay(f.match) }));
  return (
    <Card title="Rating by match" aside={<span className="meta">{plural(list.length, "match", "matches")}, oldest on the left</span>}>
      <TrendLine height={170} points={pts} fmt={(v) => v.toFixed(2)} bench={1} benchLabel="average player" avgValue={pooled} avgLabel="pooled" />
      <div className="legend">
        <span><svg width="18" height="8" aria-hidden><line x1="0" y1="4" x2="18" y2="4" stroke="var(--cream)" strokeWidth="1.75" /></svg>{ratingHeadline()} per match</span>
        <span data-tip={RATING_POOLED}><svg width="18" height="8" aria-hidden><line x1="0" y1="4" x2="18" y2="4" stroke="var(--cream)" strokeDasharray="2 4" /></svg>Pooled over every round</span>
        <span><svg width="18" height="8" aria-hidden><line x1="0" y1="4" x2="18" y2="4" stroke="var(--ink3)" strokeDasharray="3 3" /></svg>1.00, an average player</span>
        <span><svg width="8" height="8" aria-hidden><circle cx="4" cy="4" r="3.5" fill="var(--good-text)" /></svg>Best</span>
        <span><svg width="8" height="8" aria-hidden><circle cx="4" cy="4" r="3.5" fill="var(--poor-text)" /></svg>Worst, when below 1.00</span>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------- maps

interface MapRow { map: string; played: number; wins: number; s: Rolled; r: SideRatings }

export function MapsTable({ list }: { list: MatchEntry[] }) {
  const { you: ids } = useData();
  const maps = useMemo(() => mapsIn(list), [list]);
  const files = useMemo(() => list.map((e) => e.file), [list]);
  const qs = useMemo(() => maps.map((m) => ({ files, filter: { player: ids, maps: [m] } })), [maps, files, ids]);
  const sums = useRollups(qs).data;
  const rats = useRatings(qs).data;
  const rows: MapRow[] = sums?.length === maps.length && rats?.length === maps.length ? maps.map((m, i) => {
    const on = list.filter((e) => e.match.map === m);
    return { map: m, played: on.length, wins: on.filter((e) => e.result === "W").length, s: sums[i], r: rats[i] };
  }) : [];
  const approx = metric("rating3").status === "approx";
  return (
    <Card title="Maps" flush>
      <DataTable
        label="Maps"
        rows={rows}
        rowKey={(m) => m.map}
        defaultSort={{ key: "played", dir: "desc" }}
        columns={[
          { key: "map", label: "Map", align: "l", sort: (m) => mapName(m.map), render: (m) => <span className="mapcell"><MapThumb map={m.map} size={22} /><b>{mapName(m.map)}</b></span> },
          { key: "played", label: "Played", tip: "Matches on the map", sort: (m) => m.played, render: (m) => m.played },
          { key: "wl", label: "W–L", sort: (m) => m.wins / m.played, render: (m) => <span className="num">{m.wins}<span className="faint">–</span>{m.played - m.wins}</span> },
          { key: "adr", label: "ADR", sort: (m) => m.s.v.adr, render: (m) => fmtAdr(m.s.v.adr) },
          { key: "kast", label: "KAST", sort: (m) => m.s.v.kast, render: (m) => <Num v={fmtPct(m.s.v.kast)} /> },
          { key: "t", label: <span className="t-text">T</span>, tip: "Rating 3.0 over your T rounds on the map", sort: (m) => m.r.T.value, render: (m) => fmtRating(m.r.T.value) },
          { key: "ct", label: <span className="ct-text">CT</span>, tip: "Rating 3.0 over your CT rounds on the map", sort: (m) => m.r.CT.value, render: (m) => fmtRating(m.r.CT.value) },
          // the header is a sort button, so the approx mark is plain text here (a focusable mark would nest in it) and the tip says it
          { key: "rating", label: <>{RATING_LABEL}{approx && <span className="approx"><span aria-hidden>≈</span><span className="sr-only">, approximate</span></span>}</>, tip: approx ? `${RATING_POOLED} Approximate: our reconstruction of HLTV's formula.` : RATING_POOLED, colored: true, sort: (m) => m.r.both.value, render: (m) => { const x = m.r.both.value; return <b style={{ color: x === null ? undefined : ratingText(x) }}>{fmtRating(x)}</b>; } },
        ]}
      />
    </Card>
  );
}

// ---------------------------------------------------------------- moments

type ClutchKind = "1v1" | "1vN";

/** Career counts as moments: clutches open the rounds behind them; multi-kills and opening duels are counts. */
export function Moments({ q, m, list }: { q: Query; m: Measures; list: MatchEntry[] }) {
  const rows = useCall("clutches", [q]).data;
  const [open, setOpen] = useState<ClutchKind | null>(null);
  // a keyboard toggle changes the tile's state instantly; a click fades it
  const [instant, setInstant] = useState(true);
  const listId = useId();
  const byFile = useMemo(() => new Map(list.map((e) => [e.file, e])), [list]);
  const played1 = m.clutch1;
  const won1 = m.clutchWon1;
  const playedN = m.clutch2 + m.clutch3 + m.clutch4 + m.clutch5;
  const wonN = m.clutchWon2 + m.clutchWon3 + m.clutchWon4 + m.clutchWon5;
  const multis = multiKillRows(m);
  const k = (n: number) => multis.find((x) => x.k === n)!.rounds;
  const shown = (rows ?? []).filter((c) => (open === "1v1" ? c.opponents === 1 : c.opponents > 1));
  const clutchTile = (kind: ClutchKind, label: string, won: number, played: number) => (
    played === 0 ? (
      <div className="moment" data-none><span className="moment__l">{label}</span><b className="moment__v faint" data-tip={`No ${kind === "1v1" ? "1v1" : "1v2 to 1v5"} clutches in these matches`}>–</b></div>
    ) : (
      <button className={`moment moment--btn ${instant ? "is-instant" : ""}`} aria-expanded={open === kind} aria-controls={listId} disabled={!rows} onClick={(e) => { setInstant(e.detail === 0); setOpen((o) => (o === kind ? null : kind)); }}>
        <span className="moment__l">{label}</span><b className="moment__v num">{won} of {played}</b>
      </button>
    )
  );
  return (
    <Card title="Clutches, multi-kills and opening duels" aside={<span className="meta">{plural(list.length, "match", "matches")}</span>}>
      <div className="moments">
        {clutchTile("1v1", "1v1 won", won1, played1)}
        {clutchTile("1vN", "1v2+ won", wonN, playedN)}
        <div className="moment"><span className="moment__l">3 kills</span><b className="moment__v num">{plural(k(3), "round")}</b></div>
        <div className="moment"><span className="moment__l">4 kills</span><b className="moment__v num">{plural(k(4), "round")}</b></div>
        {k(5) > 0 && <div className="moment"><span className="moment__l">Aces</span><b className="moment__v num">{plural(k(5), "round")}</b></div>}
        <div className="moment"><span className="moment__l">Opening duels</span><b className="moment__v num">{m.openingKills} won, {m.openingDeaths} lost</b></div>
      </div>
      <div id={listId} hidden={!open}>
        {open && (
          <ul className="clutchlist" aria-label={open === "1v1" ? "Your 1v1 clutches" : "Your 1v2 to 1v5 clutches"}>
            {shown.map((c) => <ClutchLink key={`${c.file}|${c.round}`} c={c} e={byFile.get(c.file)} />)}
          </ul>
        )}
      </div>
    </Card>
  );
}

function ClutchLink({ c, e }: { c: ClutchRow; e: MatchEntry | undefined }) {
  return (
    <li>
      <a href={matchHref(c.file, "rounds", { round: c.round })} className="clutchlist__a">
        <span className={`clutchlist__res ${c.won ? "is-won" : ""}`}>{c.won ? "Won" : "Lost"}</span>
        <span>1v{c.opponents} on <span className={c.side === "T" ? "t-text" : "ct-text"}>{c.side}</span></span>
        <span className="meta">{e ? `${mapName(e.match.map)}, ${fmtMatchDay(e.match)}` : ""}</span>
        <span className="meta num">Round {c.round}</span>
      </a>
    </li>
  );
}

// ---------------------------------------------------------------- what goes with winning

const CORR = ["adr", "kast", "kpr", "swing"];

/**
 * Four small multiples, one per rating input: each match's value against its rating, a filled dot for
 * a win. The r is the engine's correlation of the value with winning the match (winCorrelation).
 */
export function WinCorrelation({ q, list }: { q: Query; list: MatchEntry[] }) {
  const corr = useCall("winCorrelation", [q, CORR]).data;
  const rated = list.filter((e) => e.line.rating !== null);
  if (!corr || rated.length < 3) return null;
  return (
    <Card title="What moves your rating" aside={<span className="meta">{plural(rated.length, "rated match", "rated matches")} · filled dot = won</span>}
      foot={<span>With {rated.length} matches these show which numbers travel together, not cause and effect. Each point is one match.</span>}>
      <div className="smult">
        {CORR.map((id) => <Scatter key={id} id={id} list={rated} r={corr[id]} />)}
      </div>
    </Card>
  );
}

function Scatter({ id, list, r }: { id: string; list: MatchEntry[]; r: { r: number; n: number } | null }) {
  const m = metric(id);
  const pts = list.flatMap((e) => (e.line.v[id] === null || e.line.v[id] === undefined ? [] : [{ x: e.line.v[id]!, y: e.line.rating!, won: e.result === "W", e }]));
  if (pts.length < 2) return null;
  const W = 220, H = 120, P = 8;
  const x0 = Math.min(...pts.map((p) => p.x)), x1 = Math.max(...pts.map((p) => p.x));
  const y1 = Math.max(1.05, ...pts.map((p) => p.y)) * 1.05;
  const X = (v: number) => P + ((v - x0) / (x1 - x0 || 1)) * (W - 2 * P);
  const Y = (v: number) => H - P - (Math.max(0, v) / y1) * (H - 2 * P);
  return (
    <figure className="smult__fig">
      <figcaption>
        <b>{m.label}</b><span className="meta">against rating</span>
        {r && <span className="smult__r num" tabIndex={0} data-tip={`How closely ${m.label} per match goes with winning it: Pearson r over ${plural(r.n, "match", "matches")}. 1 is perfect, 0 is none.`}>r = {signed(r.r, 2)} with wins</span>}
      </figcaption>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label={`${m.label} against rating per match: ${pts.map((p) => `${fmtMetric(id, p.x)} and ${p.y.toFixed(2)}, ${p.won ? "won" : "lost"}`).join("; ")}`}>
        <line x1={P} x2={W - P} y1={Y(1)} y2={Y(1)} stroke="var(--line2)" strokeDasharray="3 3" />
        {pts.map((p) => <circle key={p.e.file} cx={X(p.x)} cy={Y(p.y)} r="4" fill={p.won ? "var(--cream)" : "transparent"} stroke="var(--cream)" strokeWidth="1.5" />)}
      </svg>
      <small className="faint">{fmtMetric(id, x0)} to {fmtMetric(id, x1)} · dashed line: rating 1.00</small>
    </figure>
  );
}

// ---------------------------------------------------------------- by what you bought

const BUY_ROW: Record<BuyClass, string> = { pistol: "Pistol rounds", eco: "Eco (under $1,000 a player)", half: "Force and half buys", full: "Full buys" };

/** Your rounds split by your own buy: the pistol and eco splits and how far you push on each buy. */
export function ByBuy({ q, you, cmp }: { q: Query; you: Rolled; cmp: CompareResult | null }) {
  const res = useCall("buySplits", [q]).data;
  if (!res) return <Card title="By what you bought"><div className="skel" style={{ height: 180 }} /></Card>;
  const rows = BUY_CLASSES.flatMap((c) => { const s = res.own[c]; return s && s.m.rounds ? [{ c, s }] : []; });
  const pushed = rows.some((r) => r.s.v.pushDepth !== null && r.s.v.pushDepth !== undefined);
  const maxPush = Math.max(1, ...rows.map((r) => r.s.v.pushDepth ?? 0));
  const mark = (id: string) => (metric(id).status === "approx" ? <ApproxMark /> : null);
  return (
    <Card title="By what you bought" flush aside={<span className="meta">{plural(you.m.rounds, "round")}</span>}
      foot={pushed ? undefined : <span>How far you pushed needs every player's position at freeze end, which these matches don't store.</span>}>
      <div className="tbl-wrap">
        <table className="tbl bybuy">
          <thead>
            <tr>
              <th className="l"><span className="th">Your buy</span></th>
              <th><span className="th">Rounds</span></th>
              <th><span className="th" data-tip={metric("rating3").def}>{RATING_LABEL}{mark("rating3")}</span></th>
              <th><span className="th">ADR</span></th>
              <th><span className="th" data-tip={metric("openingAttempts").def}>Opening attempts{mark("openingAttempts")}</span></th>
              {pushed && <th className="l"><span className="th" data-tip={metric("pushDepth").def}>How far you pushed{mark("pushDepth")}</span></th>}
            </tr>
          </thead>
          <tbody>
            {rows.map(({ c, s }) => {
              const r = s.v.rating3;
              return (
                <tr key={c}>
                  <td className="l"><b>{BUY_ROW[c]}</b></td>
                  <td className="num">{s.m.rounds}</td>
                  <td><b className="num" style={{ color: r === null ? undefined : ratingText(r) }}>{fmtRating(r)}</b></td>
                  <td className="num">{fmtAdr(s.v.adr)}</td>
                  <td><Num v={fmtMetric("openingAttempts", s.v.openingAttempts)} /></td>
                  {pushed && (
                    <td className="l">
                      <span className="bybuy__push"><Num v={fmtPct(s.v.pushDepth, 0)} /><span className="hbar" aria-hidden><i style={{ width: `${(100 * (s.v.pushDepth ?? 0)) / maxPush}%` }} /></span></span>
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="bybuy__slot">
        {/* save conversion: performance; a small sample (under about 20 saves) carries a provisional chip */}
        <MetricSlot id="saveConversion" values={you.v} ranks={cmp?.p ?? null} kind="performance" population={cmp ? proPoolName(cmp.role) : "pros"}
          sample={plural(you.m.saves, "save")} provisional={you.m.saves < SAVES_SETTLED ? plural(you.m.saves, "save") : undefined} />
      </div>
    </Card>
  );
}

/** About 20 saves before save conversion reads as settled: the design brief's figure; no data run picked it. */
const SAVES_SETTLED = 20;
