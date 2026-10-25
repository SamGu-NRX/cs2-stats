// Home: the last match as the hero, form, headline stats with trends, recent matches, highlights
// computed from the data, and the two attributes to work on.
import { useMemo, useState } from "react";
import { aimVisibility } from "../../stats/aim";
import type { LightSummary } from "../../worker/protocol";
import { ClutchBadge, Delta, MapThumb, MultiBadge, Num, ScoreCell, SourceBadge } from "../components/bits";
import { Card } from "../components/Card";
import { FormBars } from "../components/charts";
import { DataTable } from "../components/DataTable";
import { MapAtmosphere } from "../components/MapArt";
import { openMenu, copyText } from "../components/overlay";
import { AgentImg } from "../components/Agent";
import { attributesFor, countersRating, killSwing, summaryRating, bestRound, clutchRows, counterLine, filterSummaries, multiKillRows, ratingLabel, roundMatrix, weakest } from "../data/engine";
import { useMatchView } from "../data/hooks";
import { useData } from "../data/provider";
import { sourceOfSummary, sourceOfView } from "../data/sources";
import { METRIC_DEFS, ratingParts, seriesOf, totals, valueFor } from "../data/series";
import { AttrIcon } from "../icons/attributes";
import { FirstKillIcon, SkullIcon, WeaponIcon, WinIcon } from "../icons/game";
import { firstOfDay, insideFences } from "../lib/form";
import { ChevronRightIcon } from "../icons/ui";
import { fmtAdr, fmtDate, fmtDuration, fmtPct, fmtRating, fmtSwing, fmtTime, mapName, plural } from "../lib/format";
import { roundSwingScore, scoreText, swingScore, ratingText } from "../lib/scale";
import { BENCH, verdictOf } from "../lib/verdict";
import { matchHref, openMatch, pageHref } from "../router";
import { BarContent } from "../shell/Bar";
import { MapFilter, TimeFilter, useFilters } from "../shell/filters";
import { BreakRows, Empty, SectionAside, StatTile } from "./shared";
import { RoundRail } from "./match/RoundRail";

export function HomeView() {
  const { summaries, status } = useData();
  const { map, n } = useFilters();
  const list = useMemo(() => {
    const f = filterSummaries(summaries, map);
    return n ? f.slice(0, n) : f;
  }, [summaries, map, n]);
  const last = list[0] ?? null;

  if (status !== "ready" && !summaries.length) {
    return (
      <div className="view view--capped"><div className="view__in home">
        <div className="skel" style={{ height: 248 }} />
        <div className="tiles">{Array.from({ length: 9 }, (_, i) => <div key={i} className="skel" style={{ height: 112 }} />)}</div>
      </div></div>
    );
  }
  return (
    <div className="view view--capped">
      <BarContent crumbs={[{ label: "Home" }]} tools={<><MapFilter /><TimeFilter /></>} />
      <div className="view__in home">
        {!last ? (
          <Card><Empty icon={<WinIcon how="elim" size={40} />} text="No matches yet. Play a match with the capture plugin loaded, or import a match file in Data & settings." action={<a className="btn" href={pageHref("settings")}>Open Data & settings</a>} /></Card>
        ) : (
          <>
            <div className="home__top">
              <LastMatch s={last} list={list} />
              <FormCard list={list} />
            </div>
            <Tiles list={list} />
            <div className="home__cols">
              <RecentMatches list={list} />
              <div className="home__side">
                <Highlights list={list} last={last} />
                <WorkOn list={list} all={summaries} />
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- last match hero

function LastMatch({ s, list }: { s: LightSummary; list: LightSummary[] }) {
  const v = useMatchView(s.file).data;
  const t = totals(list);
  const line = counterLine(s.human.c, "both");
  const avg = counterLine(t.c, "both");
  const src = v ? sourceOfView(v) : sourceOfSummary(s);
  const swing = line.swing;
  const verdict = verdictOf(line.rating, BENCH.rating);
  const half = (side: 2 | 3) => (v ? v.rounds.filter((r) => r.usSide === side && r.winner === "us").length : null);
  const stat = (label: string, value: string, d: number | null, span: number, fmtD: (x: number) => string, color?: string) => (
    <div className="hero-stat">
      <span className="stat__l">{label}</span>
      <b className="num" style={color ? { color } : undefined}><Num v={value} /></b>
      <Delta d={d} span={span} fmt={fmtD} title="Against your average over the filtered matches" />
    </div>
  );
  return (
    <section className="hero card" aria-label="Last match">
      <MapAtmosphere map={s.map} />
      <AgentImg className="hero__agent" side={s.usStartSide === 2 ? "t" : "ct"} kind="portrait" />
      <div className="hero__in">
        <div className="hero__meta">
          <span className="caps">Last match</span>
          <span className="hero__map"><MapThumb map={s.map} size={22} /><b>{mapName(s.map)}</b></span>
          <span className="meta">{fmtDate(s.startUtc)}, {fmtTime(s.startUtc)}</span>
          {v && <span className="meta">{fmtDuration(v.startUtc, v.endUtc)}</span>}
          <SourceBadge s={src} />
        </div>
        <div className="hero__score" data-vt="score">
          <span className={`hero__n ${s.result === "W" ? "cream" : "faint"}`}>{s.score.us}</span>
          <span className="hero__res">
            <span className={`res res--${s.result}`}>{s.result === "W" ? "Win" : s.result === "L" ? "Loss" : "Tie"}</span>
            {v && <span className="hero__halves num"><span className={v.usStartSide === 2 ? "t-text" : "ct-text"}>{half(v.usStartSide)}</span><span className="faint">/</span><span className={v.usStartSide === 2 ? "ct-text" : "t-text"}>{half((5 - v.usStartSide) as 2 | 3)}</span></span>}
          </span>
          <span className={`hero__n ${s.result === "L" ? "cream" : "faint"}`}>{s.score.them}</span>
        </div>
        <div className="hero__stats">
          <div className="hero-stat hero-stat--big">
            <span className="stat__l">{ratingLabel(v)}</span>
            <b className="num" style={{ color: ratingText(line.rating ?? 1) }}>{fmtRating(line.rating)}</b>
            <span className="verdict" data-v={verdict}>{verdict === "good" ? "Good" : verdict === "poor" ? "Poor" : "Average"}</span>
          </div>
          {stat("Swing", fmtSwing(swing), swing !== null && avg.swing !== null ? (swing - avg.swing) * 100 : null, 3, (x) => `${x.toFixed(2)}%`, swing === null ? undefined : scoreText(swingScore(swing)))}
          {stat("K–D", `${line.kills}–${line.deaths}`, line.diff - (avg.diff / Math.max(1, list.length)), 8, (x) => x.toFixed(1))}
          {stat("ADR", fmtAdr(line.adr), line.adr !== null && avg.adr !== null ? line.adr - avg.adr : null, 20, (x) => x.toFixed(1))}
          {stat("KAST", fmtPct(line.kast), line.kast !== null && avg.kast !== null ? line.kast - avg.kast : null, 10, (x) => `${x.toFixed(1)}%`)}
          {stat("HS%", fmtPct(line.hs), line.hs !== null && avg.hs !== null ? line.hs - avg.hs : null, 15, (x) => `${x.toFixed(1)}%`)}
        </div>
        {v && <div className="hero__rail"><RoundRail v={v} compact selected={null} onPick={(ri) => openMatch(matchHref(s.file, "rounds", { round: ri + 1 }))} /></div>}
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

function FormCard({ list }: { list: LightSummary[] }) {
  const [noOutliers, setNoOutliers] = useState(false);
  const [noFirst, setNoFirst] = useState(false);
  const firsts = useMemo(() => firstOfDay(list), [list]);
  let pool = list.slice(0, 10).reverse().filter((s) => summaryRating(s) !== null);
  if (noFirst) pool = pool.filter((s) => !firsts.has(s.file));
  const keep = insideFences(pool.map((s) => summaryRating(s)!));
  const shown = noOutliers ? pool.filter((_, i) => keep.has(i)) : pool;
  const hidden = list.slice(0, 10).length - shown.length;
  // the reference line is the pooled rating of the matches shown, the same definition as the profile
  const avg = shown.length ? countersRating(totals(shown).c) : null;
  const w = shown.filter((s) => s.result === "W").length;
  return (
    <Card title="Form" aside={<SectionAside label="Pooled" value={fmtRating(avg)} color={avg === null ? undefined : ratingText(avg)} />} className="form-card">
      <FormBars
        avgValue={avg}
        avgLabel="pooled"
        height={176}
        bars={shown.map((s) => ({
          key: s.file, value: summaryRating(s), label: fmtDate(s.startUtc), sub: s.result, result: s.result,
          onClick: () => openMatch(matchHref(s.file)), tip: `${mapName(s.map)} ${s.score.us}:${s.score.them}, ${fmtDate(s.startUtc)}: ${fmtRating(summaryRating(s))}${firsts.has(s.file) ? ", first match of the day" : ""}`,
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

function Tiles({ list }: { list: LightSummary[] }) {
  const t = totals(list);
  const last = list[0];
  const gate = t.aim ? aimVisibility(t.aim) : null;
  return (
    <div className="tiles" role="list" aria-label="Headline stats">
      {METRIC_DEFS.filter((m) => !(m.gated && gate && !gate.validated)).map((m) => {
        const value = valueFor(m, t.c, t.aim);
        const series = seriesOf(m, list.slice(0, 10));
        const lastV = last ? valueFor(m, last.human.c, last.aim) : null;
        const d = lastV !== null && value !== null ? lastV - value : null;
        const noAim = m.aim && !t.aim;
        const gated = !!m.gated && !!gate && !gate.validated;
        const breakdown = m.id === "rating" ? () => {
          const parts = ratingParts(t.c.r3);
          return parts ? <BreakRows rows={parts.map((p) => ({ label: <>{p.label} <span className="faint">{p.weight && `× ${p.weight}`}</span></>, value: <>{p.value && <span className="faint">{p.value} → </span>}{p.contrib >= 0 ? "+" : "−"}{Math.abs(p.contrib).toFixed(3)}</> }))} /> : null;
        } : m.id === "kast" ? () => <KastSplit list={list} /> : m.id === "adr" || m.id === "kpr" ? () => {
          const tl = counterLine(t.c, "t");
          const ctl = counterLine(t.c, "ct");
          const f = m.id === "adr" ? (x: number | null) => fmtAdr(x) : (x: number | null) => (x === null ? "–" : x.toFixed(2));
          return <BreakRows rows={[{ label: <span className="t-text">T side</span>, value: f(m.id === "adr" ? tl.adr : tl.kpr) }, { label: <span className="ct-text">CT side</span>, value: f(m.id === "adr" ? ctl.adr : ctl.kpr) }, { label: "Rounds", value: `${tl.rounds} T, ${ctl.rounds} CT` }]} />;
        } : m.aim ? () => <p className="meta">{t.aimMatches ? `From ${plural(t.aimMatches, "recorded match", "recorded matches")}.` : "Needs a recorded match."}</p> : undefined;
        return (
          <div role="listitem" key={m.id}>
            <StatTile
              label={m.label}
              value={noAim || gated ? "–" : value === null ? "–" : m.fmt(value)}
              raw={gated ? null : value}
              bench={gated ? undefined : m.bench}
              def={m.def}
              spark={gated ? undefined : series.map((x) => x.v)}
              delta={gated ? <span className="chip chip--outline" data-tip={gate!.reason}>Gated</span> : noAim ? <span className="faint">Recorded matches only</span> : <Delta d={d} span={m.deltaSpan} lowerIsBetter={m.lowerIsBetter} fmt={m.fmtDelta} title="Last match against your average" />}
              breakdown={breakdown}
            />
          </div>
        );
      })}
      {gate && !gate.validated && (
        <div role="listitem">
          <div className="tile tile--gated" data-tip={gate.reason}>
            <div className="tile__top"><span className="stat__l">Reaction, time to damage</span></div>
            <div className="tile__v tile__v--muted">Gated</div>
            <div className="tile__sub">The game's visibility signal misses encounters, so these timings are hidden until the plugin traces line of sight.</div>
          </div>
        </div>
      )}
    </div>
  );
}

/** What KAST is made of. The counters do not record which of K, A, S or T earned each round, so
 *  this shows each ingredient on its own: kill rounds, survival and traded deaths (full rounds). */
function KastSplit({ list }: { list: LightSummary[] }) {
  const t = totals(list);
  const c = t.c;
  if (!c.rounds) return null;
  const killR = c.roundsWithKill / c.rounds;
  const survived = c.aliveRounds ? 1 - c.fullDeaths / Math.max(1, c.fullRounds) : null;
  const traded = c.fullDeaths ? c.tradedDeaths / c.fullDeaths : null;
  return (
    <BreakRows rows={[
      { label: "Rounds with a kill", value: fmtPct(100 * killR), share: killR, color: "var(--cream)" },
      { label: "Rounds survived", value: survived === null ? "–" : fmtPct(100 * survived), share: survived ?? 0, color: "var(--tan)" },
      { label: "Deaths traded", value: traded === null ? "–" : fmtPct(100 * traded), share: traded ?? 0, color: "var(--ink2)" },
      { label: "Assists per round", value: (c.assists / c.rounds).toFixed(2) },
    ]} />
  );
}

// ---------------------------------------------------------------- recent matches

function RecentMatches({ list }: { list: LightSummary[] }) {
  const rows = list.slice(0, 8);
  return (
    <Card title="Recent matches" aside={<a href={pageHref("matches")} className="link">All {plural(list.length, "match", "matches")} <ChevronRightIcon size={12} /></a>} flush>
      <DataTable
        label="Recent matches"
        rows={rows}
        rowKey={(s) => s.file}
        defaultSort={null}
        onOpen={(s) => openMatch(matchHref(s.file), document.querySelector(`[data-file="${CSS.escape(s.file)}"]`)?.closest("tr"))}
        onRowContext={(s, e) => openMenu(e, [{ label: "Open", run: () => openMatch(matchHref(s.file)) }, { label: "Open rounds", run: () => openMatch(matchHref(s.file, "rounds")) }, { label: "Copy file name", run: () => copyText(s.file, "File name copied") }])}
        columns={[
          { key: "map", label: "Map", align: "l", sort: (s) => s.map, render: (s) => <span className="mapcell" data-file={s.file}><MapThumb map={s.map} size={24} /><span className="two"><b data-vt="map">{mapName(s.map)}</b><small>{fmtDate(s.startUtc)}</small></span></span> },
          { key: "score", label: "Score", align: "l", sort: (s) => s.score.us - s.score.them, render: (s) => <span data-vt="score"><ScoreCell us={s.score.us} them={s.score.them} result={s.result} /></span> },
          { key: "kd", label: "K–D", sort: (s) => s.human.c.kills - s.human.c.deaths, render: (s) => <span className="num">{s.human.c.kills}–{s.human.c.deaths}</span> },
          { key: "adr", label: "ADR", sort: (s) => counterLine(s.human.c, "both").adr, render: (s) => fmtAdr(counterLine(s.human.c, "both").adr) },
          { key: "swing", label: "Swing", colored: true, sort: (s) => counterLine(s.human.c, "both").swing, render: (s) => { const x = counterLine(s.human.c, "both").swing; return <span style={{ color: x === null ? undefined : scoreText(swingScore(x)) }}>{fmtSwing(x)}</span>; } },
          { key: "rating", label: "Rating", colored: true, sort: (s) => summaryRating(s), render: (s) => <b style={{ color: ratingText(summaryRating(s)) }}>{fmtRating(summaryRating(s))}</b> },
        ]}
        rowClass={() => undefined}
      />
    </Card>
  );
}

// ---------------------------------------------------------------- highlights

function Highlights({ list, last }: { list: LightSummary[]; last: LightSummary }) {
  const v = useMatchView(last.file).data;
  const t = totals(list);
  const best = v ? bestRound(v, v.human) : null;
  const cell = v && best ? roundMatrix(v)[v.human][best.ri] : null;
  const bigKill = v ? biggestKill(v) : null;
  const clutches = clutchRows(t.c).filter((r) => r.played > 0);
  const mk = multiKillRows(t.c);
  const c = t.c;
  return (
    <Card title="Highlights" aside={<span className="meta">{plural(list.length, "match", "matches")}</span>}>
      <div className="hl">
        <a className="hl__item hl__item--feature" href={best ? matchHref(last.file, "rounds", { round: best.ri + 1 }) : undefined}>
          <span className="caps">Best round, last match</span>
          {best && cell ? (
            <>
              <span className="hl__row">
                <b className="hl__big">Round {best.ri + 1}</b>
                {best.swing !== null && <b className="num hl__big" style={{ color: scoreText(roundSwingScore(best.swing)) }}>{fmtSwing(best.swing)}</b>}
                <ChevronRightIcon size={12} className="faint" />
              </span>
              <span className="hl__feed">
                {cell.kills.map((k, i) => (
                  <span key={i} className="hl__kill">
                    <WeaponIcon name={k.weapon || "ak47"} size={11} label={undefined} />
                    <SkullIcon hs={k.hs} size={11} className={k.hs ? "skull skull--hs" : "skull"} />
                    <span>{k.victim === null ? "" : v!.players[k.victim].name}</span>
                  </span>
                ))}
              </span>
              <span className="hl__clip" data-tip="Clips of your best moments arrive with the clipping service">Clip coming</span>
            </>
          ) : <span className="meta">No kill-by-kill rounds</span>}
        </a>
        {bigKill && (
          <a className="hl__item" href={matchHref(last.file, "rounds", { round: bigKill.ri + 1 })}>
            <span className="caps">Biggest kill, last match</span>
            <span className="hl__row">
              <WeaponIcon name={bigKill.weapon} size={13} label={undefined} />
              <span>{bigKill.victim}</span>
              <span className="meta">round {bigKill.ri + 1}{bigKill.hs ? ", headshot" : ""}</span>
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
            <span className="hl__chip"><FirstKillIcon size={13} className="good-text" /><span className="num">{c.openingKills}</span><span className="meta">won</span></span>
            <span className="hl__chip"><FirstKillIcon death size={13} className="poor-text" /><span className="num">{c.openingDeaths}</span><span className="meta">lost</span></span>
            <b className="num">{c.openingKills + c.openingDeaths ? fmtPct((100 * c.openingKills) / (c.openingKills + c.openingDeaths)) : "–"}</b>
          </span>
        </div>
      </div>
      <p className="meta hl__next">Aggression on eco, force and full buys and how often you save arrive with the metrics update.</p>
    </Card>
  );
}

/** The human's kill with the largest swing credit in a match. */
function biggestKill(v: NonNullable<ReturnType<typeof useMatchView>["data"]>) {
  let best: { ri: number; swing: number; weapon: string; victim: string; hs: boolean } | null = null;
  for (const r of v.rounds) for (const k of r.kills) {
    if (k.killer !== v.human || k.teamKill || k.suicide) continue;
    const sw = killSwing(k, v.human);
    if (sw !== null && (!best || sw > best.swing)) best = { ri: r.ri, swing: sw, weapon: k.weapon, victim: v.players[k.victim].name, hs: (k.flags & 1) !== 0 };
  }
  return best;
}

// ---------------------------------------------------------------- work on

function WorkOn({ list, all }: { list: LightSummary[]; all: LightSummary[] }) {
  const attrs = useMemo(() => attributesFor(totals(list).c, all), [list, all]);
  const weak = weakest(attrs, 2);
  return (
    <Card title="Work on" aside={<a className="link" href={pageHref("profile")}>Attributes <ChevronRightIcon size={12} /></a>}>
      {weak.length === 0 ? <p className="meta">Not enough rounds to score attributes.</p> : (
        <div className="workon">
          {weak.map((a) => (
            <a key={a.id} className="workon__item" href={pageHref("profile", { attr: a.id })}>
              <AttrIcon id={a.id} size={20} className="workon__ico" />
              <div className="workon__body">
                <div className="workon__top"><b>{a.label}</b><span className="num"><b style={{ color: scoreText(((a.score ?? 50) - 50) / 50) }}>{Math.round(a.score!)}</b><span className="faint">/100</span></span></div>
                <div className="hbar"><i style={{ width: `${a.score}%`, background: "var(--poor)" }} /></div>
                {a.worst && <div className="meta">{a.worst.label} <b className="num" style={{ color: "var(--ink)" }}>{a.worst.text}</b></div>}
              </div>
            </a>
          ))}
        </div>
      )}
    </Card>
  );
}
