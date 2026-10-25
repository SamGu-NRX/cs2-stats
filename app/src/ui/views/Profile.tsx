// Profile: HLTV's night-mode player card, then two sections: Performance (how well you play: swing,
// attributes, rating by match, breakdowns) and Identity (how you play: role blend per side, style
// attributes, the pro whose style matches yours). The side switch in the app bar drives the whole
// page: every summary is rolled up over that side's rounds. Performance is compared with that side's
// pros; style with the bot careers in the same matches on that side (worker/ranking.ts).
import { useEffect, useMemo, useRef, useState } from "react";
import type { Measures } from "../../stats/facts";
import type { RoleBlend } from "../../stats/identity";
import type { Rating3 } from "../../stats/rating3";
import { weaponClass } from "../../stats/weapons";
import { ClutchBadge, MapThumb, Meter, MultiBadge, Num, VerdictLabel } from "../components/bits";
import { Card } from "../components/Card";
import { Gauge, TrendLine } from "../components/charts";
import { Select } from "../components/controls";
import { DataTable } from "../components/DataTable";
import { HoverCard } from "../components/overlay";
import { AgentImg } from "../components/Agent";
import {
  attrsOf, botIds, botPoolText, BOTS_TIP, clutchRows, entryRating, filterEntries, fmtMetric, lineOf, mapsIn, multiKillRows, poolText, R3_INPUT_LABEL, rating3Note,
  thinPoolText,
  ratingDiagnostic, ratingHeadline, RATING_LABEL, RATING_POOLED, ratingKey, sidesOf, WEAPON_CLASS_LABEL, type Attr, type SideKey,
} from "../data/engine";
import { useCall, useRatings, useRollups } from "../data/hooks";
import type { MatchEntry } from "../data/match";
import { metric } from "../data/meta";
import { useData } from "../data/provider";
import type { Query, Rolled, SideRatings } from "../../worker/protocol";
import { AttrIcon } from "../icons/attributes";
import { FirstKillIcon, WeaponClassIcon } from "../icons/game";
import { ChevronIcon } from "../icons/ui";
import { fmtAdr, fmtDate, fmtDec, fmtPct, fmtRating, fmtSwing, mapName, plural } from "../lib/format";
import { scoreText, toScore, ratingText } from "../lib/scale";
import { BENCH, benchAround, verdictOf, type Bench } from "../lib/verdict";
import { matchHref, openMatch, setQuery, useRoute } from "../router";
import { BarContent } from "../shell/Bar";
import { MapFilter, SideFilter, TimeFilter, useFilters } from "../shell/filters";
import { BreakRows, Empty, Provisional, SectionAside } from "./shared";
import { HowGood, PlaysLike, RatingLegend, RoleCard, SectionHead, SwingCard } from "./profile/parts";
import { WhereYouPlay } from "./Playstyle";
import { Segmented } from "../components/controls";

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
}

export default function ProfileView() {
  const { matches, you: ids, baselines, baselinesError } = useData();
  const { map, n, side } = useFilters();
  const r = useRoute();
  const [cmp, setCmp] = useState<Compare>(() => (r.query.get("cmp") as Compare) || "bench");
  const list = useMemo(() => { const f = filterEntries(matches, map); return n ? f.slice(0, n) : f; }, [matches, map, n]);
  const bots = useMemo(() => botIds(list), [list]);
  const files = useMemo(() => list.map((e) => e.file), [list]);
  const qs = useMemo((): Query[] | null => (list.length && ids.length ? [
    { files, filter: { player: ids, ...sidesOf(side) } },
    { files, filter: { player: ids, sides: ["T"] } },
    { files, filter: { player: ids, sides: ["CT"] } },
    ...(bots.length ? [{ files, filter: { player: bots, ...sidesOf(side) } }] : []),
  ] : null), [list, files, ids, bots, side]);
  const sums = useRollups(qs);
  const rqs = useMemo(() => (qs ? [{ files, filter: { player: ids } }, ...(bots.length ? [{ files, filter: { player: bots } }] : [])] : null), [qs, files, ids, bots]);
  const rats = useRatings(rqs).data;
  const base = useMemo(() => ({ files, filter: { player: ids } }), [files, ids]);
  const p: ProfileData | null = sums.data && rats && sums.data.length === (qs?.length ?? 0) ? {
    list, name: list[0].players[list[0].you].name, base, you: sums.data[0], t: sums.data[1], ct: sums.data[2], bots: bots.length ? sums.data[3] : null,
    ratings: rats[0], botRatings: bots.length ? rats[1] ?? null : null,
  } : null;
  // Firepower on the page's side, compared with pros on that side (the worker rolls the query up over that side's rounds)
  const scored = useCall("attributes", list.length && ids.length && baselines ? [base, { side: ratingKey(side) }] : null).data;
  const attrs = useMemo(() => (scored ? attrsOf(scored.scores) : []), [scored]);

  if (!p) {
    return (
      <div className="view view--capped">
        <BarContent crumbs={[{ label: "Profile" }]} tools={<><MapFilter /><TimeFilter /><SideFilter /></>} />
        <div className="view__in profile">
          {(sums.loading || !matches.length) && !sums.error ? <div className="skel" style={{ height: 340 }} /> : <Card><Empty text={sums.error ?? "No matches in this filter."} /></Card>}
        </div>
      </div>
    );
  }
  return (
    <div className="view view--capped">
      <BarContent crumbs={[{ label: p.name }, { label: "Profile" }]} tools={<><MapFilter /><TimeFilter /><SideFilter /></>} />
      <div className="view__in profile" data-side={side}>
        <div className="profile__top">
          <PlayerCard p={p} side={side} cmp={cmp} />
          <FormRail p={p} />
        </div>
        <div className="sidebar-bar card">
          <span className="meta">Side</span><SideFilter />
          <span className="sidebar-bar__end">
            <Select label="Compared to" prefix="Compared to" value={cmp} onChange={(v) => { setCmp(v); setQuery("cmp", v === "bench" ? null : v); }}
              options={[{ value: "bench", label: "HLTV-style benchmarks" }, { value: "bots", label: `Bots you played (${bots.length})`, disabled: !p.bots }]} />
          </span>
        </div>
        <SectionHead title="Performance" sub="How well you play. The card above holds Rating 3.0's six inputs; below are swing, Firepower and the how-good numbers." />
        <SwingCard you={p.you} list={list} bots={p.bots} />
        {!baselines && <Card><Empty text={baselinesError ?? "Loading the pro baselines."} /></Card>}
        <div className="profile__cols">
          {baselines && <Firepower attrs={attrs} pool={scored ? poolText(scored.role, scored.n) : ""} />}
          {baselines && <HowGood q={base} side={ratingKey(side)} />}
        </div>
        <div className="profile__cols">
          <FormTrend p={p} />
          <MapsTable p={p} side={side} />
        </div>
        <div className="profile__cols3">
          <Weapons p={p} files={files} side={side} />
          <Clutches m={p.you.m} />
          <Multis m={p.you.m} />
          <Openings s={p.you} />
        </div>
        <SectionHead title="Identity" sub="How and where you play, apart from how well: style attributes, role and positions. A strong and a weak player can share a style. Your style is ranked against the bots in your matches; pros are ranked against pros." id="identity" />
        <StyleAttributes q={base} side={side} />
        <div className="identity">
          <RoleCard q={base} />
          <WhereYouPlay />
        </div>
        <PlaysLike q={base} side={ratingKey(side)} initial={r.query.get("pro")} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- the card

interface CellDef { id: string; label: string; bench: Bench; value: number | null; text: string; unit?: string }

/** The two most likely roles on one side, in words: "Entry 46%, Lurker 31%". */
function topRoles(b: RoleBlend | undefined) {
  if (!b?.blend) return null;
  return Object.entries(b.blend).sort((x, y) => y[1] - x[1]).slice(0, 2).map(([r, v]) => `${r} ${fmtPct(100 * v, 0)}`).join(", ");
}

function PlayerCard({ p, side, cmp }: { p: ProfileData; side: SideKey; cmp: Compare }) {
  const key = ratingKey(side);
  const line = lineOf(p.you, p.ratings[key].value);
  const botLine = p.bots && p.botRatings ? lineOf(p.bots, p.botRatings[key].value) : null;
  const bench = (b: Bench, botVal: number | null | undefined) => (cmp === "bots" && botVal !== null && botVal !== undefined ? benchAround(b, botVal) : b);
  const swingPct = line.swing === null ? null : 100 * line.swing;
  const cells: CellDef[] = [
    { id: "swing", label: "Round swing", bench: bench(BENCH.swing, botLine?.swing === null || !botLine ? null : 100 * botLine.swing!), value: swingPct, text: fmtSwing(line.swing) },
    { id: "dpr", label: "DPR", bench: bench(BENCH.dpr, botLine?.dpr), value: line.dpr, text: fmtDec(line.dpr) },
    { id: "kast", label: "KAST", bench: bench(BENCH.kast, botLine?.kast), value: line.kast, text: line.kast === null ? "–" : line.kast.toFixed(1), unit: "%" },
    { id: "multi", label: "Multi-kill", bench: bench(BENCH.multi, botLine?.mk), value: line.mk, text: line.mk?.toFixed(1) ?? "–", unit: "%" },
    { id: "adr", label: "ADR", bench: bench(BENCH.adr, botLine?.adr), value: line.adr, text: fmtAdr(line.adr) },
    { id: "kpr", label: "KPR", bench: bench(BENCH.kpr, botLine?.kpr), value: line.kpr, text: fmtDec(line.kpr) },
  ];
  // One rating, Rating 3.0 pooled over rounds; a side's rating is the rating of that side's rounds
  // (rating3BySide), so the overall need not lie between T and CT.
  const tR = p.ratings.T.value;
  const ctR = p.ratings.CT.value;
  const r3: Rating3 = p.ratings[key];
  const gaugeV = r3.value;
  const botRating = p.botRatings?.[key].value ?? null;
  const gaugeVerdict = verdictOf(gaugeV, cmp === "bots" && botRating !== null ? benchAround(BENCH.rating, botRating) : BENCH.rating);
  const parts = r3.inputs ? Object.entries(r3.inputs).map(([k, v]) => ({ label: R3_INPUT_LABEL[k]?.label ?? k, value: R3_INPUT_LABEL[k]?.fmt(v) ?? String(v) })) : null;
  const woke = useRef(!sessionStorage.getItem("cs2stats.cardWoke"));
  useEffect(() => { sessionStorage.setItem("cs2stats.cardWoke", "1"); }, []);
  const roles = useCall("roles", [p.base]).data;
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
            <span className="tag" data-tip={`Role blend: T ${roleT ?? "needs positions"}; CT ${roleCT ?? "needs positions"}.`}>{role}</span>
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
          <span className="pill">{plural(p.list.length, "map", "maps")}, {p.you.m.rounds} rounds</span>
        </div>
        <div className="ratings">
          <button className={`band band--t ${side === "t" ? "is-on" : ""}`} onClick={() => setQuery("side", side === "t" ? null : "t")} aria-pressed={side === "t"}>
            <b className="num">{fmtRating(tR)}</b><span>T rating</span>
          </button>
          <HoverCard as="div" className="gauge-wrap" card={() => (
            <div className="bd">
              <div className="bd__head"><span className="caps">{ratingHeadline()}{side !== "both" ? `, ${side.toUpperCase()}` : ""}</span><b className="num cream">{fmtRating(gaugeV)}</b></div>
              <p className="bd__def">{RATING_POOLED} T and CT are the same formula over each side's rounds.</p>
              {parts && <BreakRows rows={parts.map((t) => ({ label: t.label, value: t.value }))} />}
              <p className="bd__def faint">{rating3Note()}</p>
            </div>
          )}>
            <Gauge value={gaugeV} verdict={gaugeVerdict} label={<>{ratingHeadline()}{ratingDiagnostic() && <span className="calib">diagnostic</span>}</>} />
          </HoverCard>
          <button className={`band band--ct ${side === "ct" ? "is-on" : ""}`} onClick={() => setQuery("side", side === "ct" ? null : "ct")} aria-pressed={side === "ct"}>
            <b className="num">{fmtRating(ctR)}</b><span>CT rating</span>
          </button>
        </div>
        <div className="cells">
          {cells.map((c, i) => {
            const v = verdictOf(c.value, c.bench);
            return (
              <div key={c.id} className="cell">
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

function FormRail({ p }: { p: ProfileData }) {
  const rows = p.list.slice(0, 7);
  return (
    <Card title="Form" aside={<span className="meta" data-tip={RATING_POOLED}>{RATING_LABEL}, pooled line</span>} flush className="form-rail">
      <TrendLine height={110} points={[...p.list].reverse().slice(-10).map((f) => ({ key: f.file, value: entryRating(f), label: fmtDate(f.match.date) }))} fmt={(v) => v.toFixed(2)} bench={1} avgValue={p.ratings.both.value} avgLabel="pooled" />
      <table className="tbl tbl--compact">
        <tbody>
          {rows.map((f) => {
            const r = entryRating(f);
            return (
              <tr key={f.file} data-link="" onClick={() => openMatch(matchHref(f.file))}>
                <td className="l"><span className="two"><b>{mapName(f.match.map)}</b><small>{fmtDate(f.match.date)}</small></span></td>
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

const PRO_TIP = "The score is the mean of its metrics' percentiles against anonymous pro players (public/baselines.json), on the same side.";

/** Firepower, the one attribute on the performance side (design/identity.md), ranked against pros. */
function Firepower({ attrs, pool }: { attrs: Attr[]; pool: string }) {
  const a = attrs.find((x) => x.id === "firepower");
  if (!a) return null;
  return (
    <Card title="Firepower" aside={<span className="meta" data-tip={PRO_TIP}>{pool}</span>}>
      <div className="attrs attrs--one"><AttrCard a={a} wide open /></div>
    </Card>
  );
}

type StyleCompare = "role" | "everyone";

/**
 * The six style attributes: how you play, not how well (HLTV: "rating covers performance, attributes
 * cover style"), ranked against the bot careers in the same matches (design/identity.md).
 */
function StyleAttributes({ q, side }: { q: Query; side: SideKey }) {
  const r = useRoute();
  const focus = r.query.get("attr");
  const [cmp, setCmp] = useState<StyleCompare>("role");
  const pool = cmp === "role" ? "role" : "all";
  const call = useCall("style", [q, { pool, side: ratingKey(side) }]);
  const res = call.data;
  const attrs = useMemo(() => (res ? attrsOf(res.scores) : []), [res]);
  const peer = res?.role === "awper" ? "AWPer" : "Rifler";
  return (
    <Card title="Style attributes" aside={
      <span className="card__aside-row">
        <span className="meta" data-tip={BOTS_TIP}>{res ? botPoolText(pool === "all" ? "all" : res.role, res.n) : ""}</span>
        <Segmented label="Compared to" value={cmp} onChange={setCmp} options={[
          { value: "role", label: `${peer} bots`, tip: `You are compared with ${peer.toLowerCase()} bot careers: more than 0.20 AWP kills per round makes an AWPer.` },
          { value: "everyone", label: "All bots" },
        ]} />
      </span>
    }>
      {res?.careers.provisional && <div className="attrs__prov"><Provisional c={res.careers} /></div>}
      {!res ? (call.error ? <Empty text={call.error} /> : <div className="skel" style={{ height: 220 }} />) : (
        <>
          {res.n < res.careers.minPool && <p className="meta attrs__thin">{thinPoolText(res.careers, res.n)}{pool === "role" ? " All bots may have more." : ""}</p>}
          <div className="attrs">
            {attrs.map((a) => <AttrCard key={a.id} a={a} wide={false} open={focus === a.id} />)}
          </div>
        </>
      )}
      <p className="meta attrs__note">Each score is the mean of its metrics' percentiles against the bots in your own matches, on the same side: each bot name is one career, summed over the same matches as you. Pros are ranked against pros, not in this pool. Each attribute weighs intent as well as outcome: opening attempts as well as opening kills, tradeable deaths as well as traded ones. Riflers compare with rifler careers and AWPers with AWPer careers; Sniping always compares with every career.</p>
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
                <b className="sub__v num">{s.status === "unavailable" ? <span className="faint">n/a</span> : <Num v={s.text} />}</b>
                <span className="sub__bar"><i style={{ width: `${s.score ?? 0}%` }} /></span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- breakdowns

function FormTrend({ p }: { p: ProfileData }) {
  const pooled = p.ratings.both.value;
  return (
    <Card title="Rating by match" collapsible id="profile-form" aside={<SectionAside label="Overall" value={fmtRating(pooled)} color={ratingText(pooled)} />}>
      <TrendLine height={170} points={[...p.list].reverse().map((f) => ({ key: f.file, value: entryRating(f), label: fmtDate(f.match.date) }))} fmt={(v) => v.toFixed(2)} bench={1} benchLabel="average player" avgValue={pooled} avgLabel="pooled" />
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
    <Card title="Maps" collapsible id="profile-maps" flush aside={<span className="meta">{plural(maps.length, "map")}</span>}>
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
          { key: "t", label: "T", tip: "Rating 3.0 on T, pooled over rounds", colored: true, sort: (m) => m.r.T.value, render: (m) => <span className="t-text">{fmtRating(m.r.T.value)}</span> },
          { key: "ct", label: "CT", tip: "Rating 3.0 on CT, pooled over rounds", colored: true, sort: (m) => m.r.CT.value, render: (m) => <span className="ct-text">{fmtRating(m.r.CT.value)}</span> },
          { key: "rating", label: RATING_LABEL, tip: RATING_POOLED, colored: true, sort: (m) => m.r[key].value, render: (m) => { const x = m.r[key].value; return <b style={{ color: ratingText(x) }}>{fmtRating(x)}</b>; } },
        ]}
      />
    </Card>
  );
}

function Weapons({ p, files, side }: { p: ProfileData; files: string[]; side: SideKey }) {
  const { you: ids } = useData();
  // kills per weapon class, summed from the per-weapon totals
  const byClass = new Map<string, string[]>();
  for (const w of Object.keys(p.you.weapons)) {
    const c = weaponClass(w);
    byClass.set(c, [...(byClass.get(c) ?? []), w]);
  }
  const rows = [...byClass].map(([cls, ws]) => ({ cls, ws, kills: ws.reduce((t, w) => t + p.you.weapons[w].kills, 0) })).filter((r) => r.kills > 0).sort((a, b) => b.kills - a.kills);
  const total = rows.reduce((a, r) => a + r.kills, 0);
  const key = rows.map((r) => r.cls).join(",");
  const accs = useRollups(useMemo(() => rows.map((r) => ({ files, filter: { player: ids, weapons: r.ws, ...sidesOf(side) } })), [key, files, ids, side])).data; // eslint-disable-line react-hooks/exhaustive-deps
  const acc = (i: number) => (accs?.length === rows.length && accs[i].aim.shots ? { acc: accs[i].v.accuracy, shots: accs[i].aim.shots } : null);
  const anyAim = rows.some((_, i) => acc(i));
  return (
    <Card title="Weapons" collapsible id="profile-weapons" aside={<span className="meta">{plural(total, "kill")}</span>}>
      <ul className="wlist">
        {rows.map((r, i) => {
          const a = acc(i);
          return (
            <li key={r.cls} data-tip={a ? `${WEAPON_CLASS_LABEL[r.cls]}: ${a.shots} shots, accuracy ${fmtPct(a.acc)} (recorded matches)` : undefined}>
              <WeaponClassIcon cls={r.cls} size={14} className="wlist__ico" />
              <span>{WEAPON_CLASS_LABEL[r.cls]}</span>
              <span className="hbar"><i style={{ width: `${(100 * r.kills) / Math.max(1, rows[0].kills)}%` }} /></span>
              <b className="num">{r.kills}</b>
              <span className="meta num">{a ? fmtPct(a.acc, 0) : ""}</span>
            </li>
          );
        })}
      </ul>
      {anyAim && <p className="meta wlist__note">The last column is accuracy, from recorded matches.</p>}
    </Card>
  );
}

function Clutches({ m }: { m: Measures }) {
  const rows = clutchRows(m);
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

function Multis({ m }: { m: Measures }) {
  const rows = multiKillRows(m);
  return (
    <Card title="Multi-kills" collapsible id="profile-multis" aside={<SectionAside label="Rounds" value={m.multiKillRounds} />}>
      <ul className="mlist">
        {rows.map((r) => (
          <li key={r.k}>
            <MultiBadge k={r.k} />
            <b className="num">{r.rounds}</b>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function Openings({ s }: { s: Rolled }) {
  const c = s.m;
  const att = c.openingKills + c.openingDeaths;
  const succ = s.v.openingSuccess;
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
        <dt data-tip={metric("openingAttempts").def}>Attempts</dt><dd><b className="num">{fmtMetric("openingAttempts", s.v.openingAttempts)}</b><span className="meta">of rounds</span></dd>
        <dt data-tip={metric("openingTradedPct").def}>Opening deaths traded</dt><dd><b className="num">{fmtMetric("openingTradedPct", s.v.openingTradedPct)}</b></dd>
      </dl>
    </Card>
  );
}
