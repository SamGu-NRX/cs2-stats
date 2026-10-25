// Profile: HLTV's night-mode player card, the attributes panel under it, then two sections behind a
// sticky bar: Performance (how well you play) and Identity (how you play, design/identity.md).
//
// Scope: the title bar's Map and Matches controls pick the career matches (useCareer), and every block
// reads that one list. The panel owns the only other controls, Side (?side=) and Compared to (?cmp=),
// and they govern the panel alone; the card and both sections cover both sides and split by side where
// they show a split (T and CT ratings, the maps table, role per side).
import { useEffect, useMemo, useRef } from "react";
import type { AttributeScore, Percentile as Pct } from "../../stats/compare";
import type { AttributeBlock, Rolled, SideRatings } from "../../worker/protocol";
import { Num } from "../components/bits";
import { Card } from "../components/Card";
import { HoverCard } from "../components/overlay";
import { AgentImg } from "../components/Agent";
import type { Option } from "../components/controls";
import {
  botPoolName, botPopulation, BOTS_TIP, lineOf, mapsIn, proPoolName, provisionalText, R3_INPUT_LABEL, RATING_POOLED, rating3Note, ratingHeadline, thinPoolText,
} from "../data/engine";
import { useCall, useCareer, useRatings, useRollups } from "../data/hooks";
import type { MatchEntry } from "../data/match";
import { ratingInfo } from "../data/meta";
import { useData } from "../data/provider";
import { fmtAdr, fmtDec, fmtPct, fmtRating, fmtSwing, mapName, plural } from "../lib/format";
import { BENCH, meterGeometry, verdictOf, type Bench } from "../lib/verdict";
import { setQuery, useRoute, useSection } from "../router";
import { BarContent } from "../shell/Bar";
import { useScope } from "../shell/filters";
import { BreakRows, Empty } from "./shared";
import { AttributesPanel, type PanelAttribute, type PanelMetric, type PanelSide } from "./profile/AttributesPanel";
import { pctProps, SectionBar, SectionHead, useHoldSection } from "./profile/parts";
import { ByBuy, HowGood, MapsTable, Moments, RatingByMatch, SwingCard, WinCorrelation } from "./profile/performance";
import { BuyDeviation, Information, PlaysLike, RoleCard, RolesBySpawn, WhereYouPlay } from "./profile/identity";

const SECTIONS = [{ id: "performance", label: "Performance" }, { id: "identity", label: "Identity" }];

export default function ProfileView() {
  const { you: ids, baselines, baselinesError } = useData();
  const scope = useScope();
  const { list } = useCareer(scope);
  const r = useRoute();
  const files = useMemo(() => list.map((e) => e.file), [list]);
  const base = useMemo(() => (list.length && ids.length ? { files, filter: { player: ids } } : null), [list.length, files, ids]);
  const qs = useMemo(() => (base ? [base, { ...base, filter: { ...base.filter, sides: ["T" as const] } }, { ...base, filter: { ...base.filter, sides: ["CT" as const] } }] : null), [base]);
  const sums = useRollups(qs);
  const rats = useRatings(base ? [base] : null);
  const cmp = useCall("compare", base && baselines ? [base, { side: "both" }] : null);
  const identityRef = useSection("identity");

  const you = sums.data?.length === 3 ? sums.data[0] : null;
  const ratings = rats.data?.[0] ?? null;
  const name = list[0] ? list[0].players[list[0].you].name : null;
  useHoldSection("identity", r.query.get("sec") === "identity", !!you && !!ratings);
  const crumbs = name ? [{ label: name }, { label: "Profile" }] : [{ label: "Profile" }];
  const bar = <BarContent crumbs={crumbs} scope={{ controls: ["map", "matches"] }} />;

  if (!base || !you || !ratings || !name) {
    const loading = (sums.loading || rats.loading || (!!base && !sums.error)) && !sums.error;
    return (
      <div className="view view--capped">
        {bar}
        <div className="view__in profile">
          {loading ? <div className="skel" style={{ height: 300 }} /> : <Card><Empty text={sums.error ?? rats.error ?? "No matches in this filter."} /></Card>}
        </div>
      </div>
    );
  }
  const t = sums.data![1];
  const ct = sums.data![2];
  const compare = cmp.data ?? null;
  const cmpError = cmp.error ?? (baselines ? null : baselinesError ?? null);
  return (
    <div className="view view--capped">
      {bar}
      <div className="view__in profile">
        <PlayerCard name={name} list={list} you={you} ratings={ratings} side={scope.side === "t" ? "T" : scope.side === "ct" ? "CT" : "both"} />
        <Panel q={base} side={scope.side === "t" ? "T" : scope.side === "ct" ? "CT" : "both"} pool={r.query.get("cmp") === "all" ? "all" : "role"} />
        <SectionBar sections={SECTIONS} caption="Performance ranks you against pros; identity against the bots in your matches." />

        <section id="performance" className="psec" aria-labelledby="sec-performance">
          <SectionHead id="sec-performance" title="Performance" sub="How well you play, across both sides." />
          <div className="profile__cols">
            <SwingCard you={you} cmp={compare} />
            <HowGood cmp={compare} error={cmpError} m={you.m} />
          </div>
          <RatingByMatch list={list} pooled={ratings.both.value} />
          <MapsTable list={list} />
          <Moments q={base} m={you.m} list={list} />
          <WinCorrelation q={base} list={list} />
          <ByBuy q={base} you={you} cmp={compare} />
        </section>

        <section id="identity" ref={identityRef} className="psec" aria-labelledby="sec-identity">
          <SectionHead id="sec-identity" title="Identity" sub="How you play, not how well: your role, where you play and the pros you resemble." />
          <div className="profile__cols">
            <RoleCard q={base} />
            <PlaysLike q={base} initial={r.query.get("pro")} rounds={{ T: t.m.rounds, CT: ct.m.rounds }} />
          </div>
          <div className="profile__cols">
            <RolesBySpawn q={base} />
            <Information you={you} />
          </div>
          <WhereYouPlay list={list} map={scope.map} />
          <BuyDeviation q={base} you={you} />
        </section>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- the card

interface CellDef { id: string; label: string; bench: Bench; value: number | null; text: string }

/** The six raw inputs, each with a bar on a better-is-right scale and a tick at the benchmark. */
function CellBar({ v, bench, i, wake }: { v: number | null; bench: Bench; i: number; wake: boolean }) {
  const g = meterGeometry(v, bench);
  const flip = (x: number) => (bench.lowerIsBetter ? 1 - x : x);
  const verdict = verdictOf(v, bench);
  const fill = verdict === "good" ? "var(--good)" : verdict === "poor" ? "var(--poor)" : "var(--avg)";
  return (
    <span className="pc-cell__bar" aria-hidden>
      {g.value !== null && <i className={wake ? "wake-bar" : undefined} style={{ width: `${100 * flip(g.value)}%`, background: fill, ["--i" as string]: i }} />}
      <em style={{ left: `${100 * flip(g.ref)}%` }} />
    </span>
  );
}

const benchTip = (b: Bench, fmt: (x: number) => string) => `The tick is a typical pro, ${fmt(b.ref)}. Green from ${fmt(b.good)}, red ${b.lowerIsBetter ? "above" : "below"} ${fmt(b.poor)}: hand-picked from HLTV averages, not calibrated for bot matches.`;

function PlayerCard({ name, list, you, ratings, side }: { name: string; list: MatchEntry[]; you: Rolled; ratings: SideRatings; side: PanelSide }) {
  const line = lineOf(you, ratings.both.value);
  const cells: (CellDef & { fmt: (x: number) => string })[] = [
    { id: "swing", label: "Round swing", bench: BENCH.swing, value: line.swing === null ? null : 100 * line.swing, text: fmtSwing(line.swing), fmt: (x) => fmtSwing(x / 100) },
    { id: "dpr", label: "DPR", bench: BENCH.dpr, value: line.dpr, text: fmtDec(line.dpr), fmt: (x) => fmtDec(x) },
    { id: "kast", label: "KAST", bench: BENCH.kast, value: line.kast, text: fmtPct(line.kast), fmt: (x) => fmtPct(x, 0) },
    { id: "multi", label: "Multi-kill", bench: BENCH.multi, value: line.mk, text: fmtPct(line.mk), fmt: (x) => fmtPct(x, 0) },
    { id: "adr", label: "ADR", bench: BENCH.adr, value: line.adr, text: fmtAdr(line.adr), fmt: (x) => fmtAdr(x) },
    { id: "kpr", label: "KPR", bench: BENCH.kpr, value: line.kpr, text: fmtDec(line.kpr), fmt: (x) => fmtDec(x) },
  ];
  const r3 = ratings.both;
  const parts = r3.inputs ? Object.entries(r3.inputs).map(([k, v]) => ({ label: R3_INPUT_LABEL[k]?.label ?? k, value: R3_INPUT_LABEL[k]?.fmt(v) ?? String(v) })) : null;
  // The bars grow once per session, the first time the card is seen (design/shell-and-motion.md).
  const woke = useRef(!sessionStorage.getItem("cs2stats.cardWoke"));
  useEffect(() => { sessionStorage.setItem("cs2stats.cardWoke", "1"); }, []);
  const maps = mapsIn(list);
  // "approximation" is params.json's word for a fit that has not passed acceptance (architecture.md): until it does, the rating says it is calibrating
  const calibrating = ratingInfo().status === "approximation";
  return (
    <section className={`pc ${woke.current ? "is-waking" : ""}`} aria-label="Player card" data-side={side}>
      <div className="pc__photo">
        <AgentImg side={side === "CT" ? "ct" : "t"} kind="portrait" className="pc__agent" key={side === "CT" ? "ct" : "t"} />
        <div className="pc__id">
          <b className="pc__name" data-tip={name}>{name}</b>
          <span className="pc__sub">{plural(list.length, "match", "matches")} · {maps.length === 1 ? mapName(maps[0]) : plural(maps.length, "map")} · {plural(you.m.rounds, "round")}</span>
        </div>
      </div>
      <div className="pc__stage">
        <AgentImg side="t" kind="ghost" className={`ghost ghost--t ${side === "T" ? "is-lit" : ""}`} />
        <AgentImg side="ct" kind="ghost" className={`ghost ghost--ct ${side === "CT" ? "is-lit" : ""}`} />
        <div className="pc__ratings">
          <div className="pc__side t-text"><b className="num">{fmtRating(ratings.T.value)}</b><span>T rating</span></div>
          <HoverCard as="div" className="pc__rating" card={() => (
            <div className="bd">
              <div className="bd__head"><span className="caps">{ratingHeadline()}</span><b className="num cream">{fmtRating(r3.value)}</b></div>
              <p className="bd__def">{RATING_POOLED} T and CT are the same formula over each side's rounds.</p>
              {parts && <BreakRows rows={parts} />}
              <p className="bd__def faint">{rating3Note()}</p>
            </div>
          )}>
            <span className="caps">{ratingHeadline()}</span>
            <b className="pc__big num">{fmtRating(r3.value)}</b>
            {calibrating && <span className="chip chip--prov pc__calib">calibrating</span>}
          </HoverCard>
          <div className="pc__side ct-text"><b className="num">{fmtRating(ratings.CT.value)}</b><span>CT rating</span></div>
        </div>
        <dl className="pc__cells">
          {cells.map((c, i) => (
            <div key={c.id} className="pc-cell" data-tip={benchTip(c.bench, c.fmt)}>
              <dt className="caps">{c.label}</dt>
              <dd className="pc-cell__v num"><Num v={c.text} /></dd>
              <dd><CellBar v={c.value} bench={c.bench} i={i} wake={woke.current} /></dd>
            </div>
          ))}
        </dl>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- the attributes panel

type Pool = "role" | "all";

/** One metric of the block as the panel's percentile row. */
function panelMetric(p: Pct, kind: "performance" | "style", population: string): PanelMetric {
  const x = pctProps(p.id, p, p.value);
  return { id: p.id, ...x, kind, population };
}

function panelAttr(a: AttributeScore, kind: "performance" | "style", population: string, extra: Partial<PanelAttribute> = {}): PanelAttribute {
  return { id: a.id as PanelAttribute["id"], label: a.label, score: a.score, metrics: a.metrics.map((p) => panelMetric(p, kind, population)), ...extra };
}

/**
 * The panel, fed by one attributeBlock call for the chosen side and pool. The six style attributes rank
 * against the bots in your matches; Sniping always against every bot. Firepower comes from the engine
 * against the pros (the block has no bot-pool Firepower yet), so its row names that population.
 */
function Panel({ q, side, pool }: { q: { files: string[]; filter: { player: string[] } }; side: PanelSide; pool: Pool }) {
  const block = useCall("attributeBlock", [q, { side, pool }]);
  const b: AttributeBlock | null = block.data;
  if (!b) {
    return block.error ? <Card><Empty text={block.error} /></Card> : <div className="skel" style={{ height: 420 }} />;
  }
  const style = b.style;
  const role = pool === "all" ? "all" : style.role;
  const peer = style.role === "awper" ? "AWPer" : "Rifler";
  const pools: Option<Pool>[] = [
    { value: "role", label: `${peer} bots`, tip: `You compare with ${peer.toLowerCase()} bots: more than 0.20 AWP kills per round makes an AWPer.` },
    { value: "all", label: "All bots" },
  ];
  const pop = botPopulation(style.careers, { n: style.n, role });
  const provisional = style.careers.provisional ? { label: `Provisional: ${pop.text}`, tip: `${provisionalText(style.careers, { n: style.n, role })}. ${BOTS_TIP}` } : null;
  const proRole = pool === "all" ? "all" : style.role;
  const fp = b.firepower ? panelAttr(b.firepower, "performance", proPoolName(proRole), {
    note: `Compared to ${b.proPool} ${proPoolName(proRole)}`,
    tip: "The mean of its 8 metrics' percentiles against pros on the same side.",
  }) : null;
  const attrs = style.scores.map((a) => (a.id === "sniping"
    ? panelAttr(a, "style", botPoolName("all"), pool === "role" ? { note: "Compared to everyone", tip: "Few players pick up the AWP, so Sniping always compares with every bot." } : {})
    : panelAttr(a, "style", botPoolName(role))));
  const thin = style.n < style.careers.minPool ? `${thinPoolText(style.careers, style.n)}${pool === "role" ? " All bots may have more." : ""}` : undefined;
  return (
    <AttributesPanel
      side={side}
      onSide={(s) => setQuery("side", s === "both" ? null : s.toLowerCase())}
      pool={pool}
      pools={pools}
      onPool={(p) => setQuery("cmp", p === "role" ? null : p)}
      provisional={provisional}
      message={thin}
      firepower={fp}
      style={attrs}
    />
  );
}
