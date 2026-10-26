// Profile sections: the round-swing card, the role blend in plain words, and the "plays like" view
// against the pro pack.
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Percentile as Pct, SideKey as PoolSide } from "../../../stats/compare";
import type { Measures } from "../../../stats/facts";
import { packerFeatures, type RoleBlend, type RoleSignal } from "../../../stats/identity";
import type { Query, Rolled, Values } from "../../../worker/protocol";
import { Delta, Initials, Num, RemoteImg } from "../../components/bits";
import { Card } from "../../components/Card";
import { AttrRadar } from "../../components/charts";
import { Fig, MatchLollipops, symmetricMax } from "../../components/MatchSeries";
import { attrsOf, fmtMetric, ratingTerms, signalBar } from "../../data/engine";
import { useCall, useRollups } from "../../data/hooks";
import { PANEL_TIP, PROVISIONAL_TIP, tipOf } from "../../data/tips";
import { metric, roleSignals, styleIds } from "../../data/meta";
import type { MatchEntry } from "../../data/match";
import { ATTRIBUTE_ORDER, HLTV_ORIGIN, usePros, type AttributeId, type Pro } from "../../data/packs";
import { PACKS_FOLDER } from "../../../host/host";
import { AttrIcon } from "../../icons/attributes";
import { fmtMatchDay, fmtPct, fmtSwing, mapName, plural } from "../../lib/format";
import { BreakRows, NeedsDemo } from "../shared";
import { DotTrack, SwingSourcesChart } from "./v2";
import { MapThumb } from "../../components/bits";
import { matchHref, setQuery } from "../../router";

export function SectionHead({ title, tip, id, sectionRef }: { title: string; tip: string; id?: string; sectionRef?: (el: HTMLElement | null) => void }) {
  return (
    <div className="shead" id={id} ref={sectionRef}>
      <h2 className="shead__t"><span className="card__tipped" data-tip={tip} tabIndex={0}>{title}</span></h2>
    </div>
  );
}

// ---------------------------------------------------------------- rating breakdown

const signedNum = (v: number) => `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(3)}`;

/**
 * Rating 3.0's breakdown, as main showed it: each input with its weight, the input's value and its
 * contribution, then the constant. The rows add up to the rating (engine.ts ratingTerms).
 */
export function RatingTerms({ inputs }: { inputs: Record<string, number> }) {
  const { terms, intercept } = ratingTerms(inputs);
  return (
    <BreakRows rows={[
      ...terms.map((t) => ({
        label: <>{t.label} <span className="faint">× {t.coefficient < 0 ? "−" : ""}{Math.abs(t.coefficient).toFixed(4)}</span></>,
        value: <><span className="faint">{t.input} → </span>{signedNum(t.contribution)}</>,
      })),
      { label: "Constant", value: signedNum(intercept) },
    ]} />
  );
}

// ---------------------------------------------------------------- swing

/** The swing metric is in percent; fmtSwing and swingScore take a fraction. */
const swingOf = (v: Values) => (v.swing === null ? null : v.swing / 100);

/**
 * Round swing. The career number is the hero card's; this panel shows the matches behind it as
 * lollipops from zero (data decides the width), with the average, the positive matches, the best and
 * the worst beside them and the bots' swing in the same matches, then where it comes from (the
 * engine's per-source split, Rolled.swingSources, as a waterfall that ends at the total).
 */
export function SwingCard({ you, list, bots, swingOf: matchSwing }: { you: Rolled; list: MatchEntry[]; bots: Rolled | null; /** a match's swing per round on the page's side, a fraction */ swingOf: (e: MatchEntry) => number | null }) {
  const swing = swingOf(you.v);
  const botSwing = bots ? swingOf(bots.v) : null;
  const per = [...list].reverse().map((s) => ({ s, v: matchSwing(s) }));
  const known = per.filter((x) => x.v !== null) as { s: MatchEntry; v: number }[];
  const best = known.reduce<typeof known[number] | null>((b, x) => (!b || x.v > b.v ? x : b), null);
  const worst = known.reduce<typeof known[number] | null>((b, x) => (!b || x.v < b.v ? x : b), null);
  const positive = known.filter((x) => x.v > 0);
  const scale = symmetricMax(known.map((x) => 100 * x.v));
  const dayScore = (e: MatchEntry) => `${fmtMatchDay(e.match)}, ${e.score.us}:${e.score.them}`;
  return (
    <Card title="Round swing" tip={PANEL_TIP.swing} aside={<span className="meta">{plural(you.m.swingRounds, "round")} with swing{known.length ? `, scale ±${scale}%` : ""}</span>} className="swingcard">
      {swing === null ? <div className="meta"><NeedsDemo detail="Swing needs every player's equipment, which converted logs lack." /></div> : (
        <>
          <div className="series">
            <MatchLollipops label="Round swing by match" fmt={(x) => fmtSwing(x / 100)} mean={100 * swing}
              points={per.map((x) => ({ key: x.s.file, value: x.v === null ? null : 100 * x.v, label: fmtMatchDay(x.s.match), result: x.s.result, href: matchHref(x.s.file) }))} />
            <dl className="figs figs--wide">
              <Fig label="Average" value={<Num v={fmtSwing(swing)} />} tone={swing > 0 ? "good" : swing < 0 ? "poor" : undefined} sub={`per round, ${plural(known.length, "match", "matches")}`} />
              <Fig label="Positive matches" value={<>{positive.length}<small> of {known.length}</small></>} sub={`${positive.filter((x) => x.s.result === "W").length} of those won`} />
              {best && <Fig label="Best" tone="good" value={<Num v={fmtSwing(best.v)} />} href={matchHref(best.s.file)} sub={dayScore(best.s)} />}
              {worst && worst !== best && <Fig label="Worst" tone="poor" value={<Num v={fmtSwing(worst.v)} />} href={matchHref(worst.s.file)} sub={dayScore(worst.s)} />}
              {botSwing !== null && (
                <Fig label="Bots" value={<Num v={fmtSwing(botSwing)} />} sub={<span className="swingcard__bots" data-tip="Bots in the same matches." tabIndex={0}><Delta d={100 * (swing - botSwing)} span={3} fmt={(x) => `${x.toFixed(2)} pts`} /> you vs them</span>} />
              )}
            </dl>
          </div>
          {you.swingSources && (
            <div className="swingcard__src">
              <h3 className="caps swingcard__h">By source</h3>
              <SwingSourcesChart you={you.swingSources} bots={bots?.swingSources ?? null} />
            </div>
          )}
        </>
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
    // the AWP share counts only rounds whose freeze-end loadout was recorded (identity.ts roleBlend)
    awp: m?.loadoutRounds ? (100 * m.roundsWithAwp) / m.loadoutRounds : null,
    loadoutRounds: m?.loadoutRounds ?? 0,
    rounds: m?.rounds ?? 0,
    opening: x?.oap ?? null,
    deathTime: x?.tapd ?? null,
  };
}

function RoleTiles({ m }: { m: Measures | undefined }) {
  const e = evidenceOf(m);
  return (
    <ul className="rtiles">
      <li tabIndex={0} data-tip={e.awp === null ? "No loadout recorded, so the AWP share is unknown." : e.loadoutRounds < e.rounds ? `Rounds you carry an AWP, of ${e.loadoutRounds} with a recorded loadout.` : tipOf("roundsWithAwp")}>
        <b className="disp disp--m">{e.awp === null ? "–" : <Num v={fmtPct(e.awp, 0)} />}</b><span className="caps">AWP rounds</span>
      </li>
      <li tabIndex={0} data-tip={tipOf("openingAttempts")}>
        <b className="disp disp--m">{e.opening === null ? "–" : <Num v={fmtPct(e.opening, 0)} />}</b><span className="caps">Opening duels</span>
      </li>
      <li tabIndex={0} data-tip="Seconds into the round when you usually die.">
        <b className="disp disp--m">{e.deathTime === null ? "–" : <Num v={`${Math.round(e.deathTime)}s`} />}</b><span className="caps">Death time</span>
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

/** The top role of a blend and its share, as a cell; a dash without a blend. */
function RoleCell({ blend }: { blend: Record<string, number> | null | undefined }) {
  const top = blend ? Object.entries(blend).sort((x, y) => y[1] - x[1])[0] : undefined;
  return top ? <span className="rmaps__cell"><span data-tip={ROLE_WHAT[top[0]]} tabIndex={0}>{top[0]}</span><b className="num">{fmtPct(100 * top[1], 0)}</b></span> : <span className="faint">–</span>;
}

/** Each map's role over all its rounds and on each side, from one rolesByMap call (most rounds first). */
function MapRoles({ q }: { q: Query }) {
  const r = useCall("rolesByMap", [q]).data;
  if (!r?.length) return null;
  return (
    <>
      <h3 className="caps rmaps__h">By map</h3>
      <ul className="rmaps rmaps--all">
        {r.map((m) => (
          <li key={m.map}>
            <span className="rmaps__map"><MapThumb map={m.map} size={18} />{mapName(m.map)}</span>
            <RoleCell blend={m.all.blend} />
            <span className="t-text rmaps__side">T</span><RoleCell blend={m.T.blend} />
            <span className="ct-text rmaps__side">CT</span><RoleCell blend={m.CT.blend} />
          </li>
        ))}
      </ul>
    </>
  );
}

/**
 * The engine's role blend (identity.ts): a model fitted on labelled pros gives each side its own blend,
 * and roles().all weights the two by their rounds into one role over every round (overallRole). The
 * headline is that overall role, the two sides' roles beside it. Below: the evidence over every round,
 * each side's fit, and each map's roles (rolesByMap).
 */
export function RoleCard({ q }: { q: Query }) {
  const r = useCall("roles", [q]);
  const all = useRollups(useMemo(() => [q], [q])).data?.[0];
  if (!r.data) {
    return <Card title="Role" tip={PANEL_TIP.role} className="rolecard">{r.error ? <p className="meta">{r.error}</p> : <div className="skel" style={{ height: 220 }} />}</Card>;
  }
  const sides = [r.data.T, r.data.CT];
  const tops = sides.map((b) => rankedRoles(b)[0]?.[0] ?? null);
  const overall = r.data.all.blend ? Object.entries(r.data.all.blend).sort((x, y) => y[1] - x[1])[0] : null;
  return (
    <Card title="Role" tip={PANEL_TIP.role} aside={<span className="meta">{sides[0].rounds} T rounds, {sides[1].rounds} CT rounds</span>} className="rolecard">
      {overall && (
        <p className="role__overall">
          <b className="role__name" data-tip={ROLE_WHAT[overall[0]]} tabIndex={0}>{overall[0]}</b>
          <span className="meta" data-tip="Each side's role weighted by its rounds." tabIndex={0}>{fmtPct(100 * overall[1], 0)} of all rounds</span>
        </p>
      )}
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
      <RoleSignals q={q} />
      <MapRoles q={q} />
    </Card>
  );
}

const UNIT_M = 0.0254; // one Source unit is one inch

/** Main's sentences for each signal (stats/role.ts on main), with the thresholds from identity.ts ROLE_SIGNALS. */
const SIGNAL_TEXT: Record<RoleSignal["id"], { what: string; you: (v: number) => string; bar: (t: number) => string; missing: ReactNode }> = {
  Entry: {
    what: "Takes the first duel of the round.",
    you: (v) => `You are in the first duel of ${fmtPct(v, 0)} of rounds.`,
    bar: (t) => `Entry players: ${t}% or more (the average is 20%).`,
    missing: "Needs rounds with a kill log.",
  },
  Support: {
    what: "Plays off teammates: trades and assists rather than first kills.",
    you: (v) => `${fmtPct(v, 0)} of your kills and assists are trades or assists.`,
    bar: (t) => `Support players: ${t}% or more.`,
    missing: "Needs kills or assists.",
  },
  Lurker: {
    what: "Plays away from the team on T, before the bomb is planted.",
    you: (v) => `You stand ${Math.round(v).toLocaleString("en")} units (about ${Math.round(v * UNIT_M)} m) from your nearest teammate.`,
    bar: (t) => `Lurkers: ${t.toLocaleString("en")} units (about ${Math.round(t * UNIT_M)} m) or more.`,
    missing: <NeedsDemo detail="The distance comes from position samples taken while all five T players are alive; converted logs have no positions." />,
  },
};

/**
 * Main's role signals under the engine's blend: each signal's metric against its hand-set threshold
 * (identity.ts ROLE_SIGNALS), the bar filled to twice the threshold with the threshold ticked, and
 * "You fit" from the threshold up (engine.ts signalBar). Entry and Support read both sides, Lurker T.
 */
export function RoleSignals({ q }: { q: Query }) {
  const qs = useMemo(() => {
    const { sides: _sides, ...rest } = q.filter;
    return [{ files: q.files, filter: rest }, { files: q.files, filter: { ...rest, sides: ["T" as const] } }];
  }, [q]);
  const r = useRollups(qs).data;
  if (!r || r.length !== 2) return null;
  const [both, t] = r;
  return (
    <>
      <h3 className="caps rmaps__h">Signals <span className="help" data-tip="The tick is the threshold, set by hand, not fitted." tabIndex={0} aria-label="What the ticks mean">?</span></h3>
      <ul className="signals2">
        {roleSignals().map((sg) => {
          const v = (sg.side === "T" ? t : both).v[sg.metric];
          const text = SIGNAL_TEXT[sg.id];
          const bar = v === null ? null : signalBar(v, sg.threshold);
          return (
            <li key={sg.id} className={bar?.fits ? "is-on" : bar ? "" : "is-na"} data-signal={sg.id}>
              <div className="signals2__top"><b>{sg.id}</b><span className="meta">{text.what}</span>{bar?.fits && <span className="chip chip--outline">You fit</span>}</div>
              <div className="signals2__track" aria-hidden><i style={{ width: `${100 * (bar?.fill ?? 0)}%` }} /><em style={{ left: "50%" }} /></div>
              <p className="signals2__you">{v === null ? text.missing : text.you(v)} <span className="faint">{text.bar(sg.threshold)}</span></p>
            </li>
          );
        })}
      </ul>
    </>
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
 * the radar and the two-marker table show the selected side, each number labelled with its population.
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
      <Card title="Plays like" tip={PANEL_TIP.playsLike} aside={<span className="meta">Shape of the six attributes, {sideLabel.toLowerCase()}</span>} foot={<span>Pro scores and photos: HLTV</span>}>
        <div className="likes">
          <div className="likes__left">
            <a className="probanner" href={`${HLTV_ORIGIN}${pick.item.hltv}`} target="_blank" rel="noreferrer" data-tip={careers.provisional ? `${PROVISIONAL_TIP}\nOpens their HLTV page.` : "Opens their HLTV page."}>
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
          <div className="likes__radar">
            <AttrRadar labels={labels} you={you} other={styleOf(proScores(pick.item, side))} otherLabel={pick.item.name} size={320} instant={instant} provisional={careers.provisional} provisionalTip={PROVISIONAL_TIP} />
            <div className="legend likes__legend"><span><i className="swatch" style={{ background: "var(--cream)" }} />You, against bots</span><span><i className="swatch swatch--dash" />{pick.item.name}, against pros</span></div>
          </div>
          <div className="likes__right">
            <VsTable you={you} labels={labels} pro={pick.item} side={side} />
          </div>
        </div>
      </Card>
    </div>
  );
}

/**
 * Your score and the pro's on each style attribute: one 0-to-100 track per attribute with your marker
 * (filled) and theirs (hollow), the two numbers after it. No difference column: the two rank against
 * different populations, so their gap is not a level either player could close.
 */
function VsTable({ you, labels, pro, side }: { you: (number | null)[]; labels: string[]; pro: Pro; side: PoolSide }) {
  const theirs = styleOf(proScores(pro, side));
  return (
    <div className="vs vs--two">
      <div className="vs__head"><span /><span className="vs__key meta"><i className="vs__you" />you <i className="vs__them" />{pro.name}</span><span className="caps" data-tip="Your score against bots in your matches." tabIndex={0}>You</span><span className="vs__pro caps" data-tip="Their score against pros." tabIndex={0}>{pro.name}</span></div>
      {styleIds().map((id, i) => (
        <div key={id} className="vs__row">
          <span className="vs__lbl"><AttrIcon id={id as AttributeId} size={13} />{labels[i]}</span>
          <DotTrack at={you[i]} ghost={theirs[i]} tone="cream" label={`${labels[i]}: you ${you[i] === null ? "no score" : Math.round(you[i]!)}, ${pro.name} ${theirs[i] ?? "no score"}`} />
          <span className="num vs__mine">{you[i] === null ? "–" : Math.round(you[i]!)}</span>
          <span className="num">{theirs[i] ?? "–"}</span>
        </div>
      ))}
    </div>
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
