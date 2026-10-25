// Profile sections: the round-swing card, the role blend in plain words, the "plays like" view
// against the pro pack, and the how-good table.
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { SideKey as PoolSide } from "../../../stats/compare";
import type { RoleSignal } from "../../../stats/identity";
import type { Query, Rolled, Values } from "../../../worker/protocol";
import { Delta, Initials, RemoteImg } from "../../components/bits";
import { Card } from "../../components/Card";
import { AttrRadar, FormBars } from "../../components/charts";
import { attrsOf, BOTS_TIP, fmtMetric, rankText, ratingTerms, signalBar } from "../../data/engine";
import { useCall, useRollups } from "../../data/hooks";
import { awperKpr, metric, roleSignals, styleIds } from "../../data/meta";
import type { MatchEntry } from "../../data/match";
import { ATTRIBUTE_ORDER, HLTV_ORIGIN, usePros, type AttributeId, type Pro } from "../../data/packs";
import { PACKS_FOLDER } from "../../../host/host";
import { AttrIcon } from "../../icons/attributes";
import { fmtDec, fmtMatchDay, fmtPct, fmtSwing, mapName, plural } from "../../lib/format";
import { scoreText, swingScore } from "../../lib/scale";
import { ApproxMark, BreakRows, NeedsDemo, NotCompared, Provisional } from "../shared";
import { BENCH, verdictOf } from "../../lib/verdict";
import { matchHref, openMatch, setQuery } from "../../router";

export function SectionHead({ title, sub, id }: { title: string; sub: string; id?: string }) {
  return (
    <div className="shead" id={id}>
      <h2 className="shead__t">{title}</h2>
      <p className="shead__s">{sub}</p>
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
        label: <>{t.label} <span className="faint">× {t.coefficient.toFixed(4)}</span></>,
        value: <><span className="faint">{t.input} → </span>{signedNum(t.contribution)}</>,
      })),
      { label: "Constant", value: signedNum(intercept) },
    ]} />
  );
}

// ---------------------------------------------------------------- swing

/** The swing metric is in percent; fmtSwing and swingScore take a fraction. */
const swingOf = (v: Values) => (v.swing === null ? null : v.swing / 100);

export function SwingCard({ you, list, bots }: { you: Rolled; list: MatchEntry[]; bots: Rolled | null }) {
  const swing = swingOf(you.v);
  const botSwing = bots ? swingOf(bots.v) : null;
  const per = [...list].reverse().map((s) => ({ s, v: swingOf(s.line.v) }));
  const known = per.filter((x) => x.v !== null) as { s: MatchEntry; v: number }[];
  const best = known.reduce<typeof known[number] | null>((b, x) => (!b || x.v > b.v ? x : b), null);
  const worst = known.reduce<typeof known[number] | null>((b, x) => (!b || x.v < b.v ? x : b), null);
  const positive = known.filter((x) => x.v > 0).length;
  const v = verdictOf(swing === null ? null : 100 * swing, BENCH.swing);
  return (
    <Card title="Round swing" aside={<span className="meta">{plural(you.m.swingRounds, "round")} with swing</span>} className="swingcard">
      <div className="swingcard__grid">
        <div className="swingcard__big">
          <b className="num" style={{ color: swing === null ? undefined : scoreText(swingScore(swing)) }}>{fmtSwing(swing)}</b>
          <span className="verdict" data-v={v}>{v === "good" ? "Good" : v === "poor" ? "Poor" : v === "avg" ? "Average" : ""}</span>
          <p className="swingcard__say">
            {swing === null ? <NeedsDemo detail="No round in these matches has swing: a converted log values a round only where every player's equipment is known." />
              : `Each round you ${swing >= 0 ? "add" : "take"} ${Math.abs(100 * swing).toFixed(2)} percentage points ${swing >= 0 ? "to" : "from"} your team's chance of winning it, through your kills and deaths.`}
          </p>
          {botSwing !== null && <p className="meta">Bots in the same matches: <b className="num">{fmtSwing(botSwing)}</b>. <Delta d={swing === null ? null : 100 * (swing - botSwing)} span={3} fmt={(x) => `${x.toFixed(2)} pts`} /> against them.</p>}
        </div>
        <div className="swingcard__chart">
          <FormBars height={150} refValue={0} fmt={(x) => fmtSwing(x / 100)} score={(x) => swingScore(x / 100)} bars={per.map((x) => ({
            key: x.s.file, value: x.v === null ? null : 100 * x.v, label: fmtMatchDay(x.s.match), sub: x.s.result, result: x.s.result,
            onClick: () => openMatch(matchHref(x.s.file)), tip: `${mapName(x.s.match.map)} ${x.s.score.us}:${x.s.score.them}: ${fmtSwing(x.v)} per round`,
          }))} />
          <div className="swingcard__facts">
            <span><b className="num">{positive}</b><span className="faint">/{known.length}</span> matches with positive swing</span>
            {best && <a href={matchHref(best.s.file)}>Best <b className="num good-text">{fmtSwing(best.v)}</b> {fmtMatchDay(best.s.match)}</a>}
            {worst && <a href={matchHref(worst.s.file)}>Worst <b className="num poor-text">{fmtSwing(worst.v)}</b> {fmtMatchDay(worst.s.match)}</a>}
          </div>
        </div>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------- role blend

const ROLE_WHAT: Record<string, string> = {
  Entry: "Takes space first on T.",
  Lurker: "Plays away from the team on T.",
  "Half-lurker": "Starts with the team on T, then splits off.",
  Anchor: "Holds a bombsite on CT.",
  Rotator: "Moves between sites on CT.",
  Mixed: "Neither anchors nor rotates most CT rounds.",
  AWPer: "Carries the AWP.",
};

/**
 * The engine's role blend per side (identity.ts): shares of each role from a model fitted on
 * labelled pros, with the evidence behind them in words.
 */
export function RoleCard({ q }: { q: Query }) {
  const r = useCall("roles", [q]);
  if (!r.data) {
    return <Card title="Role" className="rolecard">{r.error ? <p className="meta">{r.error}</p> : <div className="skel" style={{ height: 220 }} />}</Card>;
  }
  const sides = [r.data.T, r.data.CT];
  return (
    <Card title="Role" aside={<span className="meta">{sides[0].rounds} T rounds, {sides[1].rounds} CT rounds</span>} className="rolecard">
      {sides.map((b) => {
        const roles = b.blend ? Object.entries(b.blend).sort((x, y) => y[1] - x[1]) : [];
        return (
          <div key={b.side}>
            <div className="rolecard__head">
              <b className={`role__label ${b.side === "T" ? "t-text" : "ct-text"}`}>{b.side}: {roles[0]?.[0] ?? "Not enough data"}</b>
              <p className="meta">{b.evidence.join(" ")}</p>
            </div>
            {b.blend ? (
              <ul className="signals2">
                {roles.map(([role, share], i) => (
                  <li key={role} className={i === 0 ? "is-on" : ""}>
                    <div className="signals2__top"><b>{role}</b><span className="meta">{ROLE_WHAT[role] ?? ""}</span></div>
                    <div className="signals2__track" aria-hidden><i style={{ width: `${100 * share}%` }} /></div>
                    <p className="signals2__you">{fmtPct(100 * share, 0)}</p>
                  </li>
                ))}
              </ul>
            ) : <p className="meta"><NeedsDemo detail="The blend needs kills, deaths and position samples on this side; converted logs have no positions." /></p>}
          </div>
        );
      })}
      <p className="meta">Shares come from a model of labelled pro roles (Jamie Packer's CS2 roles dataset) over opening duels, death timing, trades and spacing; the AWPer share is how often you carried an AWP.</p>
      <RoleSignals q={q} />
    </Card>
  );
}

const UNIT_M = 0.0254; // one Source unit is one inch

/** Main's measurement sentences for each signal (stats/role.ts on main). */
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
 * Main's role signals under the engine's blend: the AWP sentence, then each signal measured against
 * its hand-set threshold (identity.ts ROLE_SIGNALS), the bar filled to twice the threshold with the
 * threshold ticked, and "You fit" at or above it. Entry and Support read both sides, Lurker T.
 */
function RoleSignals({ q }: { q: Query }) {
  const qs = useMemo(() => {
    const { sides: _sides, ...rest } = q.filter;
    return [{ files: q.files, filter: rest }, { files: q.files, filter: { ...rest, sides: ["T" as const] } }];
  }, [q]);
  const r = useRollups(qs).data;
  if (!r || r.length !== 2) return null;
  const [both, t] = r;
  const awp = both.v.awpKpr;
  const cut = awperKpr();
  return (
    <div className="rolecard__signals">
      <h3 className="caps">Signals</h3>
      {awp !== null && (
        <p className="meta">{awp > cut
          ? `You make ${fmtDec(awp)} AWP kills per round (AWPers: more than ${fmtDec(cut)}), so you compare with AWPers.`
          : `You make ${fmtDec(awp)} AWP kills per round, under the ${fmtDec(cut)} that makes an AWPer, so you play as a rifler.`}</p>
      )}
      <ul className="signals2">
        {roleSignals().map((sg) => {
          const v = (sg.side === "T" ? t : both).v[sg.metric];
          const text = SIGNAL_TEXT[sg.id];
          const bar = v === null ? null : signalBar(v, sg.threshold);
          return (
            <li key={sg.id} className={bar?.fits ? "is-on" : bar ? "" : "is-na"}>
              <div className="signals2__top"><b>{sg.id}</b><span className="meta">{text.what}</span>{bar?.fits && <span className="chip chip--outline">You fit</span>}</div>
              <div className="signals2__track" aria-hidden><i style={{ width: `${100 * (bar?.fill ?? 0)}%` }} /><em style={{ left: "50%" }} /></div>
              <p className="signals2__you">{v === null ? text.missing : text.you(v)} <span className="faint">{text.bar(sg.threshold)}</span></p>
            </li>
          );
        })}
      </ul>
      <p className="meta">The tick on each bar is the threshold; the bar fills to twice it. The thresholds are set by hand, not fitted.</p>
    </div>
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
    <Card title="Plays like" aside={<span className="meta">Six style attributes</span>}>
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
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { if (initial) ref.current?.scrollIntoView({ block: "start" }); }, [initial]);
  const error = res.error ?? mine.error;
  if (!res.data || !mine.data) {
    return <Card title="Plays like" aside={<span className="meta">Six style attributes</span>}>{error ? <p className="meta">{error}</p> : <div className="skel" style={{ height: 220 }} />}</Card>;
  }
  const careers = res.data.careers;
  const top = ranked.slice(0, 6);
  const pick = (sel && ranked.find((x) => x.item.slug === sel)) || top[0];
  if (!pick) {
    return (
      <Card title="Plays like" aside={<span className="meta">Six style attributes</span>}>
        <p className="meta"><NeedsDemo detail="Your style scores rank against the bot careers in your matches, and these matches hold too few to score." /></p>
        <Provisional c={careers} />
      </Card>
    );
  }
  const style = styleIds();
  const you = style.map((id) => attrs.find((a) => a.id === id)?.score ?? null);
  const labels = style.map((id) => attrs.find((a) => a.id === id)?.label ?? id);
  const sideLabel = side === "both" ? "both sides" : side;
  return (
    <div ref={ref} id="similar">
      <Card title="Plays like" aside={<span className="card__aside-row"><Provisional c={careers} /><span className="meta">Six style attributes on T and CT; radar: {sideLabel}</span></span>} foot={<><span data-tip={BOTS_TIP}>Your scores rank against the bots in your matches, a pro's against pros, so the match compares the shape of the twelve scores (six attributes, T and CT), not how high they sit.</span><span>Pro scores and photos: HLTV</span></>}>
        <div className="likes">
          <div className="likes__left">
            <a className="probanner" href={`${HLTV_ORIGIN}${pick.item.hltv}`} target="_blank" rel="noreferrer" data-tip="Opens the player's HLTV page">
              <ProFace pro={pick.item} className="probanner__face" />
              <div className="probanner__body">
                <ProMarks pro={pick.item} />
                <b className="probanner__name">{pick.item.name}</b>
                <span className="meta">Rating 3.0 {pick.item.rating3.toFixed(2)} against top-20 teams</span>
              </div>
              <span className="probanner__score">
                <b className="probanner__pct num">{pick.pct}<small>%</small></b>
                {careers.provisional && <span className="calib">provisional</span>}
              </span>
            </a>
            <ul className="prolist" role="radiogroup" aria-label={`Pros by style match${careers.provisional ? ", provisional" : ""}`}>
              {top.map((x) => (
                <li key={x.item.slug}>
                  <button role="radio" aria-checked={x.item.slug === pick.item.slug} className="prorow" onClick={() => { setSel(x.item.slug); setQuery("pro", x.item.slug); }}>
                    <span className="prorow__face"><ProFace pro={x.item} className="prorow__img" /></span>
                    <span className="prorow__name"><b>{x.item.name}</b><ProMarks pro={x.item} /></span>
                    <b className="num prorow__pct">{x.pct}%</b>
                  </button>
                </li>
              ))}
            </ul>
          </div>
          <div className="likes__right">
            <AttrRadar labels={labels} you={you} other={styleOf(proScores(pick.item, side))} otherLabel={pick.item.name} size={380} />
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
      <div className="vs__head"><span className="caps" data-tip="Percentile against the bot careers in your matches">You</span><span /><span className="vs__pro" data-tip="Percentile against pros">{pro.name}</span></div>
      {styleIds().map((id, i) => (
        <div key={id} className="vs__row">
          <span className="num cream">{you[i] === null ? "–" : Math.round(you[i]!)}</span>
          <span className="vs__lbl"><AttrIcon id={id as AttributeId} size={13} />{labels[i]}</span>
          <span className="num">{theirs[i] ?? "–"}</span>
        </div>
      ))}
      <p className="meta vs__note">You against bot careers, {pro.name} against pros, both 0 to 100.</p>
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
  // the same rounds compare() ranked, for the counts behind each share ("12 of 30")
  const scope = useMemo(() => {
    const { sides: _sides, ...rest } = q.filter;
    return [{ files: q.files, filter: side === "both" ? rest : { ...rest, sides: [side] } }];
  }, [q, side]);
  const counts = useRollups(scope).data?.[0]?.m ?? null;
  return (
    <Card title="How good" aside={<span className="meta">HLTV's performance tables, against pros</span>}>
      {!p ? (r.error ? <p className="meta">{r.error}</p> : <div className="skel" style={{ height: 240 }} />) : (
        <ul className="howgood">
          {HOW_GOOD.map((id) => {
            const m = metric(id);
            const x = p[id];
            const of = m.of && counts && x.value !== null ? `${counts[m.of[0]]} of ${counts[m.of[1]]}` : null;
            return (
              <li key={id} data-tip={m.def}>
                <span>{m.label}{m.status === "approx" && <ApproxMark />}</span>
                <span className="howgood__v">
                  {of && <span className="meta num howgood__of">{of}</span>}
                  {m.status === "unavailable" ? <span className="meta">Not measured yet</span>
                    : x.reason ? <NotCompared reason={x.reason} />
                    : <span className="meta num">{rankText(x.pct)}</span>}
                  <b className="num">{m.status === "unavailable" ? <span className="faint">n/a</span> : fmtMetric(id, x.value)}</b>
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
