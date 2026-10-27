// Profile's career cards on #37's calls and #33's luck metrics: the Aim and Utility ratings as
// headline bands, Strongest (top stats), Records (personal bests), Where you rank with its period
// change, the career Luck card, Economy's team-buy tiers and the Aim tab's reloading rows.
// Every number comes from the worker; a card whose call has nothing says why in one line.
import { useId, useMemo, useState, type MouseEvent, type ReactNode } from "react";
import { BEST_COUNTS, COMPOSITES } from "../../../stats/career-lists";
import type { Percentile as Pct, SideKey as PoolSide } from "../../../stats/compare";
import { BUY_TIERS, ECO_BELOW_PER_PLAYER, FORCE_FROM_PER_PLAYER, FULL_FROM_PER_PLAYER, type BuyTier } from "../../../stats/economy";
import type { Measures } from "../../../stats/facts";
import type { Best, CompositeScore, MetricDelta } from "../../../stats/career";
import type { Query, Rolled } from "../../../worker/protocol";
import { MapThumb, Num } from "../../components/bits";
import { Card } from "../../components/Card";
import { GameIcon } from "../../components/GameIcon";
import { MetricList, MetricRow, ShareTrack, THIN } from "../../components/MetricRow";
import { Segmented } from "../../components/controls";
import { fmtMetric } from "../../data/engine";
import { useCall } from "../../data/hooks";
import type { MatchEntry } from "../../data/match";
import { hasMetric, metric } from "../../data/meta";
import { PANEL_TIP, tipOf } from "../../data/tips";
import { fmtAdr, fmtMatchDay, fmtPct, fmtRating, mapName, matchDayKey, plural } from "../../lib/format";
import { scoreFill, scoreText, toScore } from "../../lib/scale";
import { matchHref } from "../../router";
import { NeedsDemo } from "../shared";
import { PanelRow, type PanelMetric } from "./AttributesPanel";
import { fmtLuck, luckHeadline, luckLean, luckSentence } from "../match/luck/model";
import { niceCeil, PERIOD_LABEL, PERIOD_TIP, periodPair, recordsOf, type PeriodKind } from "./career-logic";
import { pctProps } from "./parts";
import { ApproxLegend, RANK_LABELS, RANK_ROWS, Stat, type Ranks } from "./tabs";

// ---------------------------------------------------------------- 0-100 rating bands

/**
 * A 0-100 composite as HLTV's Firepower row: icon, name, its (?), the score over a bar in the
 * performance colours with the pros' middle ticked, opening to its inputs as metric rows. `subs` are
 * sub-scores drawn as thin bars under the main one (Utility's quantity and quality). The head opens
 * it for a pointer; the chevron is its keyboard control, and a keyboard toggle opens instantly.
 */
export function ScoreBand({ icon, title, tip, note, score, parts, subs, message }: {
  icon: ReactNode;
  title: string;
  tip: string;
  note?: string;
  score: number | null;
  parts: PanelMetric[];
  subs?: { label: string; score: number | null; tip: string }[];
  /** one line under the bar: why there is no score */
  message?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [instant, setInstant] = useState(true);
  const id = useId();
  const t = score === null ? 0 : toScore(score, 50, 50);
  const toggle = (e: MouseEvent) => {
    if ((e.target as HTMLElement).closest(".help")) return;
    setInstant(e.detail === 0);
    setOpen((o) => !o);
  };
  return (
    <section className="card cband" aria-label={title}>
      <div className="hatt hatt--wide hatt--perf" data-open={open || undefined}>
        <div className="hatt__head" onClick={toggle}>
          <span className="hatt__icon">{icon}</span>
          <h2 className="hatt__name">{title}</h2>
          <span className="help" data-tip={tip} tabIndex={0} aria-label={`What ${title} means`}>?</span>
          {note ? <span className="hatt__note">{note}</span> : null}
          <span className="hatt__peek" />
          <span className="hatt__score disp" style={score === null ? undefined : { color: scoreText(t) }}>
            {score === null ? "–" : Math.round(score)}<small>/100</small>
          </span>
          <button className={`hatt__chev ${instant ? "is-instant" : ""}`} aria-expanded={open} aria-controls={id} aria-label={`${open ? "Hide" : "Show"} the inputs to ${title}`} />
        </div>
        <div className="hatt__bar" aria-hidden>
          <i style={{ width: `${score ?? 0}%`, ...(score === null ? {} : { background: scoreFill(t) }) }} />
          <span className="hatt__mid" />
        </div>
        {subs && (
          <ul className="cband__subs">
            {subs.map((s) => {
              const st = s.score === null ? 0 : toScore(s.score, 50, 50);
              return (
                <li key={s.label} tabIndex={0} data-tip={s.tip}>
                  <span className="caps">{s.label}</span>
                  <span className="cband__sbar" aria-hidden><i style={{ width: `${s.score ?? 0}%`, ...(s.score === null ? {} : { background: scoreFill(st) }) }} /></span>
                  <b className="num" style={s.score === null ? undefined : { color: scoreText(st) }}>{s.score === null ? "–" : Math.round(s.score)}</b>
                </li>
              );
            })}
          </ul>
        )}
        {message ? <p className="meta cband__msg">{message}</p> : null}
        <div id={id} className={`collapse ${instant ? "is-instant" : ""}`} data-open={open} {...(open ? {} : { inert: "" })}>
          <div className="collapse__in">
            <MetricList label={`${title} inputs`} rank>{parts.map((m) => <PanelRow key={m.id} m={m} rank />)}</MetricList>
          </div>
        </div>
      </div>
    </section>
  );
}

/** "Crosshair placement and Time to damage", "A, B and 2 more": the inputs a composite is missing. */
function namesOf(ids: string[]): string {
  const labels = ids.map((id) => (hasMetric(id) ? metric(id).label : id));
  if (labels.length <= 3) return labels.length === 1 ? labels[0] : `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
  return `${labels.slice(0, 2).join(", ")} and ${labels.length - 2} more`;
}

/** A composite's inputs as metric rows: the composite's own percentile (teammates flashed inverted), the value from the rollup. */
function partRows(c: CompositeScore, values: Rolled["v"] | null, pros: Record<string, Pct> | null, population: string): PanelMetric[] {
  return c.parts.map((x) => {
    const base = pctProps(x.id, pros?.[x.id], values?.[x.id] ?? null);
    const inverted = Object.values(COMPOSITES).some((parts) => parts.some((y) => y.id === x.id && y.invert));
    return {
      id: x.id, ...base, pct: x.pct, kind: "performance" as const, population,
      def: inverted ? `${base.def ?? ""} Counted inverted: fewer is better.`.trim() : base.def,
      reason: x.pct === null ? (base.reason ?? "No pro comparison for this here") : null,
    };
  });
}

export type RatingWhich = "aim" | "utility";

const RATING_TIP: Record<RatingWhich, string> = {
  aim: "Your aim against pros, 0 to 100: the mean percentile of seven aim skills.",
  utility: "Your grenades against pros, 0 to 100: the mean of how much you throw and how well it works.",
};

/**
 * Aim Rating or Utility Rating (careerRatings) for a query and side. `icon` is the tab's own glyph;
 * `values` are the query's metric values on that side, for each input row's value.
 */
export function CareerRatingCard({ which, q, side, values, icon }: { which: RatingWhich; q: Query; side: PoolSide; values: Rolled["v"] | null; icon: ReactNode }) {
  const r = useCall("careerRatings", [q, { side }]);
  const pros = useCall("compare", [q, { side }]).data;
  if (!r.data) return r.error ? <Card title={which === "aim" ? "Aim rating" : "Utility rating"}><p className="meta">{r.error}</p></Card> : <div className="skel" style={{ height: 112 }} />;
  const population = pros ? `${pros.n} ${pros.role === "awper" ? "pro AWPers" : "pro riflers"}` : "pros";
  const p = pros?.p ?? null;
  if (which === "aim") {
    const c = r.data.aimRating;
    return (
      <ScoreBand icon={icon} title="Aim rating" tip={RATING_TIP.aim} note={`vs ${population}`} score={c.score} parts={partRows(c, values, p, population)}
        message={c.score === null && c.missing.length ? <>No score until every input has a pro comparison. {namesOf(c.missing)} {c.missing.length === 1 ? "has" : "have"} none here.</> : undefined} />
    );
  }
  const qn = r.data.utilityQuantity, ql = r.data.utilityQuality;
  const missing = [...qn.missing, ...ql.missing];
  return (
    <ScoreBand icon={icon} title="Utility rating" tip={RATING_TIP.utility} note={`vs ${population}`} score={r.data.utilityRating}
      parts={[...partRows(qn, values, p, population), ...partRows(ql, values, p, population)]}
      subs={[
        { label: "Quantity", score: qn.score, tip: "How many flashes, smokes, HEs and molotovs you throw a round, against pros." },
        { label: "Quality", score: ql.score, tip: "What your grenades do: flash kills, enemies blinded, damage, fire, what you leave unused, and teammates you flash." },
      ]}
      message={r.data.utilityRating === null && missing.length ? <>No score until every input has a pro comparison. {namesOf(missing)} {missing.length === 1 ? "has" : "have"} none here.</> : undefined} />
  );
}

// ---------------------------------------------------------------- strongest and records

/** The five performance metrics where you rank highest among pros (topStats), as ranked metric rows. */
export function TopStatsCard({ q, side, m }: { q: Query; side: PoolSide; m: Measures | null }) {
  const r = useCall("topStats", [q, { side }]);
  const ranks: Ranks | null = useMemo(() => (r.data ? { p: Object.fromEntries(r.data.map((x) => [x.id, x])), bots: "", pros: "", m } : null), [r.data, m]);
  return (
    <Card title="Strongest" tip="Your five stats that rank highest among pros.">
      {!r.data || !ranks ? (r.error ? <p className="meta">{r.error}</p> : <div className="skel" style={{ height: 180 }} />)
        : !r.data.length ? <p className="meta">Not enough rounds to rank any stat against pros.</p>
          : <MetricList label="Strongest stats" rank>{r.data.map((x) => <Stat key={x.id} id={x.id} r={ranks} rank />)}</MetricList>}
    </Card>
  );
}

const COUNT_LABEL = new Map(BEST_COUNTS.map((c) => [c.id, c.label]));
const bestLabel = (id: string) => COUNT_LABEL.get(id) ?? (hasMetric(id) ? metric(id).label.replace(/ \(approx\.\)$/, "") : id);
const bestText = (b: Best) => (COUNT_LABEL.has(b.id) ? String(Math.round(b.value)) : fmtMetric(b.id, b.value));

/** "Set on Dust II.": the record's map in words, for its tooltip. */
const recordMap = (e: MatchEntry | undefined) => (e ? `Set on ${mapName(e.match.map)}. Opens the match.` : null);

/** Where a record was set: the map's emblem, the day and the score ("Oct 24, 13:8"); the map's name is spoken. */
function RecordWhere({ e }: { e: MatchEntry | undefined }) {
  if (!e) return <span className="meta">A match outside this filter</span>;
  return (
    <span className="rec__where">
      <MapThumb map={e.match.map} size={16} />
      <span><span className="sr-only">{mapName(e.match.map)}, </span>{fmtMatchDay(e.match)}, <span className="num">{e.score.us}:{e.score.them}</span></span>
    </span>
  );
}

/**
 * Personal bests (personalBests): the lead records as tiles, each a link to the match it was set in,
 * then every other best behind "All records". A rate's best needs a match of BEST_MIN_ROUNDS rounds.
 */
export function RecordsCard({ q, list }: { q: Query; list: MatchEntry[] }) {
  const r = useCall("personalBests", [q]);
  const [all, setAll] = useState(false);
  const listId = useId();
  const byFile = useMemo(() => new Map(list.map((e) => [e.file, e])), [list]);
  const recs = useMemo(() => (r.data ? recordsOf(r.data) : null), [r.data]);
  return (
    <Card title="Records" tip="Your best single match for each stat. Rates need a match of 10 rounds or more."
      aside={recs ? <span className="meta">{plural(recs.lead.length + recs.rest.length, "record")}</span> : undefined}>
      {!recs ? (r.error ? <p className="meta">{r.error}</p> : <div className="skel" style={{ height: 180 }} />) : !recs.lead.length && !recs.rest.length ? <p className="meta">No match with enough rounds for a record yet.</p> : (
        <>
          <ul className="recs">
            {recs.lead.map((b) => (
              <li key={b.id}>
                <a className="rec" href={matchHref(b.file)} data-tip={[tipOf(b.id) ?? `Most ${bestLabel(b.id).toLowerCase()} in one match.`, recordMap(byFile.get(b.file))].filter(Boolean).join("\n")}>
                  <span className="caps">{bestLabel(b.id)}</span>
                  <b className="disp disp--m rec__v"><Num v={bestText(b)} /></b>
                  <RecordWhere e={byFile.get(b.file)} />
                </a>
              </li>
            ))}
          </ul>
          {recs.rest.length > 0 && (
            <>
              <button className="recs__more" aria-expanded={all} aria-controls={listId} onClick={() => setAll((x) => !x)}>
                {all ? "Hide the other records" : `All records, ${recs.rest.length} more`}<span className="clist__chev" aria-hidden />
              </button>
              {all && (
                <ul id={listId} className="recs__all" aria-label="Other records">
                  {recs.rest.map((b) => (
                    <li key={b.id}>
                      <a href={matchHref(b.file)} className="recs__row">
                        <span>{bestLabel(b.id)}</span>
                        <RecordWhere e={byFile.get(b.file)} />
                        <b className="num"><Num v={bestText(b)} /></b>
                      </a>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------- where you rank, and its change

type RankMode = "rank" | "change";

/** "+2.1 pts", "−0.07": a period's change in the metric's unit; shares move in points. */
export function fmtChange(id: string, d: number): string {
  const sign = d > 0 ? "+" : d < 0 ? "−" : "";
  const abs = fmtMetric(id, Math.abs(d));
  return sign + (metric(id).unit === "pct" ? abs.replace(/%$/, " pts") : abs);
}

const DIR_CLASS: Record<NonNullable<MetricDelta["direction"]>, string> = { better: "good-text", worse: "poor-text", higher: "", lower: "", same: "faint" };

/**
 * Where you rank: the five headline stats against pros, or with Change on, each one over your recent
 * play against the stretch before it (periodCompare). The periods are 7 or 30 days ending on the last
 * day you played, or that day against the one before (career-logic.ts periodPair); a period with no
 * match on either side is disabled with its reason.
 */
export function WhereYouRank({ ranks, q, list }: { ranks: Ranks | null; q: Query; list: MatchEntry[] }) {
  const [mode, setMode] = useState<RankMode>("rank");
  const days = useMemo(() => list.map((e) => matchDayKey(e.match)), [list]);
  const pairs = useMemo(() => Object.fromEntries((["week", "month", "day"] as const).map((k) => [k, periodPair(days, k)])) as Record<PeriodKind, ReturnType<typeof periodPair>>, [days]);
  const first = (["week", "month", "day"] as const).find((k) => pairs[k]) ?? null;
  const [kind, setKind] = useState<PeriodKind | null>(null);
  const k = kind && pairs[kind] ? kind : first;
  const pair = k ? pairs[k] : null;
  const ch = useCall("periodCompare", mode === "change" && pair ? [q, pair.current, pair.previous] : null);
  const rows = useMemo(() => (ch.data ? RANK_ROWS.flatMap((id) => ch.data!.filter((d) => d.id === id)) : null), [ch.data]);
  const approx = RANK_ROWS.some((x) => hasMetric(x) && metric(x).status === "approx");
  return (
    <Card title="Where you rank" tip={PANEL_TIP.whereYouRank} className="wyr"
      aside={(
        <span className="card__aside-row">
          {mode === "rank" && ranks?.pros ? <span className="meta">vs {ranks.pros}</span> : null}
          {mode === "rank" && approx ? <ApproxLegend /> : null}
          <Segmented label="Where you rank shows" value={mode} onChange={setMode}
            options={[{ value: "rank", label: "Rank" }, { value: "change", label: "Change", disabled: !first, tip: first ? "Your recent play against the stretch before it." : "Change needs matches on two different days." }]} />
        </span>
      )}>
      {mode === "rank" ? (
        !ranks ? <div className="skel" style={{ height: 36 * RANK_ROWS.length }} /> : <MetricList label="Where you rank" rank>{RANK_ROWS.map((x) => <Stat key={x} id={x} r={ranks} label={RANK_LABELS[x]} rank />)}</MetricList>
      ) : (
        <>
          <div className="pchg__head">
            <Segmented label="Period" value={k ?? "week"} onChange={setKind}
              options={(["week", "month", "day"] as const).map((x) => ({ value: x, label: PERIOD_LABEL[x], disabled: !pairs[x], tip: pairs[x] ? PERIOD_TIP[x] : `No match in the stretch before your last ${x === "day" ? "day played" : PERIOD_LABEL[x]}.` }))} />
            {pair && <span className="meta">{plural(pair.before, "match", "matches")} before, {pair.now} now</span>}
          </div>
          {!rows ? (ch.error ? <p className="meta">{ch.error}</p> : <div className="skel" style={{ height: 36 * RANK_ROWS.length }} />) : (
            <ul className="pchg" aria-label="Change since the period before">
              <li className="pchg__cols" aria-hidden><span /><span className="caps">Before</span><span /><span className="caps">Now</span><span className="caps">Change</span></li>
              {rows.map((d) => (
                <li key={d.id} className="pchg__row" tabIndex={0} data-tip={tipOf(d.id)}
                  aria-label={`${RANK_LABELS[d.id] ?? metric(d.id).label}: ${fmtMetric(d.id, d.before)} before, ${fmtMetric(d.id, d.value)} now${d.delta === null ? "" : `, ${d.direction ?? ""} by ${fmtChange(d.id, d.delta)}`}`}>
                  <span className="pchg__lab">{RANK_LABELS[d.id] ?? metric(d.id).label}</span>
                  <span className="num pchg__before"><Num v={fmtMetric(d.id, d.before)} /></span>
                  <span className="pchg__arrow" aria-hidden>→</span>
                  <b className="num pchg__now"><Num v={fmtMetric(d.id, d.value)} /></b>
                  <span className={`num pchg__d ${d.direction ? DIR_CLASS[d.direction] : "faint"}`}>{d.delta === null ? "–" : fmtChange(d.id, d.delta)}</span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------- luck

/** The luck metrics that fall your way, and the ones that go against you; a kill flag carries its killfeed icon. */
const LUCK_FOR: { id: string; icon?: string }[] = [
  { id: "closeCalls" }, { id: "lowHpKills" }, { id: "luckyHeadshots", icon: "headshot" }, { id: "runAndGunKills" },
  { id: "blindKills", icon: "blind" }, { id: "airKills", icon: "inair" }, { id: "noscopeKills", icon: "noscope" }, { id: "smokeKills", icon: "smoke" },
];
const LUCK_AGAINST: { id: string; icon?: string }[] = [
  { id: "lowHpDeaths" }, { id: "luckyHeadshotDeaths", icon: "headshot" }, { id: "runAndGunDeaths" }, { id: "flagDeaths" },
];

function LuckRows({ title, rows, v }: { title: string; rows: { id: string; icon?: string }[]; v: Rolled["v"] }) {
  const shown = rows.filter((x) => hasMetric(x.id) && v[x.id] !== null && v[x.id] !== undefined);
  if (!shown.length) return null;
  return (
    <div className="luck__col">
      <h3 className="caps luck__h">{title}</h3>
      <MetricList label={title}>
        {shown.map((x) => (
          <MetricRow key={x.id} label={<span className="luck__lab">{x.icon && <GameIcon id={x.icon} name={metric(x.id).label} width={14} beside />}{metric(x.id).label}</span>}
            value={fmtMetric(x.id, v[x.id])} sample={metric(x.id).unit === "count" ? "per 24 rounds" : null} pct={null} kind="style" population="" tip={tipOf(x.id)} />
        ))}
      </MetricList>
    </div>
  );
}

/**
 * The career's luck (luck.ts LUCK_METRICS over the page's rollup): the luck score in plain words over a
 * lollipop from zero, your lucky hits and the enemies' beside it, then the luck that fell your way and
 * the luck against you. Luck is for fun: nothing here is ranked. Without shot spread (plugin
 * recordings) the score says why and the rows that do not need it stay.
 */
export function LuckCard({ s }: { s: Rolled }) {
  const v = s.v;
  const score = v.luckScore ?? null;
  // the match Luck tab's words and numbers (luck/model.ts), so a match and the career read alike
  const headline = luckHeadline(score);
  const mine = v.luckHits ?? null, theirs = v.luckAgainst ?? null;
  const span = niceCeil(Math.max(1, Math.abs(score ?? 0), Math.abs(mine ?? 0), Math.abs(theirs ?? 0)));
  const at = score === null ? 50 : 50 + (50 * Math.max(-span, Math.min(span, score))) / span;
  return (
    <Card title="Luck" tip="Luck in your matches, for fun: nothing here is ranked." className="luck" aside={<span className="meta">{plural(s.m.rounds, "round")}</span>}>
      {headline !== null && score !== null ? (
        <div className="luck__top" data-lean={luckLean(score)}>
          <div className="luck__head">
            <b className="disp disp--s luck__word">{headline}</b>
          </div>
          <div className="luck__scale" role="img" tabIndex={0} aria-label={`${luckSentence(score)}, on a scale of minus ${span} to plus ${span}.`}
            data-tip={`${tipOf("luckScore") ?? ""}\nA lucky hit is one your bullet spread made unlikely.`.trim()}>
            <span className="luck__axis" />
            <span className="luck__zero" />
            <i className="luck__stem" style={{ left: `${Math.min(50, at)}%`, width: `${Math.abs(at - 50)}%`, transformOrigin: at >= 50 ? "left" : "right" }} />
            <i className="luck__dot" style={{ left: `${at}%`, ["--from" as string]: `${50 - at}` }} />
          </div>
          <div className="luck__ends meta" aria-hidden><span>−{span} enemies' luck</span><span>0</span><span>your luck +{span}</span></div>
          <dl className="luck__figs">
            <div><dt className="caps">Your lucky hits</dt><dd className="num">{fmtLuck(mine)}</dd></div>
            <div><dt className="caps">Theirs on you</dt><dd className="num">{fmtLuck(theirs)}</dd></div>
            <div><dt className="caps">Score</dt><dd className="num luck__score">{fmtLuck(score)}</dd></div>
          </dl>
          <p className="meta luck__unit">Hits per 24 rounds beyond what bullet spread made likely.</p>
        </div>
      ) : (
        <p className="meta luck__none"><NeedsDemo detail="The luck score needs each shot's spread, which plugin recordings do not carry. Imported demos do." /></p>
      )}
      <div className="luck__cols">
        <LuckRows title="Your way" rows={LUCK_FOR} v={v} />
        <LuckRows title="Against you" rows={LUCK_AGAINST} v={v} />
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------- economy: by team buy

const TIER_LABEL: Record<BuyTier, string> = { pistol: "Pistol", eco: "Eco", semiEco: "Semi-eco", force: "Force buy", full: "Full buy" };
/** The pack's economy icons (SYSTEM.md): buyzone for a pistol round, eco_request for the low tiers, money for the bought ones; the label tells same-icon tiers apart. */
const TIER_ICON: Record<BuyTier, string> = { pistol: "buyzone", eco: "eco_request", semiEco: "eco_request", force: "money", full: "money" };
const money = (x: number) => `$${x.toLocaleString("en-US")}`;
const TIER_TIP: Record<BuyTier, string> = {
  pistol: "The first round of each half.",
  eco: `Your team spent under ${money(ECO_BELOW_PER_PLAYER)} a player.`,
  semiEco: `Your team spent ${money(ECO_BELOW_PER_PLAYER)} to ${money(FORCE_FROM_PER_PLAYER)} a player.`,
  force: `Your team spent ${money(FORCE_FROM_PER_PLAYER)} to ${money(FULL_FROM_PER_PLAYER)} a player.`,
  full: `Your team spent ${money(FULL_FROM_PER_PLAYER)} or more a player.`,
};

/**
 * Your numbers by your team's buy (buyTiers): rounds, the share your team won as a lollipop from zero
 * (hollow under THIN rounds), and Rating 3.0, ADR and KAST. A tier without rounds takes no row.
 */
export function BuyTiersCard({ q }: { q: Query }) {
  const r = useCall("buyTiers", [q]);
  const rows = r.data ? BUY_TIERS.flatMap((k) => { const s = r.data![k]; return s && s.m.rounds ? [{ k, s }] : []; }) : null;
  return (
    <Card title="By team buy" tip="Your numbers by how much your team spent at freeze end." flush className="tiers">
      {!rows ? (r.error ? <p className="meta card-pad">{r.error}</p> : <div className="skel" style={{ height: 200 }} />) : !rows.length ? <p className="meta card-pad"><NeedsDemo detail="Buy tiers need every player's equipment." /></p> : (
        <table className="tbl tiers__tbl">
          <thead><tr><th className="l">Team buy</th><th>Rounds</th><th className="l tiers__won" data-tip="Rounds your team won." tabIndex={0}>Won</th><th data-tip={tipOf("rating3")} tabIndex={0}>Rating 3.0</th><th data-tip={tipOf("adr")} tabIndex={0}>ADR</th><th data-tip={tipOf("kast")} tabIndex={0}>KAST</th></tr></thead>
          <tbody>
            {rows.map(({ k, s }) => {
              const won = (100 * s.m.won) / s.m.rounds;
              return (
                <tr key={k}>
                  <td className="l"><span className="tiers__buy has-def" data-tip={TIER_TIP[k]} tabIndex={0}><GameIcon id={TIER_ICON[k]} name={TIER_LABEL[k]} width={16} beside />{TIER_LABEL[k]}</span></td>
                  <td className="num">{s.m.rounds}</td>
                  <td className="l"><span className="tiers__wbar"><ShareTrack value={won} max={100} hollow={s.m.rounds < THIN} /><b className="num"><Num v={fmtPct(won, 0)} /></b></span></td>
                  <td className="num">{fmtRating(s.v.rating3 ?? null)}</td>
                  <td className="num">{fmtAdr(s.v.adr ?? null)}</td>
                  <td className="num"><Num v={fmtPct(s.v.kast ?? null)} /></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------- aim: reloading

/** Weapon handling (#37 handling.ts): how much magazine you throw away and how often you reload, from the clip counts. */
export function ReloadCard({ s }: { s: Rolled | null }) {
  const ids = ["wastedMagazine", "reloadsPR"].filter(hasMetric);
  const any = s && ids.some((id) => s.v[id] !== null && s.v[id] !== undefined);
  return (
    <Card title="Reloading" tip="How you manage your magazine between fights.">
      {!s ? <div className="skel" style={{ height: 72 }} /> : !any ? <p className="meta"><NeedsDemo detail="Reloads need each shot's clip count, which these files do not carry." /></p> : (
        <MetricList label="Reloading">
          {ids.map((id) => (
            <MetricRow key={id} label={metric(id).label} value={s.v[id] === null ? null : fmtMetric(id, s.v[id])} pct={null} kind="style" population="" tip={tipOf(id)} approx={metric(id).status === "approx"}
              sample={id === "reloadsPR" ? (s.m.ammoRounds ? plural(s.m.ammoRounds, "round") : null) : (s.m.reloads ? plural(s.m.reloads, "reload") : null)} n={id === "reloadsPR" ? s.m.ammoRounds : s.m.reloads} />
          ))}
        </MetricList>
      )}
    </Card>
  );
}
