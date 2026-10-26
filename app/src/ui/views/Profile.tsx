// Profile: HLTV's night-mode player card, then two sections: Performance (how well you play: swing,
// how good, rating by match, breakdowns) and Identity (how you play: HLTV's attributes block, Firepower
// first, then the role blend per side and the pro whose style matches yours). The side switch in the
// app bar drives the whole page: every summary is rolled up over that side's rounds. Performance is
// compared with that side's pros; style with the bot careers in the same matches on that side
// (worker/ranking.ts).
import { Fragment, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import type { AttributeScore, Percentile as Pct } from "../../stats/compare";
import type { Measures } from "../../stats/facts";
import type { RoleBlend } from "../../stats/identity";
import type { Rating3 } from "../../stats/rating3";
import { isGun } from "../../stats/guns";
import { weaponClass, weaponLabel } from "../../stats/weapons";
import { ClutchBadge, MapThumb, Meter, MultiBadge, Num, VerdictLabel } from "../components/bits";
import { Card } from "../components/Card";
import { Gauge, TrendLine } from "../components/charts";
import { GameIcon } from "../components/GameIcon";
import { ApproxMark, Percentile } from "../components/Percentile";
import { Select, type Option } from "../components/controls";
import { DataTable } from "../components/DataTable";
import { HoverCard } from "../components/overlay";
import { AgentImg } from "../components/Agent";
import {
  botIds, botPoolName, botPopulation, proPopulation, clutchRows, entryRating, careerEntries, extraSubs, fmtMetric, lineOf, mapsIn, multiKillRows, proPoolName,
  rankText, thinPoolText,
  ratingHeadline, RATING_LABEL, ratingKey, sidesOf, WEAPON_CLASS_LABEL, type SideKey,
} from "../data/engine";
import { bundleOf, useCall, useRatings, useRollups, type Loaded } from "../data/hooks";
import { killsBy, matchModel, sideOf, type MatchEntry } from "../data/match";
import { PANEL_TIP, tipOf } from "../data/tips";
import { useData } from "../data/provider";
import type { AttributeBlock, ClutchRow, Query, Rolled, SideRatings, Values } from "../../worker/protocol";
import { FirstKillIcon, HeadshotIcon, WeaponIcon } from "../icons/game";
import { fmtAdr, fmtMatchDay, fmtDec, fmtPct, fmtRating, fmtSwing, mapName, plural } from "../lib/format";
import { scoreFill, scoreText, toScore, ratingText } from "../lib/scale";
import { BENCH, benchAround, verdictOf, type Bench } from "../lib/verdict";
import { matchHref, openMatch, setQuery, useRoute, useSection } from "../router";
import { BarContent } from "../shell/Bar";
import { useScope } from "../shell/filters";
import { Empty, NeedsDemo, SectionAside } from "./shared";
import { AttributesPanel, ValueRow, type PanelAttribute, type PanelMetric } from "./profile/AttributesPanel";
import { HowGood, pctProps, PlaysLike, RatingLegend, RatingTerms, RoleCard, SectionHead, SwingCard } from "./profile/parts";
import { WhereYouPlay } from "./Playstyle";

type Compare = "bench" | "bots";

/** Everything the page reads, loaded from the worker in two batches. */
interface ProfileData {
  list: MatchEntry[];
  name: string;
  /** you over every kept round, for the identity questions (role, plays like), which pick their sides */
  base: Query;
  /** you on the page's side, bots on it, you on T and on CT */
  you: Rolled;
  bots: Rolled | null;
  t: Rolled;
  ct: Rolled;
  ratings: SideRatings;
  botRatings: SideRatings | null;
  /** each match's rating and swing (a fraction) on the page's side, for the per-match charts */
  perMatch: (e: MatchEntry) => MatchOnSide;
}

/** One match on the page's side: its Rating 3.0 and its swing per round, a fraction; null where it has none. */
export interface MatchOnSide { rating: number | null; swing: number | null }

/**
 * Each career match on the page's side. Both sides is the match entry itself; T or CT rolls up and
 * rates each match on that side (the worker batches the calls). Null while those load.
 */
function usePerMatch(list: MatchEntry[], ids: string[], side: SideKey): ((e: MatchEntry) => MatchOnSide) | null {
  const one = side !== "both";
  const qs = useMemo(() => (one ? list.map((e) => ({ files: [e.file], filter: { player: ids, ...sidesOf(side) } })) : null), [one, list, ids, side]);
  const rq = useMemo(() => (one ? list.map((e) => ({ files: [e.file], filter: { player: ids } })) : null), [one, list, ids]);
  const sums = useRollups(qs).data;
  const rats = useRatings(rq).data;
  return useMemo(() => {
    if (!one) return (e: MatchEntry) => ({ rating: entryRating(e), swing: e.line.v.swing === null ? null : e.line.v.swing / 100 });
    if (!sums || !rats || sums.length !== list.length || rats.length !== list.length) return null;
    const at = new Map(list.map((e, i) => [e.file, i]));
    const key = ratingKey(side);
    return (e: MatchEntry) => {
      const i = at.get(e.file);
      if (i === undefined) return { rating: null, swing: null };
      const sw = sums[i].v.swing;
      return { rating: rats[i][key].value, swing: sw === null ? null : sw / 100 };
    };
  }, [one, sums, rats, list, side]);
}

export default function ProfileView() {
  const { matches, you: ids, baselines, baselinesError } = useData();
  const { map, n, side } = useScope();
  const r = useRoute();
  const [cmp, setCmp] = useState<Compare>(() => (r.query.get("cmp") as Compare) || "bench");
  const list = useMemo(() => { const f = careerEntries(matches, map); return n ? f.slice(0, n) : f; }, [matches, map, n]);
  const bots = useMemo(() => botIds(list), [list]);
  const files = useMemo(() => list.map((e) => e.file), [list]);
  const qs = useMemo((): Query[] | null => (list.length && ids.length ? [
    { files, filter: { player: ids, ...sidesOf(side) } },
    { files, filter: { player: ids, sides: ["T"] } },
    { files, filter: { player: ids, sides: ["CT"] } },
    ...(bots.length ? [{ files, filter: { player: bots, ...sidesOf(side) } }] : []),
  ] : null), [list, files, ids, bots, side]);
  const sums = useRollups(qs);
  // ?sec= links (Home's "Work on", typed links) scroll to their section once it renders (router.ts useSection)
  const identityRef = useSection("identity");
  const styleRef = useSection("style");
  const performanceRef = useSection("performance");
  const firepowerRef = useSection("firepower");
  const howGoodRef = useSection("howgood");
  const cardRef = useSection("card");
  const openingsRef = useSection("openings");
  const rqs = useMemo(() => (qs ? [{ files, filter: { player: ids } }, ...(bots.length ? [{ files, filter: { player: bots } }] : [])] : null), [qs, files, ids, bots]);
  const rats = useRatings(rqs).data;
  const base = useMemo(() => ({ files, filter: { player: ids } }), [files, ids]);
  const perMatch = usePerMatch(list, ids, side);
  const p: ProfileData | null = sums.data && rats && perMatch && sums.data.length === (qs?.length ?? 0) ? {
    list, name: list[0].players[list[0].you].name, base, you: sums.data[0], t: sums.data[1], ct: sums.data[2], bots: bots.length ? sums.data[3] : null,
    ratings: rats[0], botRatings: bots.length ? rats[1] ?? null : null, perMatch,
  } : null;

  if (!p) {
    return (
      <div className="view view--capped">
        <BarContent crumbs={[{ label: "Profile" }]} scope={{ controls: ["map", "matches", "side"] }} />
        <div className="view__in profile">
          {(sums.loading || !matches.length) && !sums.error ? <div className="skel" style={{ height: 340 }} /> : <Card><Empty text={sums.error ?? "No matches in this filter."} /></Card>}
        </div>
      </div>
    );
  }
  return (
    <div className="view view--capped">
      <BarContent crumbs={[{ label: p.name }, { label: "Profile" }]} scope={{ controls: ["map", "matches", "side"] }} />
      <div className="view__in profile" data-side={side}>
        <div className="profile__top psec" id="card" ref={cardRef}>
          <PlayerCard p={p} side={side} cmp={cmp} compare={(
            // what the card's verdicts measure against; it lives on the card it governs
            <Select label="Compared to" prefix="Compared to" value={cmp} onChange={(v) => { setCmp(v); setQuery("cmp", v === "bench" ? null : v); }}
              options={[{ value: "bench", label: "HLTV-style benchmarks" }, { value: "bots", label: `Bots you played (${bots.length})`, disabled: !p.bots }]} />
          )} />
          <FormRail p={p} side={side} />
        </div>
        <SectionHead title="How you play" tip={PANEL_TIP.identity} id="identity" sectionRef={identityRef} />
        <div id="style" ref={styleRef} className="psec"><StyleAttributes q={base} side={side} values={p.you.v} /></div>
        <PlaysLike q={base} side={ratingKey(side)} initial={r.query.get("pro")} />
        <div className="identity">
          <RoleCard q={base} maps={mapsIn(list)} />
          <WhereYouPlay list={list} side={side} />
        </div>
        <SectionHead title="How well you play" tip={PANEL_TIP.performance} id="performance" sectionRef={performanceRef} />
        <SwingCard you={p.you} list={list} bots={p.bots} swingOf={(e) => p.perMatch(e).swing} />
        {!baselines && <Card><Empty text={baselinesError ?? "Loading the pro baselines."} /></Card>}
        {baselines && (
          <div className="profile__cols">
            <div id="firepower" ref={firepowerRef} className="psec"><Firepower q={base} side={side} values={p.you.v} /></div>
            <div id="howgood" ref={howGoodRef} className="psec"><HowGood q={base} side={ratingKey(side)} /></div>
          </div>
        )}
        <div className="profile__trend">
          <FormTrend p={p} side={side} />
          <MapsTable p={p} side={side} />
        </div>
        <div className="profile__cols3">
          <Weapons p={p} files={files} side={side} />
          <Clutches m={p.you.m} q={base} side={side} list={list} />
          <Multis m={p.you.m} list={list} side={side} />
          <div id="openings" ref={openingsRef} className="psec"><Openings s={p.you} /></div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- the card

/** One hero stat; `metric` is its id in the engine, for its tooltip and its pro percentile. */
interface CellDef { id: string; metric: string; label: string; bench: Bench; value: number | null; text: string; unit?: string }

/** The two most likely roles on one side, in words: "Entry 46%, Lurker 31%". */
function topRoles(b: RoleBlend | undefined) {
  if (!b?.blend) return null;
  return Object.entries(b.blend).sort((x, y) => y[1] - x[1]).slice(0, 2).map(([r, v]) => `${r} ${fmtPct(100 * v, 0)}`).join(", ");
}

function PlayerCard({ p, side, cmp, compare }: { p: ProfileData; side: SideKey; cmp: Compare; compare: ReactNode }) {
  const key = ratingKey(side);
  const line = lineOf(p.you, p.ratings[key].value);
  const botLine = p.bots && p.botRatings ? lineOf(p.bots, p.botRatings[key].value) : null;
  const bench = (b: Bench, botVal: number | null | undefined) => (cmp === "bots" && botVal !== null && botVal !== undefined ? benchAround(b, botVal) : b);
  const swingPct = line.swing === null ? null : 100 * line.swing;
  const cells: CellDef[] = [
    { id: "swing", metric: "swing", label: "Round swing", bench: bench(BENCH.swing, botLine?.swing === null || !botLine ? null : 100 * botLine.swing!), value: swingPct, text: fmtSwing(line.swing) },
    { id: "dpr", metric: "dpr", label: "DPR", bench: bench(BENCH.dpr, botLine?.dpr), value: line.dpr, text: fmtDec(line.dpr) },
    { id: "kast", metric: "kast", label: "KAST", bench: bench(BENCH.kast, botLine?.kast), value: line.kast, text: line.kast === null ? "–" : line.kast.toFixed(1), unit: "%" },
    { id: "multi", metric: "mk", label: "Multi-kill", bench: bench(BENCH.multi, botLine?.mk), value: line.mk, text: line.mk?.toFixed(1) ?? "–", unit: "%" },
    { id: "adr", metric: "adr", label: "ADR", bench: bench(BENCH.adr, botLine?.adr), value: line.adr, text: fmtAdr(line.adr) },
    { id: "kpr", metric: "kpr", label: "KPR", bench: bench(BENCH.kpr, botLine?.kpr), value: line.kpr, text: fmtDec(line.kpr) },
  ];
  // One rating definition (rating3.ts rating3Of): each side rated over its rated rounds, a side under
  // half rated left out, the total weighted by rated rounds, so it lies between the rated sides.
  const tR = p.ratings.T.value;
  const ctR = p.ratings.CT.value;
  const r3: Rating3 = p.ratings[key];
  const gaugeV = r3.value;
  const botRating = p.botRatings?.[key].value ?? null;
  const gaugeVerdict = verdictOf(gaugeV, cmp === "bots" && botRating !== null ? benchAround(BENCH.rating, botRating) : BENCH.rating);
  const woke = useRef(!sessionStorage.getItem("cs2stats.cardWoke"));
  useEffect(() => { sessionStorage.setItem("cs2stats.cardWoke", "1"); }, []);
  const roles = useCall("roles", [p.base]).data;
  const { baselines } = useData();
  const pros = useCall("compare", baselines ? [p.base, { side: key }] : null).data;
  /** "Top 6% of pro riflers. Win chance you add each round." */
  const cellTip = (c: CellDef) => {
    const pct = pros?.p[c.metric];
    const rank = pct && pct.pct !== null && !pct.reason ? `${rankText(pct.pct)} of ${proPoolName(pros!.role)}. ` : "";
    return `${rank}${tipOf(c.metric) ?? ""}`.trim();
  };
  const roleT = topRoles(roles?.T);
  const roleCT = topRoles(roles?.CT);
  const role = side === "t" ? roleT : side === "ct" ? roleCT : roleT && roleCT ? `${roleT.split(" ")[0]} on T, ${roleCT.split(" ")[0]} on CT` : null;
  const wins = p.list.filter((e) => e.result === "W").length;
  const losses = p.list.filter((e) => e.result === "L").length;
  return (
    <section className={`pcard-hltv ${woke.current ? "is-waking" : ""}`} aria-label="Player card">
      <div className="pcard-hltv__photo">
        <AgentImg side={side === "ct" ? "ct" : "t"} kind="portrait" className="pcard-hltv__agent" key={side === "ct" ? "ct" : "t"} />
        {role && (
          <div className="pcard-hltv__tags">
            <span className="tag" data-tip={PANEL_TIP.role}>{role}</span>
          </div>
        )}
        <div className="pcard-hltv__id">
          <b className="pcard-hltv__name">{p.name}</b>
          <span className="pcard-hltv__sub">{wins}–{losses}, {plural(p.list.length, "map", "maps")}</span>
        </div>
      </div>
      <div className="pcard-hltv__stage">
        <AgentImg side="t" kind="ghost" className={`ghost ghost--t ${side === "t" ? "is-lit" : ""}`} />
        <AgentImg side="ct" kind="ghost" className={`ghost ghost--ct ${side === "ct" ? "is-lit" : ""}`} />
        <div className="pcard-hltv__scope">
          {compare}
          <span className="pill">{plural(p.list.length, "map", "maps")}, {p.you.m.rounds} rounds</span>
        </div>
        <div className="ratings">
          <button className={`band band--t ${side === "t" ? "is-on" : ""}`} onClick={() => setQuery("side", side === "t" ? null : "t")} aria-pressed={side === "t"}>
            <b className="num">{fmtRating(tR)}</b><span>T rating</span>
          </button>
          <HoverCard as="div" className="gauge-wrap" card={() => (
            <div className="bd">
              <div className="bd__head"><span className="caps">{ratingHeadline()}{side !== "both" ? `, ${side.toUpperCase()}` : ""}</span><b className="num cream">{fmtRating(gaugeV)}</b></div>
              <p className="bd__def">{tipOf("rating3")}</p>
              {r3.inputs && <RatingTerms inputs={r3.inputs} />}
            </div>
          )}>
            <Gauge value={gaugeV} verdict={gaugeVerdict} label={ratingHeadline()} />
          </HoverCard>
          <button className={`band band--ct ${side === "ct" ? "is-on" : ""}`} onClick={() => setQuery("side", side === "ct" ? null : "ct")} aria-pressed={side === "ct"}>
            <b className="num">{fmtRating(ctR)}</b><span>CT rating</span>
          </button>
        </div>
        <div className="cells">
          {cells.map((c, i) => {
            const v = verdictOf(c.value, c.bench);
            return (
              <div key={c.id} className="cell" tabIndex={0} data-tip={cellTip(c)}>
                <b className="cell__v num">{c.text}{c.unit && c.text !== "–" && <small>{c.unit}</small>}</b>
                <span className="cell__l">{c.label}</span>
                <div className="cell__meter" style={{ ["--i" as string]: i }}><Meter v={c.value} bench={c.bench} animate={woke.current} /></div>
                <div className="cell__foot" data-v={v}><VerdictLabel v={v} /></div>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}

function FormRail({ p, side }: { p: ProfileData; side: SideKey }) {
  const rows = p.list.slice(0, 7);
  return (
    <Card title="Form" aside={<span className="meta form-rail__label"><span data-tip={PANEL_TIP.form}>{RATING_LABEL}</span><ApproxMark /></span>} flush className="form-rail">
      <TrendLine height={110} points={[...p.list].reverse().slice(-10).map((f) => ({ key: f.file, value: p.perMatch(f).rating, label: fmtMatchDay(f.match) }))} fmt={(v) => v.toFixed(2)} bench={1} avgValue={p.ratings[ratingKey(side)].value} avgLabel="pooled" />
      <table className="tbl tbl--compact">
        <tbody>
          {rows.map((f) => {
            const r = p.perMatch(f).rating;
            return (
              <tr key={f.file} data-link="" onClick={() => openMatch(matchHref(f.file))}>
                <td className="l"><span className="two"><b>{mapName(f.match.map)}</b><small>{fmtMatchDay(f.match)}</small></span></td>
                <td><span className={`wl wl--${f.result}`}>{f.result}</span> <span className="num">{f.score.us}:{f.score.them}</span></td>
                <td>{r === null ? <span className="faint" data-tip="Not rated: too little kill data in this match.">–</span> : <b className="num" style={{ color: ratingText(r) }}>{fmtRating(r)}</b>}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </Card>
  );
}

// ---------------------------------------------------------------- attributes

type StylePool = "role" | "all";

/** One metric of the block as the panel's percentile row. */
/** One metric of an attribute as a percentile row; a pro percentile names the pool it was read in. */
function panelMetric(p: Pct, kind: "performance" | "style", population: string): PanelMetric {
  return { id: p.id, ...pctProps(p.id, p, p.value), kind, population: kind === "performance" ? proPopulation(p.pool) : population };
}

function panelAttr(a: AttributeScore, kind: "performance" | "style", population: string, extra: Partial<PanelAttribute> = {}): PanelAttribute {
  return { id: a.id as PanelAttribute["id"], label: a.label, score: a.score, metrics: a.metrics.map((p) => panelMetric(p, kind, population)), ...extra };
}

/**
 * Firepower, the one attribute on the performance side (design/identity.md), ranked against pros on the
 * page's side. Unlike the style scores it is a quality, so its score and bar take the performance
 * colours. `values` are your metric values on the page's side, for the unscored rows (engine.ts EXTRA_SUBS).
 */
function Firepower({ q, side, values }: { q: Query; side: SideKey; values: Values }) {
  const scored = useCall("attributes", [q, { side: ratingKey(side) }]).data;
  const fp = scored?.scores.find((a) => a.id === "firepower");
  const t = fp?.score == null ? 0 : toScore(fp.score, 50, 50);
  return (
    <Card title="Firepower" tip={PANEL_TIP.firepower} aside={<span className="meta">{scored ? `Against ${scored.n} ${proPoolName(scored.role)}` : ""}</span>}>
      {!fp ? <div className="skel" style={{ height: 200 }} /> : (
        <div className="fpw">
          <div className="fpw__head">
            <span className="fpw__score num" style={{ color: fp.score === null ? undefined : scoreText(t) }}>{fp.score === null ? "–" : Math.round(fp.score)}<small>/100</small></span>
            <span className="fpw__bar" aria-hidden><i style={{ width: `${fp.score ?? 0}%`, background: fp.score === null ? "transparent" : scoreFill(t) }} /></span>
          </div>
          <div className="fpw__more">
            {panelAttr(fp, "performance", proPoolName(scored!.role)).metrics.map((m) => (
              <Percentile key={m.id} label={m.label} value={m.value} unit={m.unit} pct={m.pct} kind={m.kind} population={m.population} def={m.def} approx={m.approx} reason={m.reason} unavailable={m.unavailable} />
            ))}
            {extraSubs("firepower", values).map((s) => <ValueRow key={s.id} s={s} />)}
          </div>
        </div>
      )}
    </Card>
  );
}

/**
 * The six style attributes, from one attributeBlock call for the page's side and the chosen pool: how
 * you play, not how well (HLTV: "rating covers performance, attributes cover style"), ranked against
 * the bot careers in the same matches; Sniping always against every bot. ?attr=<id> opens one.
 * `values` are your metric values on the page's side, for each attribute's unscored rows.
 */
function StyleAttributes({ q, side, values }: { q: Query; side: SideKey; values: Values }) {
  const r = useRoute();
  const focus = r.query.get("attr");
  const [pool, setPool] = useState<StylePool>("role");
  const block = useCall("attributeBlock", [q, { side: ratingKey(side), pool }]);
  const b: AttributeBlock | null = block.data;
  if (!b) return block.error ? <Card title="Style attributes" tip={PANEL_TIP.style}><Empty text={block.error} /></Card> : <div className="skel" style={{ height: 300 }} />;
  const style = b.style;
  const role = pool === "all" ? "all" : style.role;
  const peer = style.role === "awper" ? "AWPer" : "Rifler";
  const pools: Option<StylePool>[] = [
    { value: "role", label: `${peer} bots`, tip: `Bots that play your role.` },
    { value: "all", label: "All bots" },
  ];
  const pop = { n: style.n, role } as const;
  const provisional = style.careers.provisional;
  const attrs = style.scores.map((a) => (a.id === "sniping"
    ? panelAttr(a, "style", botPoolName("all"), { note: pool === "role" ? "Compared to everyone" : undefined, open: focus === a.id, provisional, extra: extraSubs(a.id as PanelAttribute["id"], values) })
    : panelAttr(a, "style", botPoolName(role), { open: focus === a.id, provisional, extra: extraSubs(a.id as PanelAttribute["id"], values) })));
  const thin = style.n < style.careers.minPool ? <NeedsDemo detail={`${thinPoolText(style.careers, style.n)}${pool === "role" ? " All bots may have more." : ""}`} /> : undefined;
  return (
    <AttributesPanel
      title="Style attributes"
      tip={PANEL_TIP.style}
      pool={pool}
      pools={pools}
      onPool={setPool}
      poolNote={`Against ${botPopulation(style.careers, pop).text}`}
      message={thin}
      style={attrs}
    />
  );
}

// ---------------------------------------------------------------- breakdowns

function FormTrend({ p, side }: { p: ProfileData; side: SideKey }) {
  const pooled = p.ratings[ratingKey(side)].value;
  return (
    <Card title="Rating by match" tip={PANEL_TIP.ratingByMatch} collapsible id="profile-form" className="trendcard" aside={<SectionAside label="Overall" value={fmtRating(pooled)} color={ratingText(pooled)} />}>
      <TrendLine height={170} points={[...p.list].reverse().map((f) => ({ key: f.file, value: p.perMatch(f).rating, label: fmtMatchDay(f.match) }))} fmt={(v) => v.toFixed(2)} bench={1} benchLabel="average player" avgValue={pooled} avgLabel="pooled" />
      <RatingLegend />
    </Card>
  );
}

interface MapRow { map: string; matches: number; wins: number; s: Rolled; r: SideRatings }

function MapsTable({ p, side }: { p: ProfileData; side: SideKey }) {
  const { you: ids } = useData();
  const maps = useMemo(() => mapsIn(p.list), [p.list]);
  const files = useMemo(() => p.list.map((e) => e.file), [p.list]);
  const sums = useRollups(useMemo(() => maps.map((m) => ({ files, filter: { player: ids, maps: [m], ...sidesOf(side) } })), [maps, files, ids, side])).data;
  const rats = useRatings(useMemo(() => maps.map((m) => ({ files, filter: { player: ids, maps: [m] } })), [maps, files, ids])).data;
  const rows: MapRow[] = sums?.length === maps.length && rats?.length === maps.length ? maps.map((m, i) => {
    const on = p.list.filter((e) => e.match.map === m);
    return { map: m, matches: on.length, wins: on.filter((e) => e.result === "W").length, s: sums[i], r: rats[i] };
  }) : [];
  const key = ratingKey(side);
  return (
    <Card title="Maps" tip={PANEL_TIP.maps} collapsible id="profile-maps" flush className="mapscard" aside={<span className="meta">{plural(maps.length, "map")}</span>}>
      <DataTable
        label="Maps"
        rows={rows}
        rowKey={(m) => m.map}
        defaultSort={{ key: "matches", dir: "desc" }}
        columns={[
          { key: "map", label: "Map", align: "l", sort: (m) => mapName(m.map), render: (m) => <span className="mapcell"><MapThumb map={m.map} size={22} /><b>{mapName(m.map)}</b></span> },
          { key: "matches", label: "Maps", sort: (m) => m.matches, render: (m) => m.matches },
          { key: "wl", label: "W–L", sort: (m) => m.wins / m.matches, render: (m) => <span className="num">{m.wins}<span className="faint">–</span>{m.matches - m.wins}</span> },
          { key: "adr", label: "ADR", sort: (m) => m.s.v.adr, render: (m) => fmtAdr(m.s.v.adr) },
          { key: "kast", label: "KAST", sort: (m) => m.s.v.kast, render: (m) => <Num v={fmtPct(m.s.v.kast)} /> },
          { key: "t", label: "T", tip: "Your rating on T.", colored: true, sort: (m) => m.r.T.value, render: (m) => <span className="t-text">{fmtRating(m.r.T.value)}</span> },
          { key: "ct", label: "CT", tip: "Your rating on CT.", colored: true, sort: (m) => m.r.CT.value, render: (m) => <span className="ct-text">{fmtRating(m.r.CT.value)}</span> },
          { key: "rating", label: RATING_LABEL, tip: tipOf("rating3"), colored: true, sort: (m) => m.r[key].value, render: (m) => { const x = m.r[key].value; return <b style={{ color: ratingText(x) }}>{fmtRating(x)}</b>; } },
        ]}
      />
    </Card>
  );
}

const CLASS_ORDER = ["rifle", "sniper", "smg", "heavy", "pistol"];

/**
 * Every gun you got kills with on the page's side, most kills first within its class, each with the
 * game's own icon from the pack (components/GameIcon.tsx; the app's glyph only when the pack is missing).
 * Accuracy is from recorded matches (converted logs have no shots); headshots are a share of the gun's kills.
 */
function Weapons({ p, files, side }: { p: ProfileData; files: string[]; side: SideKey }) {
  const { you: ids } = useData();
  const guns = Object.entries(p.you.weapons).filter(([w, t]) => isGun(w) && t.kills > 0).map(([w, t]) => ({ w, cls: weaponClass(w), kills: t.kills, hs: t.kills ? (100 * t.hsKills) / t.kills : null }))
    .sort((a, b) => CLASS_ORDER.indexOf(a.cls) - CLASS_ORDER.indexOf(b.cls) || b.kills - a.kills);
  const total = guns.reduce((a, r) => a + r.kills, 0);
  const key = guns.map((g) => g.w).join(",");
  const accs = useRollups(useMemo(() => guns.map((g) => ({ files, filter: { player: ids, weapons: [g.w], ...sidesOf(side) } })), [key, files, ids, side])).data; // eslint-disable-line react-hooks/exhaustive-deps
  const acc = (i: number) => (accs?.length === guns.length && accs[i].aim.shots ? accs[i].v.accuracy : null);
  const most = Math.max(1, ...guns.map((g) => g.kills));
  return (
    <Card title="Weapons" tip={PANEL_TIP.weapons} collapsible id="profile-weapons" aside={<span className="meta">{plural(total, "kill")}</span>}>
      <table className="guns">
        <thead>
          <tr>
            <th scope="col" className="l" colSpan={2}><span className="sr-only">Gun</span></th>
            <th scope="col" data-tip="Your kills with the gun." tabIndex={0}>Kills</th>
            <th scope="col" data-tip="Shots that hit, from recorded matches." tabIndex={0} aria-label="Accuracy">Acc</th>
            <th scope="col" data-tip="Kills that were headshots." tabIndex={0}><span className="guns__hs"><GameIcon id="headshot" width={13} label="Headshots" fallback={<HeadshotIcon size={13} label="Headshots" />} /></span></th>
          </tr>
        </thead>
        <tbody>
          {guns.map((g, i) => (
            <Fragment key={g.w}>
              {(i === 0 || guns[i - 1].cls !== g.cls) && <tr className="guns__cls"><th scope="rowgroup" colSpan={5}>{WEAPON_CLASS_LABEL[g.cls]}</th></tr>}
              <tr>
                <td className="guns__ico"><GameIcon id={g.w} width={48} height={16} fallback={<WeaponIcon name={g.w} size={16} />} /></td>
                <td className="l guns__name">{weaponLabel(g.w)}<span className="guns__bar" aria-hidden><i style={{ width: `${(100 * g.kills) / most}%` }} /></span></td>
                <td><b className="num">{g.kills}</b></td>
                <td className="num">{acc(i) === null ? <span className="faint">–</span> : fmtPct(acc(i), 0)}</td>
                <td className="num">{g.hs === null ? "–" : fmtPct(g.hs, 0)}</td>
              </tr>
            </Fragment>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

/**
 * The 1v1 to 1v5 bars. A row with clutches behind it opens the list of them, each linking to its round
 * in the match's round drawer. Opening and closing a row is instant: nothing moves but the list.
 */
function Clutches({ m, q, side, list }: { m: Measures; q: Query; side: SideKey; list: MatchEntry[] }) {
  const rows = clutchRows(m);
  const won = rows.reduce((a, r) => a + r.won, 0);
  const played = rows.reduce((a, r) => a + r.played, 0);
  const [open, setOpen] = useState<number | null>(null);
  const all = useCall("clutches", [q]).data;
  const byFile = useMemo(() => new Map(list.map((e) => [e.file, e])), [list]);
  const listId = useId();
  return (
    <Card title="Clutches" tip={PANEL_TIP.clutches} collapsible id="profile-clutches" aside={<SectionAside label="Won" value={<>{won}<span className="faint">/{played}</span></>} />}>
      <ul className="clist">
        {rows.map((r) => {
          const body = (
            <>
              <ClutchBadge vs={r.vs} won={r.won > 0} />
              <span className="hbar"><i style={{ width: r.played ? `${(100 * r.won) / r.played}%` : 0, background: "var(--good)" }} /></span>
              <b className="num">{r.won}<span className="faint">/{r.played}</span></b>
            </>
          );
          // the worker lists clutches on both sides; the bars count the page's side
          const shown = (all ?? []).filter((c) => c.opponents === r.vs && (side === "both" || c.side === ratingKey(side)));
          return (
            <li key={r.vs}>
              {r.played === 0 ? <div className="clist__row">{body}<span className="clist__chev" aria-hidden /></div> : (
                <button className="clist__row" aria-expanded={open === r.vs} aria-controls={`${listId}-${r.vs}`}
                  aria-label={`1v${r.vs}: won ${r.won} of ${r.played}. ${open === r.vs ? "Hide" : "Show"} the rounds`}
                  onClick={() => setOpen((o) => (o === r.vs ? null : r.vs))}>
                  {body}<span className="clist__chev" aria-hidden />
                </button>
              )}
              {open === r.vs && (
                <ul id={`${listId}-${r.vs}`} className="clutchlist" aria-label={`Your 1v${r.vs} clutches`}>
                  {!all ? <li className="meta">Loading the rounds…</li> : shown.map((c) => <ClutchLink key={`${c.file}|${c.round}`} c={c} e={byFile.get(c.file)} />)}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

/** One clutch: won or lost, the side, the match, and the round, opening that round's drawer. */
function ClutchLink({ c, e }: { c: ClutchRow; e: MatchEntry | undefined }) {
  return (
    <li>
      <a href={matchHref(c.file, "rounds", { round: c.round })} className="clutchlist__a">
        <span className={`clutchlist__res ${c.won ? "is-won" : ""}`}>{c.won ? "Won" : "Lost"}</span>
        <span className={c.side === "T" ? "t-text" : "ct-text"}>{c.side}</span>
        <span className="meta">{e ? `${mapName(e.match.map)}, ${fmtMatchDay(e.match)}` : ""}</span>
        <span className="meta num">Round {c.round}</span>
      </a>
    </li>
  );
}

/** A round where you got k kills: the match, its number and your side. */
interface MultiRound { file: string; round: number; side: "T" | "CT" }

/** Matches read at once while listing multi-kill rounds: enough to keep the worker busy, few enough not to flood it. */
const MULTI_CONCURRENCY = 3;

/**
 * The rounds where you got exactly k kills (5 or more for an ace) on the page's side, read from each
 * match's bundle once the user opens a row (the engine has no multi-kill list like its clutch list).
 * Bundles come through the shared cache (data/hooks.ts bundleOf), MULTI_CONCURRENCY at a time; a
 * failed read is an error, not an empty list.
 */
function useMultiRounds(list: MatchEntry[], side: SideKey, k: number | null): Loaded<MultiRound[]> {
  const { client, version } = useData();
  const [st, setSt] = useState<Loaded<MultiRound[]>>({ data: null, error: null, loading: false });
  useEffect(() => {
    if (!client || k === null) { setSt({ data: null, error: null, loading: false }); return; }
    let alive = true;
    setSt({ data: null, error: null, loading: true });
    const want = side === "both" ? null : ratingKey(side);
    const out: MultiRound[][] = new Array(list.length);
    let next = 0;
    const worker = async () => {
      while (alive && next < list.length) {
        const i = next++;
        const e = list[i];
        const v = matchModel(e, await bundleOf(client, version, e.file));
        out[i] = v.rounds.flatMap((r) => {
          const n = killsBy(r, v.human).length;
          const s = sideOf(v, r, v.human);
          return (k === 5 ? n >= 5 : n === k) && (!want || s === want) ? [{ file: e.file, round: r.number, side: s }] : [];
        });
      }
    };
    Promise.all(Array.from({ length: Math.min(MULTI_CONCURRENCY, list.length) }, worker)).then(
      () => { if (alive) setSt({ data: out.flat(), error: null, loading: false }); },
      (err: Error) => { if (alive) setSt({ data: null, error: `The rounds could not be read: ${err.message}`, loading: false }); },
    );
    return () => { alive = false; };
  }, [client, version, list, side, k]);
  return st;
}

function Multis({ m, list, side }: { m: Measures; list: MatchEntry[]; side: SideKey }) {
  const rows = multiKillRows(m);
  const [open, setOpen] = useState<number | null>(null);
  const shown = useMultiRounds(list, side, open);
  const byFile = useMemo(() => new Map(list.map((e) => [e.file, e])), [list]);
  const listId = useId();
  // each row's percent of rounds is multiKillRows' own pct, null without rounds
  const share = (r: (typeof rows)[number]) => r.pct ?? 0;
  const most = Math.max(1, ...rows.map(share));
  return (
    <Card title="Multi-kills" tip={PANEL_TIP.multis} collapsible id="profile-multis" aside={<SectionAside label="Rounds" value={m.multiKillRounds} />}>
      <ul className="mlist">
        {rows.map((r) => {
          const label = r.k >= 5 ? "Aces" : `${r.k}-kill rounds`;
          const body = (
            <>
              <MultiBadge k={r.k} />
              <span className="hbar"><i style={{ width: `${(100 * share(r)) / most}%` }} /></span>
              <span className="num mlist__pct">{fmtPct(share(r), 1)}</span>
              <b className="num">{r.rounds}</b>
            </>
          );
          return (
            <li key={r.k}>
              {r.rounds === 0 ? <div className="clist__row mlist__row">{body}<span className="clist__chev" aria-hidden /></div> : (
                <button className="clist__row mlist__row" aria-expanded={open === r.k} aria-controls={`${listId}-${r.k}`}
                  aria-label={`${label}: ${r.rounds}, ${fmtPct(share(r), 1)} of rounds. ${open === r.k ? "Hide" : "Show"} the rounds`}
                  onClick={() => setOpen((o) => (o === r.k ? null : r.k))}>
                  {body}<span className="clist__chev" aria-hidden />
                </button>
              )}
              {open === r.k && (
                <ul id={`${listId}-${r.k}`} className="clutchlist" aria-label={`Your ${label}`}>
                  {shown.error ? <li className="meta">{shown.error}</li> : !shown.data ? <li className="meta">Loading the rounds…</li> : shown.data.map((x) => {
                    const e = byFile.get(x.file);
                    return (
                      <li key={`${x.file}|${x.round}`}>
                        <a href={matchHref(x.file, "rounds", { round: x.round })} className="clutchlist__a">
                          <MultiBadge k={r.k} />
                          <span className={x.side === "T" ? "t-text" : "ct-text"}>{x.side}</span>
                          <span className="meta">{e ? `${mapName(e.match.map)}, ${fmtMatchDay(e.match)}` : ""}</span>
                          <span className="meta num">Round {x.round}</span>
                        </a>
                      </li>
                    );
                  })}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

function Openings({ s }: { s: Rolled }) {
  const c = s.m;
  const att = c.openingKills + c.openingDeaths;
  const succ = s.v.openingSuccess;
  return (
    <Card title="Opening duels" tip={PANEL_TIP.openings} collapsible id="profile-openings" icon={<FirstKillIcon size={15} className="cream" />} aside={<span data-tip={tipOf("openingSuccess")}><SectionAside label="Won" value={fmtPct(succ, 0)} color={succ === null ? undefined : scoreText(toScore(succ, 50, 30))} /></span>}>
      <div className="odial">
        <svg viewBox="0 0 120 12" width="100%" height="12" aria-hidden>
          <rect x="0" y="2" width="120" height="8" rx="2" fill="var(--track)" />
          {att > 0 && <rect x="0" y="2" width={(120 * c.openingKills) / att} height="8" rx="2" fill="var(--good)" />}
        </svg>
        <div className="odial__legend"><span><b className="num good-text">{c.openingKills}</b> won</span><span><b className="num poor-text">{c.openingDeaths}</b> lost</span></div>
      </div>
      <dl className="facts">
        <dt data-tip={tipOf("openingAttempts")}>Attempts</dt><dd><b className="num">{fmtMetric("openingAttempts", s.v.openingAttempts)}</b><span className="meta">of rounds</span></dd>
        <dt data-tip={tipOf("openingWinPct")}>Rounds won after</dt><dd><b className="num">{fmtMetric("openingWinPct", s.v.openingWinPct)}</b></dd>
        <dt data-tip={tipOf("openingTradedPct")}>Opening deaths traded</dt><dd><b className="num">{fmtMetric("openingTradedPct", s.v.openingTradedPct)}</b></dd>
      </dl>
    </Card>
  );
}
