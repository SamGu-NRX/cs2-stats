// Profile: the player card (design-target-v2), then tabs. Overview: Form, Where you rank, round swing,
// Firepower, multi-kill rounds, clutches and maps. Duels, Utility and Economy: metric rows. Aim and
// Weapons: Career aim's panels. Playstyle: role, where you play, style attributes, Aggression, Plays
// like, role by spawn, the style compass and ranks by topic. The side switch in the app bar drives the
// whole page: every summary is rolled up over that side's rounds. Performance is compared with that
// side's pros; style with the bot careers in the same matches on that side (worker/ranking.ts).
import { useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { AttributeScore, Percentile as Pct } from "../../stats/compare";
import type { Measures } from "../../stats/facts";
import type { RoleBlend } from "../../stats/identity";
import type { Rating3 } from "../../stats/rating3";
import { Delta, MapThumb, MultiBadge, Num } from "../components/bits";
import { Card } from "../components/Card";
import { Gauge } from "../components/charts";
import { Fig, MatchLine } from "../components/MatchSeries";
import { ApproxMark, percentilePhrase, sentence } from "../components/Percentile";
import { quintile, ShareTrack, THIN, Track } from "../components/MetricRow";
import { rovingIndex, Segmented, Select, type Option } from "../components/controls";
import { DataTable } from "../components/DataTable";
import { HoverCard } from "../components/overlay";
import { AgentImg } from "../components/Agent";
import {
  botIds, botPoolName, botPopulation, proPopulation, clutchRows, entryRating, careerEntries, extraSubs, fmtMetric, lineOf, mapsIn, multiKillRows, proPoolName,
  rankText, thinPoolText,
  ratingHeadline, RATING_LABEL, ratingKey, sidesOf, type BotPool, type SideKey,
} from "../data/engine";
import { useCall, useRatings, useRollups } from "../data/hooks";
import type { MatchEntry } from "../data/match";
import { PANEL_TIP, tipOf } from "../data/tips";
import { metric } from "../data/meta";
import { useData } from "../data/provider";
import type { AttributeBlock, ClutchRow, Query, Rolled, SideRatings, Values } from "../../worker/protocol";
import { fmtAdr, fmtMatchDay, fmtDec, fmtPct, fmtRating, fmtSwing, mapName, plural } from "../lib/format";
import { ratingText } from "../lib/scale";
import { BENCH, benchAround, VERDICT_LABEL, verdictOf, type Bench } from "../lib/verdict";
import { go, matchHref, navWasInstant, profileHref, PROFILE_TAB_LABEL, PROFILE_TABS, scopeQuery, setQuery, tabSectionHref, useRoute, useSection, type ProfileTab } from "../router";
import { BarContent } from "../shell/Bar";
import { useScope } from "../shell/filters";
import { Empty, NeedsDemo, SectionAside } from "./shared";
import { AttributesPanel, type PanelAttribute, type PanelMetric } from "./profile/AttributesPanel";
import { pctProps, PlaysLike, RatingTerms, RoleCard, SwingCard } from "./profile/parts";
import { roleValueDescriptor } from "./profile/role-decision";
import { AggressionCard } from "./profile/v2";
import { sampleOf, type Ranks as RankSet, AWP_ROWS, BuySplitsCard, CLUTCH_ROWS, ECONOMY_ROWS, EFFECT_ROWS, OPENING_ROWS, RANK_LABELS, RANK_ROWS, RoleBySpawnCard, StatCard, TAKEN_ROWS, THROW_ROWS, TRADE_ROWS, useRanks } from "./profile/tabs";
import CareerAim from "./CareerAim";
import WeaponsTab from "./Weapons";
import { Ranks, StyleCompass, WhereYouPlay } from "./Playstyle";

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

/**
 * The tab bar: links to #/profile/<tab>, Alt+1 to Alt+7 (App.tsx), and on its right the tab's sample and
 * the controls that govern the whole page. As WAI-ARIA tabs: one tab stop (the selected tab), Left and
 * Right move to the next tab and open it, Home and End jump to the ends (controls.tsx rovingIndex). The
 * cream underline jumps: tabs are switched many times a day, so a tab switch has no motion.
 */
function ProfileTabs({ tab, meta, children }: { tab: ProfileTab; meta: string; children?: ReactNode }) {
  const list = useRef<HTMLElement>(null);
  // a tab switch keeps the page's scope (map, matches, side, comparison), by mouse or by keyboard
  const scope = scopeQuery(useRoute().query);
  const onKey = (e: KeyboardEvent) => {
    const to = rovingIndex(e.key, PROFILE_TABS.indexOf(tab), PROFILE_TABS.length, false);
    if (to === null || e.altKey || e.ctrlKey || e.metaKey) return;
    e.preventDefault();
    go(profileHref(PROFILE_TABS[to], scope), { instant: true });
    list.current?.querySelector<HTMLElement>(`[data-tab="${PROFILE_TABS[to]}"]`)?.focus();
  };
  return (
    <div className="ptabs">
      <nav ref={list} className="ptabs__list" role="tablist" aria-label="Profile sections" onKeyDown={onKey}>
        {PROFILE_TABS.map((t, n) => (
          <a key={t} data-tab={t} role="tab" aria-selected={t === tab} tabIndex={t === tab ? 0 : -1} aria-controls="profile-panel" href={profileHref(t, scope)} className="ptabs__tab" data-tip={`Alt ${n + 1}`}>
            {PROFILE_TAB_LABEL[t]}
          </a>
        ))}
      </nav>
      <div className="ptabs__end">
        <span className="meta">{meta}</span>
        {children}
      </div>
    </div>
  );
}

/** The sample each tab rests on, for the tab bar's right side. */
function tabMeta(tab: ProfileTab, p: ProfileData): string {
  const m = p.you.m;
  if (tab === "duels") return `${plural(m.kills, "kill")}, ${plural(m.deaths, "death")}`;
  if (tab === "playstyle") return `${plural(p.t.m.rounds, "T round")}, ${plural(p.ct.m.rounds, "CT round")}`;
  return `${plural(p.list.length, "match", "matches")}, ${plural(m.rounds, "round")}`;
}

/**
 * The page's entrance: true from the first render with data until the cards have risen in, false
 * after a keyboard navigation. Only then does views.css animate the cards and the track dots, so a
 * tab switch or a filter change later renders without motion. Each card gets its stagger index.
 */
function useEnter(ready: boolean, scope: string) {
  const ref = useRef<HTMLDivElement>(null);
  const [entered, setEnter] = useState(() => !navWasInstant());
  // the scope (tab, side, filters, comparison) the page entered with: any change ends the entrance at
  // once, so cards a tab switch or a filter change mounts inside the window never rise
  const [first] = useState(scope);
  if (entered && scope !== first) setEnter(false);
  const enter = entered && scope === first;
  useLayoutEffect(() => {
    if (!ready || !enter) return;
    ref.current?.querySelectorAll<HTMLElement>(".card").forEach((el, i) => el.style.setProperty("--i", String(Math.min(i, 7))));
    // the last card's delay (7 × 30 ms) plus the dots' 280 ms, with room to spare
    const t = window.setTimeout(() => setEnter(false), 900);
    return () => window.clearTimeout(t);
  }, [ready]); // eslint-disable-line react-hooks/exhaustive-deps
  return [ref, enter] as const;
}

export default function ProfileView({ tab = "overview" }: { tab?: ProfileTab }) {
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
  const styleRef = useSection("style");
  const firepowerRef = useSection("firepower");
  const cardRef = useSection("card");
  const openingsRef = useSection("openings");
  const rqs = useMemo(() => (qs ? [{ files, filter: { player: ids } }, ...(bots.length ? [{ files, filter: { player: bots } }] : [])] : null), [qs, files, ids, bots]);
  const rats = useRatings(rqs).data;
  const base = useMemo(() => ({ files, filter: { player: ids } }), [files, ids]);
  const sideQ = useMemo(() => ({ files, filter: { player: ids, ...sidesOf(side) } }), [files, ids, side]);
  const ranks = useRanks(base, ratingKey(side));
  const perMatch = usePerMatch(list, ids, side);
  const p: ProfileData | null = sums.data && rats && perMatch && sums.data.length === (qs?.length ?? 0) ? {
    list, name: list[0].players[list[0].you].name, base, you: sums.data[0], t: sums.data[1], ct: sums.data[2], bots: bots.length ? sums.data[3] : null,
    ratings: rats[0], botRatings: bots.length ? rats[1] ?? null : null, perMatch,
  } : null;

  const [enterRef, enter] = useEnter(!!p, `${tab}|${side}|${map}|${n}|${cmp}`);
  // every tab reads the side: Aim's panels, Weapons' guns and Playstyle's role, compass and ranks too
  const controls = ["map", "matches", "side"] as const;
  if (!p) {
    return (
      <div className="view view--capped">
        <BarContent crumbs={[{ label: "Profile" }]} scope={{ controls: [...controls], maps: tab === "aim" ? "aim" : "career" }} />
        <div className="view__in profile">
          {(sums.loading || !matches.length) && !sums.error ? <div className="skel" style={{ height: 340 }} /> : <Card><Empty text={sums.error ?? "No matches in this filter."} /></Card>}
        </div>
      </div>
    );
  }
  const rankSide = ratingKey(side);
  return (
    <div className="view view--capped">
      <BarContent crumbs={[{ label: p.name }, { label: "Profile" }, { label: PROFILE_TAB_LABEL[tab] }]} scope={{ controls: [...controls], maps: tab === "aim" ? "aim" : "career" }} />
      <div className="view__in profile" data-side={side} data-enter={enter || undefined} ref={enterRef}>
        <div className="profile__top psec" id="card" ref={cardRef}>
          <PlayerCard p={p} side={side} cmp={cmp} />
        </div>
        <ProfileTabs tab={tab} meta={tabMeta(tab, p)}>
          {/* what the player card's verdicts measure against; the card is on every tab, so is this */}
          <Select label="Compared to" prefix="Compared to" value={cmp} onChange={(v) => { setCmp(v); setQuery("cmp", v === "bench" ? null : v); }}
            options={[{ value: "bench", label: "HLTV-style benchmarks" }, { value: "bots", label: `Bots you played (${bots.length})`, disabled: !p.bots }]} />
        </ProfileTabs>
        <div id="profile-panel" role="tabpanel" aria-label={PROFILE_TAB_LABEL[tab]} className={`ptab ptab--${tab}`}>
          {tab === "overview" && (
            <>
              {!baselines && <Card><Empty text={baselinesError ?? "Loading the pro baselines."} /></Card>}
              {/* HLTV's block sits under the player card, as on HLTV's player page */}
              {baselines && <div id="style" ref={styleRef} className="psec"><div id="firepower" ref={firepowerRef}><HltvBlock q={base} side={side} values={p.you.v} m={p.you.m} /></div></div>}
              <div className="profile__cols profile__cols--side">
                <FormRail p={p} side={side} />
                <StatCard title="Where you rank" tip={PANEL_TIP.whereYouRank} ids={RANK_ROWS} labels={RANK_LABELS} r={ranks}
                  aside={ranks?.pros ? <span className="meta">vs {ranks.pros}</span> : undefined} />
              </div>
              <SwingCard you={p.you} list={list} bots={p.bots} swingOf={(e) => p.perMatch(e).swing} />
              <div className="profile__cols">
                <Multis m={p.you.m} q={sideQ} list={list} />
                <Clutches m={p.you.m} q={base} side={side} list={list} />
              </div>
              <MapsTable p={p} side={side} />
            </>
          )}
          {tab === "duels" && (
            <>
              <div className="profile__cols">
                <div id="openings" ref={openingsRef} className="psec"><Openings s={p.you} r={ranks} /></div>
                <StatCard title="Opening duels, against pros" tip="The first duel of each round." ids={OPENING_ROWS} r={ranks} />
              </div>
              <div className="profile__cols">
                <StatCard title="Trades" tip="Avenging teammates, and being avenged." ids={TRADE_ROWS} r={ranks} id="howgood" />
                <div className="profile__stack">
                  <StatCard title="AWP duels" tip="Duels where you or the enemy holds an AWP." ids={AWP_ROWS} r={ranks} />
                  <StatCard title="Clutches, against pros" tip="Rounds you're your team's last player alive." ids={CLUTCH_ROWS} r={ranks} />
                </div>
              </div>
            </>
          )}
          {tab === "aim" && <CareerAim />}
          {tab === "weapons" && <WeaponsTab />}
          {tab === "utility" && (
            <div className="profile__cols">
              <StatCard title="What you throw" tip="Grenades you throw per round, and what you leave unused." ids={THROW_ROWS} r={ranks} />
              <div className="profile__stack">
                <StatCard title="What it does" tip="What your flashes, grenades and fire do to enemies." ids={EFFECT_ROWS} r={ranks} />
                <StatCard title="What you take" tip="Grenade and fire damage you take." ids={TAKEN_ROWS} r={ranks} />
              </div>
            </div>
          )}
          {tab === "economy" && (
            <div className="profile__cols">
              <StatCard title="Buying" tip="How you spend against your team, and what you keep." ids={ECONOMY_ROWS} r={ranks} />
              <BuySplitsCard q={sideQ} />
            </div>
          )}
          {tab === "playstyle" && (
            <>
              <div className="identity">
                <RoleCard q={sideQ} side={side} />
                <WhereYouPlay list={list} side={side} />
              </div>
              <a className="ptab__xref" href={tabSectionHref("overview", "style")}>Style attributes are on Overview, in HLTV's attribute block</a>
              <AggressionCard s={p.you} />
              <PlaysLike q={base} side={rankSide} initial={r.query.get("pro")} />
              <div className="profile__cols">
                <RoleBySpawnCard q={base} side={side} />
                <StyleCompass list={list} q={sideQ} />
              </div>
              <Ranks q={base} side={rankSide} />
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- the card

/** One hero stat; `metric` is its id in the engine, for its tooltip and its pro percentile. */
interface CellDef { id: string; metric: string; label: string; bench: Bench; value: number | null; text: string }

/**
 * A side's role for the card's pip (role-decision.ts's rule): the gated primary with its share, else
 * the top two as "A / B" with no share, else null (the engine withheld it).
 */
function topRole(b: RoleBlend | undefined): { role: string; share: number | null; what: string } | null {
  if (b?.primary) {
    const d = roleValueDescriptor(b, b.primary);
    return { role: b.primary, share: b.probability, what: d === "calibrated probability" ? "" : ` ${d}` };
  }
  return b?.top2 ? { role: b.top2.join(" / "), share: null, what: "" } : null;
}

/**
 * The hero (design-target-v2 player card): who you are and your roles on the left, the rating gauge
 * between the T and CT ratings in the middle, six stat tiles on the right. Each tile's track is your
 * percentile among the pros named on the left; the "Compared to" select in the tab bar sets what the
 * gauge's verdict and each tile's verdict (in its tooltip) measure against.
 */
function PlayerCard({ p, side, cmp }: { p: ProfileData; side: SideKey; cmp: Compare }) {
  const key = ratingKey(side);
  const line = lineOf(p.you, p.ratings[key].value);
  const botLine = p.bots && p.botRatings ? lineOf(p.bots, p.botRatings[key].value) : null;
  const bench = (b: Bench, botVal: number | null | undefined) => (cmp === "bots" && botVal !== null && botVal !== undefined ? benchAround(b, botVal) : b);
  const swingPct = line.swing === null ? null : 100 * line.swing;
  const cells: CellDef[] = [
    { id: "swing", metric: "swing", label: "Round swing", bench: bench(BENCH.swing, botLine?.swing === null || !botLine ? null : 100 * botLine.swing!), value: swingPct, text: fmtSwing(line.swing) },
    { id: "dpr", metric: "dpr", label: "Deaths per round", bench: bench(BENCH.dpr, botLine?.dpr), value: line.dpr, text: fmtDec(line.dpr) },
    { id: "kast", metric: "kast", label: "KAST", bench: bench(BENCH.kast, botLine?.kast), value: line.kast, text: line.kast === null ? "–" : `${line.kast.toFixed(1)}%` },
    { id: "multi", metric: "mk", label: "Multi-kill rounds", bench: bench(BENCH.multi, botLine?.mk), value: line.mk, text: line.mk === null ? "–" : `${line.mk.toFixed(1)}%` },
    { id: "adr", metric: "adr", label: "ADR", bench: bench(BENCH.adr, botLine?.adr), value: line.adr, text: fmtAdr(line.adr) },
    { id: "kpr", metric: "kpr", label: "Kills per round", bench: bench(BENCH.kpr, botLine?.kpr), value: line.kpr, text: fmtDec(line.kpr) },
  ];
  // One rating definition (rating3.ts rating3Of): each side rated over its rated rounds, a side under
  // half rated left out, the total weighted by rated rounds, so it lies between the rated sides.
  const tR = p.ratings.T.value;
  const ctR = p.ratings.CT.value;
  const r3: Rating3 = p.ratings[key];
  const gaugeV = r3.value;
  const botRating = p.botRatings?.[key].value ?? null;
  const gaugeVerdict = verdictOf(gaugeV, cmp === "bots" && botRating !== null ? benchAround(BENCH.rating, botRating) : BENCH.rating);
  const roles = useCall("roles", [p.base]).data;
  const { baselines } = useData();
  const pros = useCall("compare", baselines ? [p.base, { side: key }] : null).data;
  const against = cmp === "bots" ? "the bots you played" : "HLTV-style benchmarks";
  /** "Top 6% of pro riflers. Good against HLTV-style benchmarks. Win chance you add each round." */
  const cellTip = (c: CellDef) => {
    const pct = pros?.p[c.metric];
    const rank = pct && pct.pct !== null && !pct.reason ? `${rankText(pct.pct)} of ${proPoolName(pros!.role)}.` : null;
    const v = verdictOf(c.value, c.bench);
    return [rank, v === "na" ? null : `${VERDICT_LABEL[v]} against ${against}.`, tipOf(c.metric)].filter(Boolean).join("\n");
  };
  const sides = [{ s: "T", r: topRole(roles?.T), rounds: roles?.T.rounds }, { s: "CT", r: topRole(roles?.CT), rounds: roles?.CT.rounds }] as const;
  const wins = p.list.filter((e) => e.result === "W").length;
  const losses = p.list.filter((e) => e.result === "L").length;
  const maps = mapsIn(p.list);
  return (
    <section className="card hero pcard" aria-label="Player card">
      <div className="pcard__id">
        {/* no key: a side switch swaps the art in place, so it never fades again (views.css .pcard__agent) */}
        <AgentImg side={side === "ct" ? "ct" : "t"} kind="portrait" className="pcard__agent" />
        <div className="pcard__who">
          <h1 className="pcard__name">{p.name}</h1>
          <p className="pcard__sub"><b>{wins}–{losses}</b> · {plural(p.list.length, "match", "matches")} · {plural(p.you.m.rounds, "round")}{maps.length === 1 ? ` · ${mapName(maps[0])}` : ""}</p>
          {roles && (
            <p className="pcard__roles">
              {sides.map(({ s, r, rounds }) => r && (
                <span key={s} className="pcard__role" data-tip={r.share === null ? `The two leading roles over ${rounds} ${s} rounds are close.` : `${fmtPct(100 * r.share, 0)}${r.what} over ${rounds} ${s} rounds.`} tabIndex={0}>
                  <span className={`pip pip--${s.toLowerCase()}`}>{s}</span><b>{r.role}</b>
                </span>
              ))}
            </p>
          )}
          {pros && (
            <p className="pcard__pool meta">
              Against {pros.n} {proPoolName(pros.role)}
              <span className="help" data-tip="Each tile's dot is your rank among these pros." tabIndex={0} aria-label="What the tile tracks show">?</span>
            </p>
          )}
        </div>
      </div>
      <div className="pcard__rating">
        <button className={`pcard__side pcard__side--t ${side === "t" ? "is-on" : ""}`} onClick={() => setQuery("side", side === "t" ? null : "t")} aria-pressed={side === "t"}>
          <b className="disp disp--m">{fmtRating(tR)}</b><span className="caps">T rating</span>
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
        <button className={`pcard__side pcard__side--ct ${side === "ct" ? "is-on" : ""}`} onClick={() => setQuery("side", side === "ct" ? null : "ct")} aria-pressed={side === "ct"}>
          <b className="disp disp--m">{fmtRating(ctR)}</b><span className="caps">CT rating</span>
        </button>
      </div>
      <ul className="pcard__tiles">
        {cells.map((c) => {
          const pct = pros?.p[c.metric];
          const at = pct && pct.pct !== null && !pct.reason ? pct.pct : null;
          return (
            <li key={c.id} className="ptile" tabIndex={0} data-tip={cellTip(c)}>
              <b className="disp disp--m ptile__v"><Num v={c.text} /></b>
              <span className="caps ptile__l">{c.label}</span>
              {at === null ? <span className="ptile__none" /> : <Track at={at} tone={`q${quintile(at)}`} />}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** The rated match with the highest (or lowest) rating among `list`, or null without one. */
function extremeMatch(p: ProfileData, list: MatchEntry[], sign: 1 | -1) {
  let out: { e: MatchEntry; r: number } | null = null;
  for (const e of list) {
    const r = p.perMatch(e).rating;
    if (r !== null && (!out || sign * (r - out.r) > 0)) out = { e, r };
  }
  return out;
}

/** "Oct 24, 13:8": a match's day and score, under a figure. */
const dayScore = (e: MatchEntry) => `${fmtMatchDay(e.match)}, ${e.score.us}:${e.score.them}`;

/**
 * Form: the last ten matches' ratings on the page's side as a line plus dots, oldest first, with the
 * pooled rating dashed; beside it the pooled rating, the last match against it, and the best and
 * worst, each a link to its match.
 */
function FormRail({ p, side }: { p: ProfileData; side: SideKey }) {
  const pooled = p.ratings[ratingKey(side)].value;
  const recent = p.list.slice(0, 10).reverse();
  const last = p.list[0];
  const lastR = p.perMatch(last).rating;
  const best = extremeMatch(p, recent, 1);
  const worst = extremeMatch(p, recent, -1);
  const wins = p.list.filter((e) => e.result === "W").length;
  const losses = p.list.filter((e) => e.result === "L").length;
  return (
    <Card title="Form" aside={<span className="meta form-rail__label"><span data-tip={PANEL_TIP.form} tabIndex={0}>{RATING_LABEL}</span><ApproxMark /> by match, oldest first</span>} className="form-rail">
      <div className="series">
        <MatchLine label="Rating by match" fmt={(v) => v.toFixed(2)} pooled={pooled} refValue={1}
          points={recent.map((f) => ({ key: f.file, value: p.perMatch(f).rating, label: fmtMatchDay(f.match), result: f.result, href: matchHref(f.file) }))} />
        <dl className="figs">
          <Fig label="Pooled" value={fmtRating(pooled)} sub={`${plural(p.list.length, "match", "matches")}, ${wins}–${losses}`} />
          <Fig className="fig--last" label="Last match" value={fmtRating(lastR)} href={matchHref(last.file)}
            sub={lastR !== null && pooled !== null ? <><Delta d={lastR - pooled} span={0.3} fmt={(x) => x.toFixed(2)} /> vs pooled</> : dayScore(last)} />
          {best && <Fig label="Best" tone="good" value={fmtRating(best.r)} href={matchHref(best.e.file)} sub={dayScore(best.e)} />}
          {worst && worst.e !== best?.e && <Fig label="Worst" tone="poor" value={fmtRating(worst.r)} href={matchHref(worst.e.file)} sub={dayScore(worst.e)} />}
        </dl>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------- attributes

type StylePool = "role" | "all";

/** One metric of an attribute as a metric row; a pro percentile names the pool it was read in, and `m` gives its sample. */
function panelMetric(p: Pct, kind: "performance" | "style", population: string, m: Measures | null): PanelMetric {
  const s = sampleOf(p.id, p, m);
  return { id: p.id, ...pctProps(p.id, p, p.value), kind, population: kind === "performance" ? proPopulation(p.pool) : population, sample: s.text, n: s.n };
}

function panelAttr(a: AttributeScore, kind: "performance" | "style", population: string, m: Measures | null, extra: Partial<PanelAttribute> = {}): PanelAttribute {
  return { id: a.id as PanelAttribute["id"], label: a.label, score: a.score, metrics: a.metrics.map((p) => panelMetric(p, kind, population, m)), ...extra };
}

/**
 * HLTV's attribute block (profile/AttributesPanel.tsx), from one attributeBlock call for the page's
 * side and the chosen style pool: Firepower, the one performance attribute (design/identity.md),
 * against the pros or against the bots in your matches (StyleResult.firepower), and the six style
 * attributes against the bot careers in the same matches, Sniping always against every bot. How you
 * play, not how well, for the six (HLTV: "rating covers performance, attributes cover style").
 * ?attr=<id> opens one. `values` are your metric values on the page's side, for each attribute's
 * unscored rows (engine.ts EXTRA_SUBS); `m` the measures behind them, for each row's sample.
 */
/** A careers pool name as a bot pool's role; null for a name the UI does not know. */
const botRole = (p: string | undefined): BotPool["role"] | null => (p === "awper" || p === "rifler" || p === "all" ? p : null);

function HltvBlock({ q, side, values, m }: { q: Query; side: SideKey; values: Values; m: Measures }) {
  const r = useRoute();
  const focus = r.query.get("attr");
  const [pool, setPool] = useState<StylePool>("role");
  const [against, setAgainst] = useState<"pros" | "bots">("pros");
  const block = useCall("attributeBlock", [q, { side: ratingKey(side), pool }]);
  const b: AttributeBlock | null = block.data;
  if (!b) return block.error ? <Card title="Attributes"><Empty text={block.error} /></Card> : <div className="skel" style={{ height: 320 }} />;
  const style = b.style;
  // the pool the scores read: the one asked for, or all bots when the role's pool was too thin (careers.pool)
  const role = botRole(style.careers.pool) ?? (pool === "all" ? "all" : style.role);
  const peer = style.role === "awper" ? "AWPer" : "Rifler";
  const bots = botPopulation(style.careers, { n: style.n, role }).text;
  const fpScore = against === "pros" ? b.firepower : style.firepower;
  const fpPop = against === "pros" ? `${b.proPool} ${proPoolName(style.role)}` : bots;
  const firepower = fpScore ? { ...panelAttr(fpScore, "performance", fpPop, m, { open: focus === "firepower", extra: extraSubs("firepower", values) }), note: `vs ${fpPop}` } : null;
  if (firepower && against === "bots") firepower.metrics = firepower.metrics.map((x) => ({ ...x, population: fpPop }));
  const provisional = style.careers.provisional;
  const attrs = style.scores.map((a) => (a.id === "sniping"
    ? panelAttr(a, "style", botPoolName("all"), m, { note: pool === "role" ? "Compared to everyone" : undefined, open: focus === a.id, provisional, extra: extraSubs(a.id as PanelAttribute["id"], values) })
    : panelAttr(a, "style", botPoolName(role), m, { open: focus === a.id, provisional, extra: extraSubs(a.id as PanelAttribute["id"], values) })));
  const thin = style.n < style.careers.minPool ? <NeedsDemo detail={`${thinPoolText(style.careers, style.n)}${role !== "all" ? " All bots may have more." : ""}`} /> : undefined;
  const pools: Option<StylePool>[] = [
    { value: "role", label: `${peer} bots`, tip: `Bots that play your role.` },
    { value: "all", label: "All bots" },
  ];
  return (
    <AttributesPanel
      provisional={provisional}
      note={`Style vs ${bots}`}
      message={thin}
      firepower={firepower}
      style={attrs}
      controls={(
        <>
          {/* the page's own side, here too, as HLTV keeps it on the block: one state, the URL's side */}
          <Segmented label="Side" value={side} onChange={(v) => setQuery("side", v === "both" ? null : v)}
            options={[{ value: "both", label: "Both" }, { value: "t", label: "T", side: "t" }, { value: "ct", label: "CT", side: "ct" }]} />
          <Segmented label="Firepower against" value={against} onChange={setAgainst} options={[{ value: "pros", label: "vs pros" }, { value: "bots", label: "vs bots" }]} />
          <Select options={pools} value={pool} onChange={setPool} label="Style compared to" prefix="Style vs" />
        </>
      )}
    />
  );
}

// ---------------------------------------------------------------- breakdowns

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
      <ul className="clist lslist">
        {rows.map((r) => {
          const rate = r.played ? (100 * r.won) / r.played : null;
          const body = (
            <>
              <span className={`pip ${r.won > 0 ? "pip--hi" : ""}`}>1v{r.vs}</span>
              <ShareTrack value={rate ?? 0} max={100} hollow={r.played < THIN} />
              <span className="lsrow__n">{r.won} of {r.played}</span>
              <b className="num lsrow__v"><Num v={rate === null ? "–" : fmtPct(rate, 0)} /></b>
            </>
          );
          // the worker lists clutches on both sides; the bars count the page's side
          const shown = (all ?? []).filter((c) => c.opponents === r.vs && (side === "both" || c.side === ratingKey(side)));
          return (
            <li key={r.vs}>
              {r.played === 0 ? <div className="clist__row lsrow">{body}<span className="clist__chev" aria-hidden /></div> : (
                <button className="clist__row lsrow" aria-expanded={open === r.vs} aria-controls={`${listId}-${r.vs}`}
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

/**
 * Each multi-kill size as a share of your rounds, a lollipop against the largest share, hollow under
 * THIN rounds; where the share sits among pros (compare, rounds2k to rounds5k) is in the row's
 * tooltip. A row with rounds behind it opens them, from the engine's multi-kill list (multiKills),
 * each a link to its round.
 */
function Multis({ m, q, list }: { m: Measures; q: Query; list: MatchEntry[] }) {
  const rows = multiKillRows(m);
  const [open, setOpen] = useState<number | null>(null);
  const rounds = useCall("multiKills", open === null ? null : [q]);
  const ranked = useCall("compare", [q, { side: q.filter.sides?.length === 1 ? q.filter.sides[0] : "both" }]).data;
  const byFile = useMemo(() => new Map(list.map((e) => [e.file, e])), [list]);
  const listId = useId();
  // each row's percent of rounds is multiKillRows' own pct, null without rounds: no value, no track
  const most = Math.max(1, ...rows.map((r) => r.pct ?? 0));
  return (
    <Card title="Multi-kill rounds" tip={PANEL_TIP.multis} collapsible id="profile-multis" aside={<span className="meta">{m.multiKillRounds} of {plural(m.rounds, "round")}</span>}>
      {!m.rounds ? <Empty text="No rounds in this filter, so no share of rounds." /> : <ul className="mlist lslist">
        {rows.map((r) => {
          const label = r.k >= 5 ? "Aces" : `${r.k}-kill rounds`;
          const pro = ranked?.p[`rounds${Math.min(5, r.k)}k`] ?? null;
          const rank = pro && !pro.reason && pro.pct !== null ? pro.pct : null;
          const body = (
            <>
              <MultiBadge k={r.k} />
              {r.pct === null ? <span aria-hidden /> : <ShareTrack value={r.pct} max={most} hollow={r.rounds < THIN} />}
              <span className="lsrow__n">{r.rounds}</span>
              <b className="num lsrow__v mlist__pct"><Num v={fmtPct(r.pct, 1)} /></b>
            </>
          );
          const proText = rank === null ? sentence(pro?.reason ?? "No pro comparison for this.") : `${percentilePhrase(rank, "performance")} of ${proPopulation(pro!.pool)}.`;
          const mine = (rounds.data ?? []).filter((x) => (r.k >= 5 ? x.kills >= 5 : x.kills === r.k));
          return (
            <li key={r.k}>
              {r.rounds === 0 ? <div className="clist__row lsrow" tabIndex={0} data-tip={proText}>{body}<span className="clist__chev" aria-hidden /></div> : (
                <button className="clist__row lsrow" aria-expanded={open === r.k} aria-controls={`${listId}-${r.k}`} data-tip={proText}
                  aria-label={`${label}: ${r.rounds}${r.pct === null ? "" : `, ${fmtPct(r.pct, 1)} of rounds`}, ${proText} ${open === r.k ? "Hide" : "Show"} the rounds`}
                  onClick={() => setOpen((o) => (o === r.k ? null : r.k))}>
                  {body}<span className="clist__chev" aria-hidden />
                </button>
              )}
              {open === r.k && (
                <ul id={`${listId}-${r.k}`} className="clutchlist" aria-label={`Your ${label}`}>
                  {rounds.error ? <li className="meta">{rounds.error}</li> : !rounds.data ? <li className="meta">Loading the rounds…</li> : mine.map((x) => {
                    const e = byFile.get(x.file);
                    return (
                      <li key={`${x.file}|${x.round}`}>
                        <a href={matchHref(x.file, "rounds", { round: x.round })} className="clutchlist__a">
                          <MultiBadge k={r.k} />
                          <span className={x.side === "T" ? "t-text" : "ct-text"}>{x.side}</span>
                          <span className="meta">{e ? `${mapName(e.match.map)}, ${fmtMatchDay(e.match)}` : ""}</span>
                          <span className="meta num">Round {x.round}{x.won === null ? "" : <span className={`clutchlist__res ${x.won ? "is-won" : ""}`}>{x.won ? ", won" : ", lost"}</span>}</span>
                        </a>
                      </li>
                    );
                  })}
                </ul>
              )}
            </li>
          );
        })}
      </ul>}
    </Card>
  );
}

/** An opening-duel figure: display number, caps label, its percentile track, then its sample and rank. */
function OpenTile({ id, label, s, r }: { id: string; label: string; s: Rolled; r: RankSet | null }) {
  const p = r?.p[id];
  const ranked = p && p.pct !== null && !p.reason ? p.pct : null;
  const kind = metric(id).kind === "performance" ? "performance" : "style";
  const sample = p && r ? sampleOf(id, p, r.m) : null;
  const sub = [sample?.text, ranked === null ? null : kind === "performance" ? percentilePhrase(ranked, "performance") : `${percentilePhrase(ranked, "style")} vs bots`].filter(Boolean).join(" · ");
  const thin = sample?.n != null && sample.n < THIN;
  return (
    <li className="otile" tabIndex={0} data-tip={[tipOf(id), ranked === null ? (p?.reason ? sentence(p.reason) : null) : `${percentilePhrase(ranked, kind)} ${kind === "performance" ? `of ${proPopulation(p!.pool)}` : `against ${r!.bots}`}.`].filter(Boolean).join("\n")}>
      <b className={`disp disp--s otile__v ${thin ? "is-thin" : ""}`}><Num v={fmtMetric(id, s.v[id] ?? null)} /></b>
      <span className="caps">{label}</span>
      {ranked === null ? <span className="otile__none" /> : <Track at={ranked} tone={kind === "performance" ? `q${quintile(ranked)}` : undefined} hollow={thin} />}
      {sub && <span className="meta">{sub}</span>}
    </li>
  );
}

/**
 * Opening duels: the share won as the big figure with its pro rank as a pill, the won and lost duels
 * as one bar, then the attempts, the rounds won after an opening kill and the opening deaths traded,
 * each a figure with its track.
 */
function Openings({ s, r }: { s: Rolled; r: RankSet | null }) {
  const c = s.m;
  const att = c.openingKills + c.openingDeaths;
  const succ = s.v.openingSuccess;
  const p = r?.p.openingSuccess;
  const ranked = p && p.pct !== null && !p.reason ? p.pct : null;
  const q = ranked === null ? null : quintile(ranked);
  return (
    <Card title="Opening duels" tip={PANEL_TIP.openings} collapsible id="profile-openings" icon={<span className="pip pip--hi" aria-hidden>1st</span>}
      aside={<span className="meta">{plural(att, "opening duel")} in {plural(c.rounds, "round")}</span>}>
      <div className="open">
        <div className="open__big">
          <div className="open__head">
            <b className="disp disp--xl" data-tip={tipOf("openingSuccess")} tabIndex={0}><Num v={fmtPct(succ, 1)} /></b>
            {ranked !== null && <span className={`vpill ${q! >= 4 ? "vpill--good" : q! <= 2 ? "vpill--poor" : ""}`} data-tip={`${percentilePhrase(ranked, "performance")} of ${proPopulation(p!.pool)}.`} tabIndex={0}>{percentilePhrase(ranked, "performance")}</span>}
          </div>
          <span className="open__bar" aria-hidden><i style={{ width: att ? `${(100 * c.openingKills) / att}%` : 0 }} /></span>
          <div className="open__legend"><span><b className="num">{c.openingKills}</b> won</span><span><b className="num">{c.openingDeaths}</b> lost</span></div>
        </div>
        <ul className="open__tiles">
          <OpenTile id="openingAttempts" label="Attempts" s={s} r={r} />
          <OpenTile id="openingWinPct" label="Rounds won after" s={s} r={r} />
          <OpenTile id="openingTradedPct" label="Deaths traded" s={s} r={r} />
        </ul>
      </div>
    </Card>
  );
}
