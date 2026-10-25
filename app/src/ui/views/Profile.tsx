// Profile: HLTV's night-mode player card, then two sections: Performance (how well you play: swing,
// attributes, rating by match, pros at your level, breakdowns) and Identity (how you play: role
// signals, signature stats, the pro whose style matches yours). The side switch in the app bar drives
// the whole page; sections the engine does not split by side say so.
import { useEffect, useMemo, useRef, useState } from "react";
import type { Counters } from "../../stats/counters";
import type { ProfileView as PV } from "../../stats/profile";
import { shotsFor } from "../../stats/aim";
import { WEAPON_CLASSES } from "../../stats/counters";
import { ClutchBadge, MapThumb, Meter, MultiBadge, Num, VerdictLabel } from "../components/bits";
import { Card } from "../components/Card";
import { Gauge, TrendLine } from "../components/charts";
import { Select } from "../components/controls";
import { DataTable } from "../components/DataTable";
import { HoverCard } from "../components/overlay";
import { AgentImg } from "../components/Agent";
import {
  botAverage, clutchRows, counterLine, countersRating3, filterSummaries, multiKillPct, multiKillRows, profileAttributes,
  RATING3_NOTE, RATING_HEADLINE, RATING_LABEL, RATING_POOLED, r3Value, summaryRating, countersRating, sliceRating, WEAPON_CLASS_LABEL, type Attr, type SideKey,
} from "../data/engine";
import { useProfile, useSideTotals, type SideTotals } from "../data/hooks";
import { emptyR3 } from "../../stats/rating3";
import { useData } from "../data/provider";
import { ratingParts } from "../data/series";
import { AttrIcon } from "../icons/attributes";
import { FirstKillIcon, WeaponClassIcon } from "../icons/game";
import { ChevronIcon } from "../icons/ui";
import { fmtAdr, fmtDate, fmtDec, fmtPct, fmtRating, fmtSwing, mapName, plural } from "../lib/format";
import { scoreText, toScore, ratingText } from "../lib/scale";
import { BENCH, benchAround, verdictOf, type Bench } from "../lib/verdict";
import { matchHref, openMatch, setQuery, useRoute } from "../router";
import { BarContent } from "../shell/Bar";
import { MapFilter, SideFilter, TimeFilter, useFilters } from "../shell/filters";
import { BreakRows, Empty, SectionAside } from "./shared";
import { HowGood, PlaysLike, RatingLegend, RoleCard, SectionHead, SwingCard } from "./profile/parts";
import { WhereYouPlay } from "./Playstyle";
import { Segmented } from "../components/controls";

type Compare = "bench" | "bots";

export default function ProfileView() {
  const { summaries } = useData();
  const { map, n, side } = useFilters();
  const r = useRoute();
  const { data: p, loading } = useProfile({ map, lastN: n });
  const [cmp, setCmp] = useState<Compare>(() => (r.query.get("cmp") as Compare) || "bench");
  const list = useMemo(() => { const f = filterSummaries(summaries, map); return n ? f.slice(0, n) : f; }, [summaries, map, n]);
  const bots = useMemo(() => botAverage(list), [list]);
  const attrs = useMemo(() => (p ? profileAttributes(p) : []), [p]);
  const sides = useSideTotals(useMemo(() => list.map((s) => s.file), [list]));

  if (!p) {
    return (
      <div className="view view--capped">
        <BarContent crumbs={[{ label: "Profile" }]} tools={<><MapFilter /><TimeFilter /><SideFilter /></>} />
        <div className="view__in profile">
          {loading || !summaries.length ? <div className="skel" style={{ height: 340 }} /> : <Card><Empty text="No matches in this filter." /></Card>}
        </div>
      </div>
    );
  }
  return (
    <div className="view view--capped">
      <BarContent crumbs={[{ label: p.name }, { label: "Profile" }]} tools={<><MapFilter /><TimeFilter /><SideFilter /></>} />
      <div className="view__in profile" data-side={side}>
        <div className="profile__top">
          <PlayerCard p={p} side={side} cmp={cmp} bots={bots} sides={sides} />
          <FormRail p={p} />
        </div>
        <div className="sidebar-bar card">
          <span className="meta">Side</span><SideFilter />
          {side !== "both" && <span className="meta">Attributes, multi-kills, clutches and openings are counted over both sides.</span>}
          <span className="sidebar-bar__end">
            <Select label="Compared to" prefix="Compared to" value={cmp} onChange={(v) => { setCmp(v); setQuery("cmp", v === "bench" ? null : v); }}
              options={[{ value: "bench", label: "HLTV-style benchmarks" }, { value: "bots", label: `Bots you played (${list.reduce((a, s) => a + s.bots.length, 0)})`, disabled: !bots }]} />
          </span>
        </div>
        <SectionHead title="Performance" sub="How well you play. The card above holds Rating 3.0's six sub-ratings; below are swing, Firepower and the how-good numbers." />
        <SwingCard p={p} list={list} bots={bots} />
        <div className="profile__cols">
          <Firepower attrs={attrs} provisional={p.attributes.provisional} careers={p.attributes.careers} />
          <HowGood c={p.total} />
        </div>
        <div className="profile__cols">
          <FormTrend p={p} />
          <MapsTable p={p} side={side} sides={sides} />
        </div>
        <div className="profile__cols3">
          <Weapons p={p} />
          <Clutches c={p.total} />
          <Multis c={p.total} />
          <Openings c={p.total} />
        </div>
        <SectionHead title="Identity" sub="How and where you play, apart from how well: style attributes, role and positions. A strong and a weak player can share a style." id="identity" />
        <StyleAttributes attrs={attrs} provisional={p.attributes.provisional} careers={p.attributes.careers} role={p.role.label} />
        <div className="identity">
          <RoleCard role={p.role} />
          <WhereYouPlay />
        </div>
        <PlaysLike attrs={attrs} initial={r.query.get("pro")} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- the card

interface CellDef { id: string; label: string; bench: Bench; value: number | null; text: string; unit?: string; bySide: boolean; breakdown?: () => JSX.Element | null }

function PlayerCard({ p, side, cmp, bots, sides }: { p: PV; side: SideKey; cmp: Compare; bots: Counters | null; sides: SideTotals | null }) {
  const line = counterLine(p.total, side);
  const botLine = bots ? counterLine(bots, side) : null;
  const r3 = countersRating3(p.total);
  const both = side === "both";
  const bench = (b: Bench, botVal: number | null | undefined) => (cmp === "bots" && botVal !== null && botVal !== undefined ? benchAround(b, botVal) : b);
  const swingPct = line.swing === null ? null : 100 * line.swing;
  const cells: CellDef[] = [
    { id: "swing", label: "Round swing", bench: bench(BENCH.swing, botLine?.swing === null || !botLine ? null : 100 * botLine.swing!), value: both ? swingPct : null, text: both ? fmtSwing(line.swing) : "–", bySide: false },
    { id: "dpr", label: "DPR", bench: bench(BENCH.dpr, botLine?.dpr), value: line.dpr, text: fmtDec(line.dpr), bySide: true },
    { id: "kast", label: "KAST", bench: bench(BENCH.kast, botLine?.kast), value: line.kast, text: line.kast === null ? "–" : line.kast.toFixed(1), unit: "%", bySide: true },
    { id: "multi", label: "Multi-kill", bench: bench(BENCH.multi, bots ? multiKillPct(bots) : null), value: both ? multiKillPct(p.total) : null, text: both ? (multiKillPct(p.total)?.toFixed(1) ?? "–") : "–", unit: both ? "%" : undefined, bySide: false },
    { id: "adr", label: "ADR", bench: bench(BENCH.adr, botLine?.adr), value: line.adr, text: fmtAdr(line.adr), bySide: true },
    { id: "kpr", label: "KPR", bench: bench(BENCH.kpr, botLine?.kpr), value: line.kpr, text: fmtDec(line.kpr), bySide: true },
  ];
  // One rating, Rating 3.0 pooled over rounds: overall from the engine's inputs, T and CT from the
  // same inputs split by side (data/sideRating.ts), so the overall always lies between T and CT.
  const tR = r3Value(sides?.you.t);
  const ctR = r3Value(sides?.you.ct);
  const gaugeV = side === "both" ? countersRating(p.total) : side === "t" ? tR : ctR;
  const botRating = side === "both" ? (bots ? countersRating(bots) : null) : r3Value(side === "t" ? sides?.bots.t : sides?.bots.ct);
  const gaugeVerdict = verdictOf(gaugeV, cmp === "bots" && botRating !== null ? benchAround(BENCH.rating, botRating) : BENCH.rating);
  const r2 = side === "both" ? sliceRating(p.total) : sliceRating(side === "t" ? p.total.sideT : p.total.sideCT);
  const parts = ratingParts(side === "both" ? p.total.r3 : side === "t" ? (sides?.you.t ?? emptyR3()) : (sides?.you.ct ?? emptyR3()));
  const woke = useRef(!sessionStorage.getItem("cs2stats.cardWoke"));
  useEffect(() => { sessionStorage.setItem("cs2stats.cardWoke", "1"); }, []);
  const role = p.role;
  return (
    <section className={`pcard-hltv ${woke.current ? "is-waking" : ""}`} aria-label="Player card">
      <div className="pcard-hltv__photo">
        <AgentImg side={side === "ct" ? "ct" : "t"} kind="portrait" className="pcard-hltv__agent" key={side === "ct" ? "ct" : "t"} />
        <div className="pcard-hltv__tags">
          <span className="tag" data-tip={`${role.label}${role.provisional ? ", provisional under 20 rounds" : ""}. Sniper share ${role.evidence.sniperShare === null ? "–" : fmtPct(100 * role.evidence.sniperShare, 0)}, opening attempts ${role.evidence.openingAttempts === null ? "–" : fmtPct(100 * role.evidence.openingAttempts, 0)}.`}>{role.label}</span>
        </div>
        <div className="pcard-hltv__id">
          <b className="pcard-hltv__name">{p.name}</b>
          <span className="pcard-hltv__sub">{p.wins}–{p.losses} vs bots, {plural(p.matches, "map", "maps")}</span>
        </div>
      </div>
      <div className="pcard-hltv__stage">
        <AgentImg side="t" kind="ghost" className={`ghost ghost--t ${side === "t" ? "is-lit" : ""}`} />
        <AgentImg side="ct" kind="ghost" className={`ghost ghost--ct ${side === "ct" ? "is-lit" : ""}`} />
        <div className="pcard-hltv__scope">
          <span className="pill">{plural(p.matches, "map", "maps")}, {p.total.rounds} rounds</span>
        </div>
        <div className="ratings">
          <button className={`band band--t ${side === "t" ? "is-on" : ""}`} onClick={() => setQuery("side", side === "t" ? null : "t")} aria-pressed={side === "t"}>
            <b className="num">{fmtRating(tR)}</b><span>T rating</span>
          </button>
          <HoverCard as="div" className="gauge-wrap" card={() => (
            <div className="bd">
              <div className="bd__head"><span className="caps">{RATING_HEADLINE}{side !== "both" ? `, ${side.toUpperCase()}` : ""}</span><b className="num cream">{fmtRating(gaugeV)}</b></div>
              <p className="bd__def">{RATING_POOLED} T and CT use the same inputs split by side, so the overall sits between them.</p>
              {parts && <BreakRows rows={parts.map((t) => ({ label: <>{t.label} {t.weight && <span className="faint">× {t.weight}</span>}</>, value: <>{t.value && <span className="faint">{t.value} → </span>}{signedNum(t.contrib)}</> }))} />}
              <p className="bd__def faint">{RATING3_NOTE} Rating 2.0 over the same rounds: {fmtRating(r2)}.</p>
            </div>
          )}>
            <Gauge value={gaugeV} verdict={gaugeVerdict} label={<>{RATING_HEADLINE}{!r3.calibrated && <span className="calib">calibrating</span>}</>} />
          </HoverCard>
          <button className={`band band--ct ${side === "ct" ? "is-on" : ""}`} onClick={() => setQuery("side", side === "ct" ? null : "ct")} aria-pressed={side === "ct"}>
            <b className="num">{fmtRating(ctR)}</b><span>CT rating</span>
          </button>
        </div>
        <div className="cells">
          {cells.map((c, i) => {
            const v = verdictOf(c.value, c.bench);
            return (
              <div key={c.id} className="cell" data-tip={!c.bySide && !both ? "Not split by side yet; switch to Both sides." : undefined}>
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

function useFormRating() {
  const { summaries } = useData();
  const byFile = new Map(summaries.map((s) => [s.file, s]));
  return (f: PV["form"][number]) => { const s = byFile.get(f.file); return s ? summaryRating(s) : null; };
}

function FormRail({ p }: { p: PV }) {
  const rating = useFormRating();
  const rows = [...p.form].reverse().slice(0, 7);
  return (
    <Card title="Form" aside={<span className="meta" data-tip={RATING_POOLED}>{RATING_LABEL}, pooled line</span>} flush className="form-rail">
      <TrendLine height={110} points={[...p.form].slice(-10).map((f) => ({ key: f.file, value: rating(f), label: fmtDate(f.startUtc) }))} fmt={(v) => v.toFixed(2)} bench={1} avgValue={countersRating(p.total)} avgLabel="pooled" />
      <table className="tbl tbl--compact">
        <tbody>
          {rows.map((f) => {
            const r = rating(f);
            return (
              <tr key={f.file} data-link="" onClick={() => openMatch(matchHref(f.file))}>
                <td className="l"><span className="two"><b>{mapName(f.map)}</b><small>{fmtDate(f.startUtc)}</small></span></td>
                <td><span className={`wl wl--${f.result}`}>{f.result}</span> <span className="num">{f.score.us}:{f.score.them}</span></td>
                <td><b className="num" style={{ color: ratingText(r) }}>{fmtRating(r)}</b></td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </Card>
  );
}

// ---------------------------------------------------------------- attributes

const scoredOn = (provisional: boolean, careers: number) => (provisional ? `Provisional, ${careers} of 15 bot careers` : `Percentile against ${careers} bot careers`);
const SCORED_TIP = "Scores map each sub-stat onto a fixed range until 15 bot careers reach 150 rounds; then they become percentiles against those careers.";

/** Firepower, the one attribute on the performance side (design/identity.md). */
function Firepower({ attrs, provisional, careers }: { attrs: Attr[]; provisional: boolean; careers: number }) {
  const a = attrs.find((x) => x.id === "firepower");
  if (!a) return null;
  return (
    <Card title="Firepower" aside={<span className="meta" data-tip={SCORED_TIP}>{scoredOn(provisional, careers)}</span>}>
      <div className="attrs attrs--one"><AttrCard a={a} wide open /></div>
    </Card>
  );
}

type StyleCompare = "role" | "everyone";

/** The six style attributes: how you play, not how well (HLTV: "rating covers performance, attributes cover style"). */
function StyleAttributes({ attrs, provisional, careers, role }: { attrs: Attr[]; provisional: boolean; careers: number; role: string }) {
  const r = useRoute();
  const focus = r.query.get("attr");
  const [cmp, setCmp] = useState<StyleCompare>("everyone");
  const peers = role.startsWith("AWPer") ? "AWPers" : "Riflers";
  return (
    <Card title="Style attributes" aside={
      <span className="card__aside-row">
        <span className="meta" data-tip={SCORED_TIP}>{scoredOn(provisional, careers)}</span>
        <Segmented label="Compared to" value={cmp} onChange={setCmp} options={[
          { value: "role", label: peers, disabled: true, tip: `Scores against ${peers.toLowerCase()} arrive with the engine's role-relative scoring; until then every score compares you with all bot careers.` },
          { value: "everyone", label: "Everyone" },
        ]} />
      </span>
    }>
      <div className="attrs">
        {attrs.filter((a) => a.id !== "firepower").map((a) => <AttrCard key={a.id} a={a} wide={false} open={focus === a.id} />)}
      </div>
      <p className="meta attrs__note">Each attribute weighs intent as well as outcome: opening attempts as well as opening kills, tradeable deaths as well as traded ones. HLTV compares riflers with riflers and AWPers with AWPers by default; that switch turns on when the engine supplies role-relative scores.</p>
    </Card>
  );
}

function AttrCard({ a, wide, open: openInit }: { a: Attr; wide: boolean; open: boolean }) {
  const [open, setOpen] = useState(openInit);
  const [instant, setInstant] = useState(true);
  const score = a.score;
  const t = score === null ? 0 : toScore(score, 50, 50);
  const top = [...a.subs].filter((s) => s.score !== null).sort((x, y) => y.score! - x.score!)[0];
  const id = `attr-${a.id}`;
  return (
    <div className={`attr ${wide ? "attr--wide" : ""} ${open ? "is-open" : ""}`}>
      <button className="attr__head" aria-expanded={open} aria-controls={id} onClick={(e) => { setInstant(e.detail === 0); setOpen((o) => !o); }}>
        <AttrIcon id={a.id} size={18} className="attr__ico" />
        <span className="attr__name">{a.label}</span>
        {!open && top && <span className="attr__peek meta">{top.label} <b className="num">{top.text}</b></span>}
        <span className="attr__score num"><b style={{ color: score === null ? undefined : scoreText(t) }}>{score === null ? "–" : Math.round(score)}</b><small>/100</small></span>
        <ChevronIcon size={16} className="chev" />
      </button>
      <div className="attr__bar"><i style={{ width: `${score ?? 0}%`, background: score === null ? "transparent" : t >= 0 ? "var(--tan)" : "var(--below)" }} /></div>
      <div id={id} className={`collapse ${instant ? "is-instant" : ""}`} data-open={open} {...(open ? {} : { inert: "" })}>
        <div className="collapse__in">
          <div className="subs">
            {a.subs.map((s) => (
              <div key={s.id} className="sub" data-tip={s.def}>
                <span className="sub__label">{s.label}{s.status === "approx" && <span className="sub__status" aria-label="approximate">≈</span>}</span>
                <b className="sub__v num"><Num v={s.text} /></b>
                <span className="sub__bar"><i style={{ width: `${s.score ?? 0}%` }} /></span>
              </div>
            ))}
            {a.extra.map((s) => (
              <div key={s.id} className="sub sub--extra" data-tip={s.def}>
                <span className="sub__label">{s.label}{s.status === "approx" && <span className="sub__status" aria-label="approximate">≈</span>}</span>
                <b className="sub__v num">{s.status === "unavailable" ? <span className="faint">n/a</span> : <Num v={s.text} />}</b>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- breakdowns

function FormTrend({ p }: { p: PV }) {
  const rating = useFormRating();
  return (
    <Card title="Rating by match" collapsible id="profile-form" aside={<SectionAside label="Overall" value={fmtRating(countersRating(p.total))} color={ratingText(countersRating(p.total))} />}>
      <TrendLine height={170} points={p.form.map((f) => ({ key: f.file, value: rating(f), label: fmtDate(f.startUtc) }))} fmt={(v) => v.toFixed(2)} bench={1} benchLabel="average player" avgValue={countersRating(p.total)} avgLabel="pooled" />
      <RatingLegend />
    </Card>
  );
}

function MapsTable({ p, side, sides }: { p: PV; side: SideKey; sides: SideTotals | null }) {
  const bySide = (map: string, s: "t" | "ct") => r3Value(sides?.byMap.get(map)?.[s]);
  const rating = (m: PV["maps"][number]) => (side === "both" ? countersRating(m.c) : bySide(m.map, side));
  return (
    <Card title="Maps" collapsible id="profile-maps" flush aside={<span className="meta">{plural(p.maps.length, "map")}</span>}>
      <DataTable
        label="Maps"
        rows={p.maps}
        rowKey={(m) => m.map}
        defaultSort={{ key: "matches", dir: "desc" }}
        columns={[
          { key: "map", label: "Map", align: "l", sort: (m) => mapName(m.map), render: (m) => <span className="mapcell"><MapThumb map={m.map} size={22} /><b>{mapName(m.map)}</b></span> },
          { key: "matches", label: "Maps", sort: (m) => m.matches, render: (m) => m.matches },
          { key: "wl", label: "W–L", sort: (m) => m.wins / m.matches, render: (m) => <span className="num">{m.wins}<span className="faint">–</span>{m.matches - m.wins}</span> },
          { key: "adr", label: "ADR", sort: (m) => counterLine(m.c, side).adr, render: (m) => fmtAdr(counterLine(m.c, side).adr) },
          { key: "kast", label: "KAST", sort: (m) => counterLine(m.c, side).kast, render: (m) => <Num v={fmtPct(counterLine(m.c, side).kast)} /> },
          { key: "t", label: "T", tip: "Rating 3.0 on T, pooled over rounds", colored: true, sort: (m) => bySide(m.map, "t"), render: (m) => <span className="t-text">{fmtRating(bySide(m.map, "t"))}</span> },
          { key: "ct", label: "CT", tip: "Rating 3.0 on CT, pooled over rounds", colored: true, sort: (m) => bySide(m.map, "ct"), render: (m) => <span className="ct-text">{fmtRating(bySide(m.map, "ct"))}</span> },
          { key: "rating", label: RATING_LABEL, tip: RATING_POOLED, colored: true, sort: (m) => rating(m), render: (m) => { const x = rating(m); return <b style={{ color: ratingText(x) }}>{fmtRating(x)}</b>; } },
        ]}
      />
    </Card>
  );
}

function Weapons({ p }: { p: PV }) {
  const c = p.total;
  const total = c.weaponKills.reduce((a, b) => a + b, 0);
  const rows = WEAPON_CLASSES.map((cls, i) => ({ cls, kills: c.weaponKills[i] })).filter((r) => r.kills > 0).sort((a, b) => b.kills - a.kills);
  const acc = (cls: string) => {
    if (!p.aim || !["rifle", "sniper", "smg", "heavy", "pistol"].includes(cls)) return null;
    const s = shotsFor(p.aim, "all", cls as "rifle");
    return s.shots ? { acc: (100 * s.hits) / s.shots, hs: s.kills ? (100 * s.hsKills) / s.kills : null, shots: s.shots } : null;
  };
  return (
    <Card title="Weapons" collapsible id="profile-weapons" aside={<span className="meta">{plural(total, "kill")}</span>}>
      <ul className="wlist">
        {rows.map((r) => {
          const a = acc(r.cls);
          return (
            <li key={r.cls} data-tip={a ? `${WEAPON_CLASS_LABEL[r.cls]}: ${a.shots} shots, accuracy ${fmtPct(a.acc)}${a.hs !== null ? `, headshot kills ${fmtPct(a.hs)}` : ""} (recorded matches)` : undefined}>
              <WeaponClassIcon cls={r.cls} size={14} className="wlist__ico" />
              <span>{WEAPON_CLASS_LABEL[r.cls]}</span>
              <span className="hbar"><i style={{ width: `${(100 * r.kills) / Math.max(1, rows[0].kills)}%` }} /></span>
              <b className="num">{r.kills}</b>
              <span className="meta num">{a ? fmtPct(a.acc, 0) : ""}</span>
            </li>
          );
        })}
      </ul>
      {p.aim && <p className="meta wlist__note">The last column is accuracy, from recorded matches.</p>}
    </Card>
  );
}

function Clutches({ c }: { c: Counters }) {
  const rows = clutchRows(c);
  const won = rows.reduce((a, r) => a + r.won, 0);
  const played = rows.reduce((a, r) => a + r.played, 0);
  return (
    <Card title="Clutches" collapsible id="profile-clutches" aside={<SectionAside label="Won" value={<>{won}<span className="faint">/{played}</span></>} />}>
      <ul className="clist">
        {rows.map((r) => (
          <li key={r.vs}>
            <ClutchBadge vs={r.vs} won={r.won > 0} />
            <span className="hbar"><i style={{ width: r.played ? `${(100 * r.won) / r.played}%` : 0, background: "var(--good)" }} /></span>
            <b className="num">{r.won}<span className="faint">/{r.played}</span></b>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function Multis({ c }: { c: Counters }) {
  const rows = multiKillRows(c);
  return (
    <Card title="Multi-kills" collapsible id="profile-multis" aside={<SectionAside label="Rounds" value={rows.reduce((a, r) => a + r.rounds, 0)} />}>
      <ul className="mlist">
        {rows.map((r) => (
          <li key={r.k}>
            <MultiBadge k={r.k} />
            <b className="num">{r.rounds}</b>
            <span className="meta">{c.rounds ? `${((100 * r.rounds) / c.rounds).toFixed(1)}% of rounds` : ""}</span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function Openings({ c }: { c: Counters }) {
  const att = c.openingKills + c.openingDeaths;
  const succ = att ? (100 * c.openingKills) / att : null;
  return (
    <Card title="Opening duels" collapsible id="profile-openings" icon={<FirstKillIcon size={15} className="cream" />} aside={<SectionAside label="Won" value={fmtPct(succ, 0)} color={succ === null ? undefined : scoreText(toScore(succ, 50, 30))} />}>
      <div className="odial">
        <svg viewBox="0 0 120 12" width="100%" height="12" aria-hidden>
          <rect x="0" y="2" width="120" height="8" rx="2" fill="var(--track)" />
          {att > 0 && <rect x="0" y="2" width={(120 * c.openingKills) / att} height="8" rx="2" fill="var(--good)" />}
        </svg>
        <div className="odial__legend"><span><b className="num good-text">{c.openingKills}</b> won</span><span><b className="num poor-text">{c.openingDeaths}</b> lost</span></div>
      </div>
      <dl className="facts">
        <dt>Attempts</dt><dd><b className="num">{c.fullRounds ? fmtPct((100 * att) / c.fullRounds) : "–"}</b><span className="meta">of rounds</span></dd>
        <dt>Rounds won after</dt><dd><b className="num">{c.openingKills ? fmtPct((100 * c.openingWins) / c.openingKills) : "–"}</b></dd>
        <dt>Opening deaths traded</dt><dd><b className="num">{c.openingDeaths ? fmtPct((100 * c.openingDeathsTraded) / c.openingDeaths) : "–"}</b></dd>
      </dl>
    </Card>
  );
}

const signedNum = (v: number) => `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(3)}`;
