// Profile sections: the round-swing card, the role blend in plain words, the "plays like" view
// against the pro pack, and the how-good table.
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Percentile as Pct, SideKey as PoolSide } from "../../../stats/compare";
import type { Measures } from "../../../stats/facts";
import { packerFeatures, type RoleBlend } from "../../../stats/identity";
import type { Query, Rolled, Values } from "../../../worker/protocol";
import { Delta, Initials, RemoteImg } from "../../components/bits";
import { Card } from "../../components/Card";
import { AttrRadar, FormBars } from "../../components/charts";
import { GameIcon } from "../../components/GameIcon";
import { attrsOf, fmtMetric, proPoolName } from "../../data/engine";
import { useCall, useRollups } from "../../data/hooks";
import { PANEL_TIP, PROVISIONAL_TIP, TIP, tipOf } from "../../data/tips";
import { FirstKillIcon, TimeIcon, WeaponIcon } from "../../icons/game";
import { metric, styleIds } from "../../data/meta";
import type { MatchEntry } from "../../data/match";
import { ATTRIBUTE_ORDER, HLTV_ORIGIN, usePros, type AttributeId, type Pro } from "../../data/packs";
import { PACKS_FOLDER } from "../../../host/host";
import { AttrIcon } from "../../icons/attributes";
import { fmtMatchDay, fmtPct, fmtSwing, mapName, plural } from "../../lib/format";
import { swingScore } from "../../lib/scale";
import { NeedsDemo } from "../shared";
import { Percentile } from "../../components/Percentile";
import { MapThumb } from "../../components/bits";
import { matchHref, openMatch, setQuery } from "../../router";

export function SectionHead({ title, tip, id }: { title: string; tip: string; id?: string }) {
  return (
    <div className="shead" id={id}>
      <h2 className="shead__t"><span className="card__tipped" data-tip={tip} tabIndex={0}>{title}</span></h2>
    </div>
  );
}

// ---------------------------------------------------------------- swing

/** The swing metric is in percent; fmtSwing and swingScore take a fraction. */
const swingOf = (v: Values) => (v.swing === null ? null : v.swing / 100);

/**
 * Round swing per match. The career number is the hero card's; this panel shows the matches behind it,
 * the best and worst, and the bots' swing in the same matches. Where the swing comes from (kills,
 * damage, flashes, deaths) needs a per-source split the engine does not keep yet (swing.ts sums each
 * player's credits into one measure; only the flash share is kept apart).
 */
export function SwingCard({ you, list, bots }: { you: Rolled; list: MatchEntry[]; bots: Rolled | null }) {
  const swing = swingOf(you.v);
  const botSwing = bots ? swingOf(bots.v) : null;
  const per = [...list].reverse().map((s) => ({ s, v: swingOf(s.line.v) }));
  const known = per.filter((x) => x.v !== null) as { s: MatchEntry; v: number }[];
  const best = known.reduce<typeof known[number] | null>((b, x) => (!b || x.v > b.v ? x : b), null);
  const worst = known.reduce<typeof known[number] | null>((b, x) => (!b || x.v < b.v ? x : b), null);
  const positive = known.filter((x) => x.v > 0).length;
  return (
    <Card title="Round swing" tip={PANEL_TIP.swing} aside={<span className="meta">{plural(you.m.swingRounds, "round")} with swing</span>} className="swingcard">
      {swing === null ? <div className="meta"><NeedsDemo detail="Swing needs every player's equipment, which converted logs lack." /></div> : (
        <div className="swingcard__chart">
          <FormBars height={150} refValue={0} fmt={(x) => fmtSwing(x / 100)} score={(x) => swingScore(x / 100)} bars={per.map((x) => ({
            key: x.s.file, value: x.v === null ? null : 100 * x.v, label: fmtMatchDay(x.s.match), sub: x.s.result, result: x.s.result,
            onClick: () => openMatch(matchHref(x.s.file)), tip: `${mapName(x.s.match.map)} ${x.s.score.us}:${x.s.score.them}: ${fmtSwing(x.v)} per round`,
          }))} />
          <div className="swingcard__facts">
            <span><b className="num">{positive}</b><span className="faint">/{known.length}</span> matches with positive swing</span>
            {best && <a href={matchHref(best.s.file)}>Best <b className="num good-text">{fmtSwing(best.v)}</b> {fmtMatchDay(best.s.match)}</a>}
            {worst && <a href={matchHref(worst.s.file)}>Worst <b className="num poor-text">{fmtSwing(worst.v)}</b> {fmtMatchDay(worst.s.match)}</a>}
            {botSwing !== null && (
              <span className="swingcard__bots" data-tip="Bots in the same matches.">
                <span className="meta">Bots</span><b className="num">{fmtSwing(botSwing)}</b>
                <Delta d={100 * (swing - botSwing)} span={3} fmt={(x) => `${x.toFixed(2)} pts`} />
              </span>
            )}
          </div>
        </div>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------- role blend

/** What each role means, for the role name's tooltip. */
const ROLE_WHAT: Record<string, string> = {
  Entry: "Takes space first on T.",
  Lurker: "Plays away from the team on T.",
  "Half-lurker": "Starts with the team on T, then splits off.",
  Anchor: "Holds a bombsite on CT.",
  Rotator: "Moves between sites on CT.",
  Mixed: "Neither anchors nor rotates in most CT rounds.",
  AWPer: "Carries the AWP.",
};

/** Role shades: categorical, never good or bad; the top role is cream, the rest step down in tan. */
const SHADES = ["var(--cream)", "var(--tan)", "rgba(196, 160, 118, 0.6)", "rgba(196, 160, 118, 0.35)", "rgba(196, 160, 118, 0.2)"];

const rankedRoles = (b: RoleBlend | undefined) => (b?.blend ? Object.entries(b.blend).sort((x, y) => y[1] - x[1]) : []);

/**
 * The evidence behind the role as three numbers over every round: how often you carried an AWP, how
 * often you were in the opening duel, and when you died. They are the role model's own inputs
 * (identity.ts packerFeatures, roleBlend's AWP share), read from the rollup rather than parsed from the
 * engine's evidence sentences.
 */
function evidenceOf(m: Measures | undefined) {
  const x = m ? packerFeatures(m) : null;
  return {
    awp: m?.rounds ? (100 * m.roundsWithAwp) / m.rounds : null,
    opening: x?.oap ?? null,
    deathTime: x?.tapd ?? null,
  };
}

function RoleTiles({ m }: { m: Measures | undefined }) {
  const e = evidenceOf(m);
  return (
    <ul className="rtiles">
      <li data-tip={TIP.roundsWithAwp}>
        <span className="rtiles__ico"><GameIcon id="awp" width={34} height={12} fallback={<WeaponIcon name="awp" size={12} />} /></span>
        <b className="num">{e.awp === null ? "–" : fmtPct(e.awp, 0)}</b><span>AWP rounds</span>
      </li>
      <li data-tip={TIP.openingAttempts}>
        <span className="rtiles__ico"><FirstKillIcon size={15} /></span>
        <b className="num">{e.opening === null ? "–" : fmtPct(e.opening, 0)}</b><span>Opening duels</span>
      </li>
      <li data-tip="Seconds into the round when you usually die.">
        <span className="rtiles__ico"><GameIcon id="time" width={15} fallback={<TimeIcon size={15} />} /></span>
        <b className="num">{e.deathTime === null ? "–" : `${Math.round(e.deathTime)} s`}</b><span>Death time</span>
      </li>
    </ul>
  );
}

/** One side's blend: the top role and its fit on one line, every role as a segment of one bar. */
function SideFit({ b }: { b: RoleBlend }) {
  const roles = rankedRoles(b);
  const top = roles[0];
  return (
    <div className="rfit">
      <span className={`rfit__side ${b.side === "T" ? "t-text" : "ct-text"}`}>{b.side}</span>
      {top ? (
        <>
          <span className="rfit__role" data-tip={ROLE_WHAT[top[0]]} tabIndex={0}>{top[0]}</span>
          <b className="num rfit__pct">{fmtPct(100 * top[1], 0)}</b>
          <span className="rfit__bar" role="group" aria-label={`${b.side} role fit`}>
            {roles.map(([r, v], i) => <i key={r} tabIndex={0} aria-label={`${r} ${fmtPct(100 * v, 0)}`} style={{ width: `${100 * v}%`, background: SHADES[Math.min(i, SHADES.length - 1)] }} data-tip={`${r} ${fmtPct(100 * v, 0)}. ${ROLE_WHAT[r] ?? ""}`.trim()} />)}
          </span>
        </>
      ) : <span className="meta rfit__none"><NeedsDemo detail="The role needs positions, which converted logs lack." /></span>}
    </div>
  );
}

/** A map's role on each side, from the engine's role call narrowed to that map. */
function MapRoles({ q, map }: { q: Query; map: string }) {
  const mq = useMemo(() => ({ ...q, filter: { ...q.filter, maps: [map] } }), [q, map]);
  const r = useCall("roles", [mq]).data;
  const cell = (b: RoleBlend | undefined) => {
    const top = rankedRoles(b)[0];
    return top ? <span className="rmaps__cell"><span data-tip={ROLE_WHAT[top[0]]} tabIndex={0}>{top[0]}</span><b className="num">{fmtPct(100 * top[1], 0)}</b></span> : <span className="faint">–</span>;
  };
  return (
    <li>
      <span className="rmaps__map"><MapThumb map={map} size={18} />{mapName(map)}</span>
      <span className="t-text rmaps__side">T</span>{cell(r?.T)}
      <span className="ct-text rmaps__side">CT</span>{cell(r?.CT)}
    </li>
  );
}

/**
 * The engine's role blend (identity.ts): a model fitted on labelled pros gives each side its own blend.
 * The headline is the two sides' roles; the engine has no single role over both sides (roles() answers
 * per side only), so none is made up here. Below: the evidence over every round, each side's fit, and
 * each map's roles.
 */
export function RoleCard({ q, maps = [] }: { q: Query; maps?: string[] }) {
  const r = useCall("roles", [q]);
  const all = useRollups(useMemo(() => [q], [q])).data?.[0];
  if (!r.data) {
    return <Card title="Role" tip={PANEL_TIP.role} className="rolecard">{r.error ? <p className="meta">{r.error}</p> : <div className="skel" style={{ height: 220 }} />}</Card>;
  }
  const sides = [r.data.T, r.data.CT];
  const tops = sides.map((b) => rankedRoles(b)[0]?.[0] ?? null);
  return (
    <Card title="Role" tip={PANEL_TIP.role} aside={<span className="meta">{sides[0].rounds} T rounds, {sides[1].rounds} CT rounds</span>} className="rolecard">
      <div className="role__head">
        {sides.map((b, i) => (
          <span key={b.side} className="role__headpart">
            <span className={b.side === "T" ? "t-text" : "ct-text"}>{b.side}</span>
            <b className="role__label" {...(tops[i] ? { "data-tip": ROLE_WHAT[tops[i]!], tabIndex: 0 } : {})}>{tops[i] ?? "Not enough data"}</b>
          </span>
        ))}
      </div>
      <RoleTiles m={all?.m} />
      <div className="rfits">{sides.map((b) => <SideFit key={b.side} b={b} />)}</div>
      {maps.length > 0 && (
        <>
          <h3 className="caps rmaps__h">By map</h3>
          <ul className="rmaps">{maps.map((m) => <MapRoles key={m} q={q} map={m} />)}</ul>
        </>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------- similarity

function ProFace({ pro, className }: { pro: Pro; className: string }) {
  return <RemoteImg src={pro.photo} alt={`${pro.name}`} className={className} fallback={<Initials name={pro.name} className={`${className}--init`} />} />;
}

function ProMarks({ pro }: { pro: Pro }) {
  return (
    <span className="promarks">
      {pro.flag && <RemoteImg src={pro.flag} alt={pro.country} className="promarks__flag" fallback={<span className="promarks__code">{pro.code}</span>} />}
      <RemoteImg src={pro.logo} alt={pro.team} className="promarks__logo" fallback={null} />
      <span>{pro.team}</span>
    </span>
  );
}

/** A pro's scores on one side, in ATTRIBUTE_ORDER. */
const proScores = (pro: Pro, side: PoolSide) => (side === "both" ? pro.both : side === "CT" ? pro.ct : pro.t);
/** A pro's six style scores, in the order the engine lists them (identity.ts STYLE). */
const styleOf = (v: (number | null)[]) => styleIds().map((id) => v[ATTRIBUTE_ORDER.indexOf(id as AttributeId)]);

/**
 * "Plays like": the shape of your six style attributes on T and on CT against each pro's (identity.ts
 * mostSimilar in the worker, cosine similarity over the twelve scores, design/identity.md). Your scores
 * rank against the bot careers in your matches and a pro's against pros, so only the shape compares;
 * the radar and table show the selected side, each number labelled with its population.
 */
export function PlaysLike({ q, side, initial }: { q: Query; side: PoolSide; initial: string | null }) {
  const pack = usePros();
  if (pack.state === "ready") return <PlaysLikeBody q={q} side={side} initial={initial} pros={pack.pros} />;
  return (
    <Card title="Plays like" tip={PANEL_TIP.playsLike}>
      {pack.state === "loading" ? <div className="skel" style={{ height: 220 }} /> : (
        <div className="packmiss">
          <svg viewBox="0 0 120 80" width="120" height="80" aria-hidden className="packmiss__art">
            <circle cx="40" cy="30" r="14" fill="none" stroke="var(--line2)" strokeWidth="1.5" /><path d="M16 74c3-14 13-22 24-22s21 8 24 22" fill="none" stroke="var(--line2)" strokeWidth="1.5" />
            <circle cx="84" cy="30" r="14" fill="none" stroke="var(--tan)" strokeWidth="1.5" strokeDasharray="3 3" /><path d="M60 74c3-14 13-22 24-22s21 8 24 22" fill="none" stroke="var(--tan)" strokeWidth="1.5" strokeDasharray="3 3" />
          </svg>
          <div>
            <b>{pack.state === "missing" ? "Add the pro pack to compare with pros" : "The pro pack could not be read"}</b>
            <p className="meta">{pack.state === "missing" ? <>Put <span className="mono">pros.json</span> in <span className="mono">{PACKS_FOLDER}</span> and this compares your six style attributes with each pro's.</> : pack.message}</p>
          </div>
        </div>
      )}
    </Card>
  );
}

function PlaysLikeBody({ q, side, initial, pros }: { q: Query; side: PoolSide; initial: string | null; pros: Pro[] }) {
  const bySlug = useMemo(() => new Map(pros.map((p) => [p.slug, p])), [pros]);
  const pack = useMemo(() => pros.map((p) => ({ slug: p.slug, both: p.both, ct: p.ct, t: p.t })), [pros]);
  const res = useCall("playsLike", [q, pack]);
  // your scores on the radar's side, in the role pool "plays like" reads
  const mine = useCall("style", [q, { side }]);
  const ranked = useMemo(() => (res.data?.ranked ?? []).flatMap((x) => { const item = bySlug.get(x.slug); return item ? [{ item, pct: Math.round(x.similarity) }] : []; }), [res.data, bySlug]);
  const attrs = useMemo(() => (mine.data ? attrsOf(mine.data.scores) : []), [mine.data]);
  const [sel, setSel] = useState<string | null>(initial);
  // a keyboard pick swaps the radar's shape at once; a click morphs it (components/charts.tsx AttrRadar)
  const [instant, setInstant] = useState(true);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { if (initial) ref.current?.scrollIntoView({ block: "start" }); }, [initial]);
  const error = res.error ?? mine.error;
  if (!res.data || !mine.data) {
    return <Card title="Plays like" tip={PANEL_TIP.playsLike}>{error ? <p className="meta">{error}</p> : <div className="skel" style={{ height: 220 }} />}</Card>;
  }
  const careers = res.data.careers;
  const top = ranked.slice(0, 6);
  const pick = (sel && ranked.find((x) => x.item.slug === sel)) || top[0];
  if (!pick) {
    return (
      <Card title="Plays like" tip={PANEL_TIP.playsLike}>
        <p className="meta"><NeedsDemo detail="Too few bot careers in these matches to score your style." /></p>
      </Card>
    );
  }
  const style = styleIds();
  const you = style.map((id) => attrs.find((a) => a.id === id)?.score ?? null);
  const labels = style.map((id) => attrs.find((a) => a.id === id)?.label ?? id);
  const sideLabel = side === "both" ? "Both sides" : `${side} side`;
  return (
    <div ref={ref} id="similar">
      <Card title="Plays like" tip={PANEL_TIP.playsLike} aside={<span className="meta">{sideLabel}</span>} foot={<span>Pro scores and photos: HLTV</span>}>
        <div className="likes">
          <div className="likes__left">
            <a className="probanner" href={`${HLTV_ORIGIN}${pick.item.hltv}`} target="_blank" rel="noreferrer" data-tip="Opens their HLTV page.">
              <ProFace pro={pick.item} className="probanner__face" />
              <div className="probanner__body">
                <ProMarks pro={pick.item} />
                <b className="probanner__name">{pick.item.name}</b>
                <span className="meta">Rating 3.0 {pick.item.rating3.toFixed(2)} against top-20 teams</span>
              </div>
              <span className="probanner__score">
                <b className={`probanner__pct num ${careers.provisional ? "is-prov" : ""}`} data-tip={careers.provisional ? PROVISIONAL_TIP : "How closely your style's shape matches theirs."}>{pick.pct}<small>%</small></b>
              </span>
            </a>
            <ul className="prolist" role="radiogroup" aria-label={`Pros by style match${careers.provisional ? ", provisional" : ""}`}>
              {top.map((x) => (
                <li key={x.item.slug}>
                  <button role="radio" aria-checked={x.item.slug === pick.item.slug} className="prorow" onClick={(e) => { setInstant(e.detail === 0); setSel(x.item.slug); setQuery("pro", x.item.slug); }}>
                    <span className="prorow__face"><ProFace pro={x.item} className="prorow__img" /></span>
                    <span className="prorow__name"><b>{x.item.name}</b><ProMarks pro={x.item} /></span>
                    <b className="num prorow__pct">{x.pct}%</b>
                  </button>
                </li>
              ))}
            </ul>
          </div>
          <div className="likes__right">
            <AttrRadar labels={labels} you={you} other={styleOf(proScores(pick.item, side))} otherLabel={pick.item.name} size={380} instant={instant} provisional={careers.provisional} provisionalTip={PROVISIONAL_TIP} />
            <div className="legend likes__legend"><span><i className="swatch" style={{ background: "var(--cream)" }} />You, against bot careers</span><span><i className="swatch swatch--dash" />{pick.item.name}, against pros</span></div>
            <VsTable you={you} labels={labels} pro={pick.item} side={side} />
          </div>
        </div>
      </Card>
    </div>
  );
}

/**
 * Your score and the pro's on each style attribute, side by side. No difference column: the two rank
 * against different populations, so their gap is not a level either player could close.
 */
function VsTable({ you, labels, pro, side }: { you: (number | null)[]; labels: string[]; pro: Pro; side: PoolSide }) {
  const theirs = styleOf(proScores(pro, side));
  return (
    <div className="vs vs--wide vs--pair">
      <div className="vs__head"><span className="caps" data-tip="Your score against bots in your matches.">You</span><span /><span className="vs__pro" data-tip="Their score against pros.">{pro.name}</span></div>
      {styleIds().map((id, i) => (
        <div key={id} className="vs__row">
          <span className="num cream">{you[i] === null ? "–" : Math.round(you[i]!)}</span>
          <span className="vs__lbl"><AttrIcon id={id as AttributeId} size={13} />{labels[i]}</span>
          <span className="num">{theirs[i] ?? "–"}</span>
        </div>
      ))}
    </div>
  );
}

export function RatingLegend({ children }: { children?: ReactNode }) {
  return (
    <div className="legend">
      <span><svg width="18" height="8" aria-hidden><line x1="0" y1="4" x2="18" y2="4" stroke="var(--cream)" strokeWidth="1.75" /></svg>Rating per match</span>
      <span><svg width="18" height="8" aria-hidden><line x1="0" y1="4" x2="18" y2="4" stroke="var(--cream)" strokeDasharray="2 4" /></svg>Your pooled rating</span>
      <span><svg width="18" height="8" aria-hidden><line x1="0" y1="4" x2="18" y2="4" stroke="var(--ink3)" strokeDasharray="3 3" /></svg>1.00, an average player</span>
      <span><svg width="8" height="8" aria-hidden><circle cx="4" cy="4" r="3.5" fill="var(--good-text)" /></svg>Best</span>
      <span><svg width="8" height="8" aria-hidden><circle cx="4" cy="4" r="3.5" fill="var(--poor-text)" /></svg>Worst</span>
      {children}
    </div>
  );
}

// ---------------------------------------------------------------- how good

/** HLTV's "how good" metrics, in the order HLTV lists them beside Rating 3.0. */
const HOW_GOOD = ["tradeKillSuccess", "tradedDeathSuccess", "openingSwing", "clutchSwing", "oneVsOne", "awpSwing", "awpDuelWin", "flashSwing", "assistsPerFlash", "dmgPerHe", "grenadeDmgTaken"];

/** The performance tables HLTV pairs with Rating 3.0, each with its percentile against pros on the page's side. */
export function HowGood({ q, side }: { q: Query; side: PoolSide }) {
  const r = useCall("compare", [q, { side }]);
  const p = r.data?.p ?? null;
  return (
    <Card title="How good" tip={PANEL_TIP.howGood} aside={<span className="meta">{r.data ? `Against ${r.data.n} ${proPoolName(r.data.role)}` : "Against pros"}</span>}>
      {!p ? (r.error ? <p className="meta">{r.error}</p> : <div className="skel" style={{ height: 240 }} />) : (
        <div className="howgood">
          {HOW_GOOD.filter((id) => metric(id).status !== "unavailable" && p[id]).map((id) => (
            <Percentile key={id} variant="quiet" {...pctProps(id, p[id], p[id].value)} kind="performance" population={proPoolName(r.data!.role)} />
          ))}
        </div>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------- one metric as a percentile row

/** A formatted value split from its unit, so the unit can be set smaller: "28.6%" is "28.6" and "%". */
export function splitUnit(text: string): { value: string; unit?: string } {
  const m = /^([−+-]?\$?[\d.,]+)(\s?(?:%|ms|s|°))$/.exec(text);
  return m ? { value: m[1], unit: m[2] } : { value: text };
}

/** The percentile row's props for one metric, from a metric value and its engine percentile. */
export function pctProps(id: string, p: Pct | undefined, value: number | null | undefined) {
  const m = metric(id);
  const v = value ?? p?.value ?? null;
  const text = v === null ? null : splitUnit(fmtMetric(id, v));
  return {
    label: m.label,
    value: text?.value ?? null,
    unit: text?.unit,
    pct: p?.pct ?? null,
    def: tipOf(id),
    approx: m.status === "approx",
    reason: p?.reason ?? null,
    // a missing value with no reason means the matches hold none of it (no 1v1s, no AWP duels)
    unavailable: v === null && !p?.reason ? "None in these matches" : undefined,
  };
}
