// Home: the last match as the hero, form, headline stats with trends, recent matches, highlights
// from the data, and the two performance numbers to work on.
import { useMemo, useState } from "react";
import type { Rating3 } from "../../stats/rating3";
import type { Query, Rolled } from "../../worker/protocol";
import { ClutchBadge, Delta, MapThumb, MultiBadge, Num, ScoreCell, SourceBadge } from "../components/bits";
import { Card } from "../components/Card";
import { FormBars } from "../components/charts";
import { DataTable } from "../components/DataTable";
import { MapAtmosphere } from "../components/MapArt";
import { openMenu, copyText } from "../components/overlay";
import { AgentImg } from "../components/Agent";
import { attrsOf, clutchRows, entryLine, entryRating, careerEntries, fmtMetric, lineOf, multiKillRows, proPopulation, rankText, ratingHeadline } from "../data/engine";
import { useCall, useMatch, useRatings, useRollups, useYourQuery } from "../data/hooks";
import { metric, metrics } from "../data/meta";
import { killSwing, roundMatrix, type MatchEntry } from "../data/match";
import { useData } from "../data/provider";
import { sourceOf } from "../data/sources";
import { seriesOf, tileDelta, tileValue, TILES } from "../data/series";
import { ATTR_ICON, AttrIcon } from "../icons/attributes";
import { FirstKillIcon, SkullIcon, WeaponIcon, WinIcon } from "../icons/game";
import { firstOfDay, insideFences } from "../lib/form";
import { ChevronRightIcon } from "../icons/ui";
import { fmtAdr, fmtMatchDay, matchDayKey, fmtDec, fmtDuration, fmtPct, fmtRating, fmtSwing, fmtWhen, mapName, plural, signed } from "../lib/format";
import { roundSwingScore, scoreFill, scoreText, swingScore, ratingText, toScore } from "../lib/scale";
import { BENCH, verdictOf } from "../lib/verdict";
import { matchHref, openMatch, pageHref, profileHref, tabSectionHref } from "../router";
import { RatingTerms } from "./profile/parts";
import { TAB_METRICS } from "./profile/tabs";
import { BarContent } from "../shell/Bar";
import { useScope } from "../shell/filters";
import { BreakRows, Empty, NeedsDemo, SectionAside, StatTile, swingSumTip } from "./shared";
import { RoundRail } from "./match/RoundRail";
import type { AttributeId } from "../data/proPack";

/** Your totals over the filtered matches: both sides, T and CT, the pooled rating, and their query. */
interface Totals { q: Query; both: Rolled; t: Rolled; ct: Rolled; rating: Rating3 }

function useTotals(list: MatchEntry[]): Totals | null {
  const q = useYourQuery(list);
  const qs = useMemo(() => (q ? [q, { ...q, filter: { ...q.filter, sides: ["T" as const] } }, { ...q, filter: { ...q.filter, sides: ["CT" as const] } }] : null), [q]);
  const s = useRollups(qs).data;
  const r = useRatings(useMemo(() => (q ? [q] : null), [q])).data;
  return q && s?.length === 3 && r ? { q, both: s[0], t: s[1], ct: s[2], rating: r[0].both } : null;
}

export function HomeView() {
  const { matches, status } = useData();
  const { map, n } = useScope();
  const list = useMemo(() => {
    const f = careerEntries(matches, map);
    return n ? f.slice(0, n) : f;
  }, [matches, map, n]);
  const last = list[0] ?? null;
  const t = useTotals(list);

  if (status !== "ready" && !matches.length) {
    return (
      <div className="view view--capped"><div className="view__in home">
        <div className="skel" style={{ height: 248 }} />
        <div className="tiles">{Array.from({ length: 9 }, (_, i) => <div key={i} className="skel" style={{ height: 112 }} />)}</div>
      </div></div>
    );
  }
  return (
    <div className="view view--capped">
      <BarContent crumbs={[{ label: "Home" }]} scope={{ controls: ["map", "matches"] }} />
      <div className="view__in home">
        {!last ? (
          <Card><Empty icon={<WinIcon how="elim" size={40} />} text="No matches yet. Play a match with the capture plugin loaded, or import a match file in Data & settings." action={<a className="btn" href={pageHref("settings")}>Open Data & settings</a>} /></Card>
        ) : (
          <>
            <div className="home__top">
              <LastMatch s={last} list={list} t={t} />
              <FormCard list={list} />
            </div>
            <Tiles list={list} t={t} />
            <div className="home__cols">
              <RecentMatches list={list} />
              <div className="home__side">
                <Highlights list={list} last={last} t={t} />
                <WorkOn t={t} latest={last?.file ?? null} />
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- last match hero

function LastMatch({ s, list, t }: { s: MatchEntry; list: MatchEntry[]; t: Totals | null }) {
  const v = useMatch(s.file).data;
  const line = entryLine(s);
  const avg = t ? lineOf(t.both, t.rating.value) : null;
  const src = sourceOf(s);
  const swing = line.swing;
  const verdict = verdictOf(line.rating, BENCH.rating);
  const half = (side: "T" | "CT") => (v ? v.rounds.filter((r) => r.usSide === side && r.winner === "us").length : null);
  const other = s.usStartSide === "T" ? "CT" : "T";
  // This match against your average over the filtered matches, the average named beside it ("vs your
  // 99.0"). The tiles below carry the same comparison as a bare delta.
  const stat = (label: string, value: string, mine: number | null, avgV: number | null | undefined, fmtAvg: (x: number) => string, span: number, fmtD: (x: number) => string, color?: string, tip?: string) => (
    <div className="hero-stat">
      <span className="stat__l">{label}</span>
      <b className="num" style={color ? { color } : undefined} data-tip={tip}><Num v={value} /></b>
      {mine !== null && avgV !== null && avgV !== undefined && (
        <span className="hero-stat__d"><Delta d={mine - avgV} span={span} fmt={fmtD} /><span className="hero-stat__vs">vs your {fmtAvg(avgV)}</span></span>
      )}
    </div>
  );
  const avgDiff = avg ? avg.diff / Math.max(1, list.length) : null;
  return (
    <section className="hero card" aria-label="Last match">
      <MapAtmosphere map={s.match.map} />
      <AgentImg className="hero__agent" side={s.usStartSide === "T" ? "t" : "ct"} kind="portrait" />
      <div className="hero__in">
        <div className="hero__meta">
          <span className="caps">Last match</span>
          <span className="hero__map"><MapThumb map={s.match.map} size={22} /><b>{mapName(s.match.map)}</b></span>
          <span className="meta">{fmtWhen(s.match)}</span>
          {s.match.durationS !== null && <span className="meta">{fmtDuration(s.match.durationS)}</span>}
          <SourceBadge s={src} />
        </div>
        <div className="hero__score" data-vt="score">
          <span className={`hero__n ${s.result === "W" ? "cream" : "faint"}`}>{s.score.us}</span>
          <span className="hero__res">
            <span className={`res res--${s.result}`}>{s.result === "W" ? "Win" : s.result === "L" ? "Loss" : "Tie"}</span>
            {v && <span className="hero__halves num"><span className={s.usStartSide === "T" ? "t-text" : "ct-text"}>{half(s.usStartSide)}</span><span className="faint">/</span><span className={other === "T" ? "t-text" : "ct-text"}>{half(other)}</span></span>}
          </span>
          <span className={`hero__n ${s.result === "L" ? "cream" : "faint"}`}>{s.score.them}</span>
        </div>
        <div className="hero__stats">
          <div className="hero-stat hero-stat--big">
            <span className="stat__l">{ratingHeadline()}</span>
            <b className="num" style={{ color: ratingText(line.rating ?? 1) }}>{fmtRating(line.rating)}</b>
            <span className="verdict" data-v={verdict}>{verdict === "good" ? "Good" : verdict === "poor" ? "Poor" : "Average"}</span>
          </div>
          {stat("Swing", fmtSwing(swing), swing === null ? null : 100 * swing, avg?.swing == null ? null : 100 * avg.swing, (x) => fmtSwing(x / 100), 3, (x) => `${x.toFixed(2)}%`, swing === null ? undefined : scoreText(swingScore(swing)), swingSumTip(line.m))}
          {stat("K–D", `${line.kills}–${line.deaths}`, line.diff, avgDiff, (x) => `${signed(x, 1)} K–D`, 8, (x) => x.toFixed(1))}
          {stat("ADR", fmtAdr(line.adr), line.adr, avg?.adr, fmtAdr, 20, (x) => x.toFixed(1))}
          {stat("KAST", fmtPct(line.kast), line.kast, avg?.kast, (x) => fmtPct(x), 10, (x) => `${x.toFixed(1)}%`)}
          {stat("HS%", fmtPct(line.hs), line.hs, avg?.hs, (x) => fmtPct(x), 15, (x) => `${x.toFixed(1)}%`)}
        </div>
        {v && <div className="hero__rail"><RoundRail v={v} compact selected={null} onPick={(number) => openMatch(matchHref(s.file, "rounds", { round: number }))} /></div>}
        <div className="hero__actions">
          <button className="btn btn--primary press" onClick={(e) => openMatch(matchHref(s.file), e.currentTarget.closest(".hero"))}>Open match <ChevronRightIcon size={14} /></button>
          <a className="btn btn--ghost" href={matchHref(s.file, "rounds")}>Rounds</a>
          <a className="btn btn--ghost" href={matchHref(s.file, "economy")}>Economy</a>
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- form

function FormCard({ list }: { list: MatchEntry[] }) {
  const [noOutliers, setNoOutliers] = useState(false);
  const [noFirst, setNoFirst] = useState(false);
  const firsts = useMemo(() => firstOfDay(list.map((e) => ({ file: e.file, date: matchDayKey(e.match) }))), [list]);
  let pool = list.slice(0, 10).reverse().filter((s) => entryRating(s) !== null);
  if (noFirst) pool = pool.filter((s) => !firsts.has(s.file));
  const keep = insideFences(pool.map((s) => entryRating(s)!));
  const shown = noOutliers ? pool.filter((_, i) => keep.has(i)) : pool;
  const hidden = list.slice(0, 10).length - shown.length;
  // the same pooled rating as the Rating 3.0 tile when Form shows the same matches; otherwise say which
  const same = shown.length === list.length;
  // the reference line is the pooled rating of the matches shown, the same definition as the profile
  const q = useYourQuery(shown);
  const avg = useRatings(useMemo(() => (q ? [q] : null), [q])).data?.[0].both.value ?? null;
  const w = shown.filter((s) => s.result === "W").length;
  return (
    <Card title="Form" aside={<SectionAside label={same ? "Pooled" : `Pooled, ${plural(shown.length, "match", "matches")} shown`} value={fmtRating(avg)} color={avg === null ? undefined : ratingText(avg)} />} className="form-card">
      <FormBars
        avgValue={avg}
        avgLabel="pooled"
        height={176}
        bars={shown.map((s) => ({
          key: s.file, value: entryRating(s), label: fmtMatchDay(s.match), sub: s.result, result: s.result,
          onClick: () => openMatch(matchHref(s.file)), tip: `${mapName(s.match.map)} ${s.score.us}:${s.score.them}, ${fmtMatchDay(s.match)}: ${fmtRating(entryRating(s))}${firsts.has(s.file) ? ", first match of the day" : ""}`,
        }))}
      />
      <div className="form-card__toggles">
        <label className="check" data-tip="Leaves out ratings more than 1.5 interquartile ranges beyond the middle half"><input type="checkbox" checked={noOutliers} onChange={(e) => setNoOutliers(e.target.checked)} /><span>Hide outliers</span></label>
        <label className="check" data-tip="Leaves out the first match you played each day, often a warm-up"><input type="checkbox" checked={noFirst} onChange={(e) => setNoFirst(e.target.checked)} /><span>Skip first game of the day</span></label>
        {hidden > 0 && <span className="meta">{plural(hidden, "match", "matches")} hidden</span>}
      </div>
      <div className="form-card__foot">
        <span><b className="num">{w}</b><span className="faint">–</span><b className="num">{shown.length - w}</b> <span className="meta">in {plural(shown.length, "match", "matches")}</span></span>
        <span className="meta">Bars grow from 1.00</span>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------- tiles

function Tiles({ list, t }: { list: MatchEntry[]; t: Totals | null }) {
  const aimMatches = list.filter((e) => e.hasAim).length;
  const visibility = list.some((e) => e.match.visibility === "ok");
  return (
    <div className="tiles" role="list" aria-label="Headline stats">
      {TILES.filter((m) => !m.visibility || visibility).map((m) => {
        const value = tileValue(m, t?.both.v ?? null, t?.rating.value ?? null);
        const series = seriesOf(m, list.slice(0, 10));
        const noAim = !!m.aim && !aimMatches;
        // the last match against the value over the filter, as the hero compares them; none when either is missing
        const d = noAim ? null : tileDelta(m, list[0] ?? null, value);
        const breakdown = m.id === "rating3" ? () => {
          const x = t?.rating.inputs;
          return x ? <RatingTerms inputs={x} /> : null;
        } : m.id === "kast" ? () => (t ? <KastSplit s={t.both} /> : null) : m.id === "adr" || m.id === "kpr" ? () => {
          if (!t) return null;
          const f = (s: Rolled) => fmtMetric(m.id, s.v[m.id]);
          return <BreakRows rows={[{ label: <span className="t-text">T side</span>, value: f(t.t) }, { label: <span className="ct-text">CT side</span>, value: f(t.ct) }, { label: "Rounds", value: `${t.t.m.rounds} T, ${t.ct.m.rounds} CT` }]} />;
        } : m.aim && aimMatches ? () => <p className="meta">From {plural(aimMatches, "recorded match", "recorded matches")}.</p> : undefined;
        return (
          <div role="listitem" key={m.id}>
            <StatTile
              label={m.label}
              value={noAim || value === null ? "–" : m.fmt(value)}
              raw={value}
              bench={m.bench}
              def={metric(m.id).def}
              spark={series.map((x) => x.v)}
              delta={d === null ? undefined : <><span className="sr-only">Last match against your average: {d > 0 ? "up" : d < 0 ? "down" : "level"} </span><Delta d={d} span={m.deltaSpan} lowerIsBetter={m.lowerIsBetter} fmt={m.fmtDelta} title="Last match against your average" /></>}
              sub={noAim ? <NeedsDemo detail={`${m.label} needs shots, which converted logs do not record.`} /> : undefined}
              breakdown={breakdown}
            />
          </div>
        );
      })}
      {!visibility && (
        <div role="listitem">
          <div className="tile tile--gated">
            <div className="tile__top"><span className="stat__l">Reaction, time to damage</span></div>
            <div className="tile__v tile__v--muted">–</div>
            <div className="tile__sub"><NeedsDemo detail="These timings need view angles and line of sight to each enemy, which plugin match files do not carry." /></div>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * What KAST is made of: the engine credits each KAST round once, to a kill before an assist before
 * survival before a traded death, so the four shares of rounds add up to KAST.
 */
function KastSplit({ s }: { s: Rolled }) {
  const m = s.m;
  if (!m.rounds) return null;
  const part = (n: number) => ({ value: fmtPct((100 * n) / m.rounds), share: n / m.rounds });
  return (
    <>
      <BreakRows rows={[
        { label: "Rounds with a kill", ...part(m.killRounds), color: "var(--cream)" },
        { label: "With an assist, no kill", ...part(m.kastA), color: "var(--tan)" },
        { label: "Survived, no kill or assist", ...part(m.kastS), color: "var(--ink2)" },
        { label: "Death traded, nothing else", ...part(m.kastT), color: "var(--ink3)" },
        { label: "Rounds survived", ...part(m.survived), color: "var(--tan)" },
        { label: "Deaths traded", value: fmtMetric("deathsTradedPct", s.v.deathsTradedPct), share: s.v.deathsTradedPct === null ? 0 : s.v.deathsTradedPct / 100, color: "var(--ink2)" },
        { label: "Assists per round", value: fmtDec(m.assists / m.rounds) },
      ]} />
      <p className="meta">Each KAST round counts once, in that order, so the first four add up to KAST. Deaths traded is a share of your deaths, not of rounds.</p>
    </>
  );
}

// ---------------------------------------------------------------- recent matches

function RecentMatches({ list }: { list: MatchEntry[] }) {
  const rows = list.slice(0, 8);
  const lines = useMemo(() => new Map(rows.map((s) => [s.file, entryLine(s)])), [list]); // eslint-disable-line react-hooks/exhaustive-deps
  const line = (s: MatchEntry) => lines.get(s.file)!;
  return (
    <Card title="Recent matches" aside={<a href={pageHref("matches")} className="link">All {plural(list.length, "match", "matches")} <ChevronRightIcon size={12} /></a>} flush>
      <DataTable
        label="Recent matches"
        rows={rows}
        rowKey={(s) => s.file}
        defaultSort={null}
        onOpen={(s) => openMatch(matchHref(s.file), document.querySelector(`[data-file="${CSS.escape(s.file)}"]`)?.closest("tr"))}
        onRowContext={(s, at) => openMenu(at, [{ label: "Open", run: () => openMatch(matchHref(s.file)) }, { label: "Open rounds", run: () => openMatch(matchHref(s.file, "rounds")) }, { label: "Copy file name", run: () => copyText(s.file, "File name copied") }])}
        columns={[
          { key: "map", label: "Map", align: "l", sort: (s) => s.match.map, render: (s) => <span className="mapcell" data-file={s.file}><MapThumb map={s.match.map} size={24} /><span className="two"><b data-vt="map">{mapName(s.match.map)}</b><small>{fmtMatchDay(s.match)}</small></span></span> },
          { key: "score", label: "Score", align: "l", sort: (s) => s.score.us - s.score.them, render: (s) => <span data-vt="score"><ScoreCell us={s.score.us} them={s.score.them} result={s.result} /></span> },
          { key: "kd", label: "K–D", sort: (s) => line(s).diff, render: (s) => <span className="num">{line(s).kills}–{line(s).deaths}</span> },
          { key: "adr", label: "ADR", sort: (s) => line(s).adr, render: (s) => fmtAdr(line(s).adr) },
          { key: "swing", label: "Swing", colored: true, sort: (s) => line(s).swing, render: (s) => { const x = line(s).swing; return <span style={{ color: x === null ? undefined : scoreText(swingScore(x)) }} data-tip={swingSumTip(s.line.m)}>{fmtSwing(x)}</span>; } },
          { key: "rating", label: "Rating", colored: true, sort: (s) => entryRating(s), render: (s) => <b style={{ color: ratingText(entryRating(s)) }}>{fmtRating(entryRating(s))}</b> },
        ]}
        rowClass={() => undefined}
      />
    </Card>
  );
}

// ---------------------------------------------------------------- highlights

function Highlights({ list, last, t }: { list: MatchEntry[]; last: MatchEntry; t: Totals | null }) {
  const v = useMatch(last.file).data;
  // the round where your swing was highest, kills breaking ties
  const best = useMemo(() => {
    if (!v) return null;
    const cells = roundMatrix(v)[v.human].filter((c) => !c.empty);
    const score = (c: (typeof cells)[number]) => (c.swing ?? 0) * 100 + c.kills.length * 0.01;
    return cells.reduce<(typeof cells)[number] | null>((b, c) => (!b || score(c) > score(b) ? c : b), null);
  }, [v]);
  const bigKill = useMemo(() => {
    if (!v) return null;
    let top: { n: number; swing: number; weapon: string; victim: string; hs: boolean } | null = null;
    for (const r of v.rounds) for (const k of r.kills) {
      if (k.killer !== v.human || !k.enemy) continue;
      const sw = killSwing(k, v.human);
      if (sw !== null && (!top || sw > top.swing)) top = { n: r.number, swing: sw, weapon: k.weapon, victim: v.players[k.victim].name, hs: k.headshot };
    }
    return top;
  }, [v]);
  const m = t?.both.m;
  const clutches = m ? clutchRows(m).filter((r) => r.played > 0) : [];
  const mk = m ? multiKillRows(m) : [];
  const open = t ? t.both.v.openingSuccess : null;
  return (
    <Card title="Highlights" aside={<span className="meta">{plural(list.length, "match", "matches")}</span>}>
      <div className="hl">
        <a className="hl__item hl__item--feature" href={best && v ? matchHref(last.file, "rounds", { round: v.rounds[best.ri].number }) : undefined}>
          <span className="caps">Best round, last match</span>
          {best && v ? (
            <>
              <span className="hl__row">
                <b className="hl__big">Round {v.rounds[best.ri].number}</b>
                {best.swing !== null && <b className="num hl__big" style={{ color: scoreText(roundSwingScore(best.swing)) }}>{fmtSwing(best.swing)}</b>}
                <ChevronRightIcon size={12} className="faint" />
              </span>
              <span className="hl__feed">
                {best.kills.map((k, i) => (
                  <span key={i} className="hl__kill">
                    <WeaponIcon name={k.weapon} size={11} label={undefined} />
                    <SkullIcon hs={k.headshot} size={11} className={k.headshot ? "skull skull--hs" : "skull"} />
                    <span>{v.players[k.victim].name}</span>
                  </span>
                ))}
              </span>
              <span className="hl__clip" data-tip="Clips of your best moments arrive with the clipping service">Clip coming</span>
            </>
          ) : <span className="meta">No kill-by-kill rounds</span>}
        </a>
        {bigKill && (
          <a className="hl__item" href={matchHref(last.file, "rounds", { round: bigKill.n })}>
            <span className="caps">Biggest kill, last match</span>
            <span className="hl__row">
              <WeaponIcon name={bigKill.weapon} size={13} label={undefined} />
              <span>{bigKill.victim}</span>
              <span className="meta">round {bigKill.n}{bigKill.hs ? ", headshot" : ""}</span>
              <b className="num good-text">{fmtSwing(bigKill.swing)}</b>
            </span>
          </a>
        )}
        <div className="hl__item">
          <span className="caps">Clutches won</span>
          <span className="hl__row">
            {clutches.length ? clutches.map((r) => <span key={r.vs} className="hl__chip"><ClutchBadge vs={r.vs} won={r.won > 0} /><span className="num">{r.won}<span className="faint">/{r.played}</span></span></span>) : <span className="meta">No clutch situations yet</span>}
          </span>
        </div>
        <div className="hl__item">
          <span className="caps">Multi-kill rounds</span>
          <span className="hl__row">{mk.map((r) => <span key={r.k} className="hl__chip"><MultiBadge k={r.k} /><span className="num">{r.rounds}</span></span>)}</span>
        </div>
        <div className="hl__item">
          <span className="caps">Opening duels</span>
          <span className="hl__row">
            <span className="hl__chip"><FirstKillIcon size={13} className="good-text" /><span className="num">{m?.openingKills ?? 0}</span><span className="meta">won</span></span>
            <span className="hl__chip"><FirstKillIcon death size={13} className="poor-text" /><span className="num">{m?.openingDeaths ?? 0}</span><span className="meta">lost</span></span>
            <b className="num">{fmtPct(open)}</b>
          </span>
        </div>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------- work on

/** Profile's hero card stats: a Work on item for one of them opens the card. */
const CARD_STATS = new Set(["kpr", "dpr", "adr", "kast", "mk", "swing"]);
/** The aim metrics Career aim renders (CareerAim.tsx trends, views/aim/AimPanels.tsx); other aim metrics have no place yet. */
const CAREER_AIM = new Set(["accuracy", "firstBulletAccuracy", "headAccuracy", "adjustedAccuracy", "sprayAccuracy", "counterStrafe", "sightAccuracy", "crosshairPlacement", "flickOvershoot", "microCorrections", "reactionTime", "timeToDamage", "timeToShot", "trackingError", "transferHits"]);

/**
 * Where a Work on item opens: the Profile tab that shows the metric. The aim metrics are the Aim
 * tab's; Firepower's metrics are Overview's Firepower card; the hero card's stats are the card above
 * the tabs; the duel, utility and economy rows are those tabs' (profile/tabs.tsx TAB_METRICS);
 * headshot kills are the Weapons tab's per-gun column. Null for a metric nothing shows, which Work on
 * never recommends.
 */
export function workOnHref(m: { id: string; group: string }): string | null {
  if (CAREER_AIM.has(m.id)) return profileHref("aim");
  if (m.group === "firepower") return tabSectionHref("overview", "firepower");
  if (CARD_STATS.has(m.id)) return tabSectionHref("overview", "card");
  if (m.id === "openingSuccess") return tabSectionHref("duels", "openings");
  for (const tab of ["duels", "utility", "economy"] as const) if (TAB_METRICS[tab].includes(m.id)) return profileHref(tab);
  if (m.id === "hs") return profileHref("weapons");
  return null;
}

/**
 * Firepower, the one performance attribute, as main showed its weakest attributes: the score out of 100
 * against pros and its lowest-ranked metric. Then the two performance metrics where you sit lowest among
 * pros, each with its percentile and the pool it was ranked in. Style attributes are left out: they
 * describe how you play, not how well (design/identity.md). A metric the engine could not compare
 * (Percentile.reason) is skipped, never ranked as the lowest, and so is one with no place to open
 * (workOnHref).
 */
function WorkOn({ t, latest }: { t: Totals | null; latest: string | null }) {
  const { baselines } = useData();
  const r = useCall("compare", t && baselines ? [t.q, {}] : null).data;
  const scored = useCall("attributes", t && baselines ? [t.q, {}] : null).data;
  const fire = useMemo(() => {
    const a = scored ? attrsOf(scored.scores).find((x) => x.id === "firepower") : undefined;
    if (!a || a.score === null) return null;
    const worst = a.subs.filter((x) => x.score !== null && !x.reason).sort((x, y) => x.score! - y.score!)[0] ?? null;
    return { label: a.label, score: a.score, worst };
  }, [scored]);
  const weak = useMemo(() => {
    if (!r) return [];
    return metrics().filter((m) => m.kind === "performance" && m.status !== "unavailable" && r.p[m.id] && !r.p[m.id].reason && r.p[m.id].pct !== null && workOnHref(m) !== null)
      .map((m) => ({ m, pct: r.p[m.id].pct!, value: r.p[m.id].value, href: workOnHref(m)!, population: proPopulation(r.p[m.id].pool) }))
      .sort((a, b) => a.pct - b.pct).slice(0, 2);
  }, [r, latest]);
  const icon = (group: string): AttributeId => (group in ATTR_ICON ? (group as AttributeId) : "firepower");
  return (
    <Card title="Work on" aside={<a className="link" href={pageHref("profile")}>Profile <ChevronRightIcon size={12} /></a>}>
      {weak.length === 0 && !fire ? <p className="meta">Not enough rounds to compare with pros.</p> : (
        <div className="workon">
          {fire && (
            <a className="workon__item" href={tabSectionHref("overview", "firepower")} data-tip="Firepower against pros: the mean of its metrics' percentiles. Below it, its lowest-ranked metric.">
              <AttrIcon id="firepower" size={20} className="workon__ico" />
              <div className="workon__body">
                <div className="workon__top"><b>{fire.label}</b><span className="num"><b style={{ color: scoreText(toScore(fire.score, 50, 50)) }}>{Math.round(fire.score)}</b><span className="faint">/100</span></span></div>
                {/* coloured as Profile's Firepower card colours it: unlike main's weakest attributes, Firepower shows here when strong too */}
                <div className="hbar"><i style={{ width: `${fire.score}%`, background: scoreFill(toScore(fire.score, 50, 50)) }} /></div>
                {fire.worst && <div className="meta">{fire.worst.label} <b className="num" style={{ color: "var(--ink)" }}>{fire.worst.text}</b></div>}
              </div>
            </a>
          )}
          {weak.map(({ m, pct, value, href, population }) => (
            <a key={m.id} className="workon__item" href={href} data-tip={m.def}>
              <AttrIcon id={icon(m.group)} size={20} className="workon__ico" />
              <div className="workon__body">
                <div className="workon__top"><b>{m.label}</b><b className="num" style={{ color: scoreText((pct - 50) / 50) }} data-tip="Percentile against pros: the share of pros below you">{rankText(pct)}</b></div>
                <div className="hbar"><i style={{ width: `${pct}%`, background: "var(--poor)" }} /></div>
                <div className="meta">You <b className="num" style={{ color: "var(--ink)" }}>{fmtMetric(m.id, value)}</b>, higher than {Math.round(pct)}% of {population}</div>
              </div>
            </a>
          ))}
        </div>
      )}
    </Card>
  );
}
