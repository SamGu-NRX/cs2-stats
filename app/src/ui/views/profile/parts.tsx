// Profile sections: the round-swing card, the role blend in plain words, the "plays like" view
// against the pro pack, and the how-good table.
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { compare, type Baselines, type SideKey as PoolSide } from "../../../stats/compare";
import { mostSimilar, roleBlend, STYLE, type PackPlayer } from "../../../stats/identity";
import { METRIC } from "../../../stats/metrics";
import type { Summary } from "../../../stats/rollup";
import { Delta, Initials, RemoteImg } from "../../components/bits";
import { Card } from "../../components/Card";
import { AttrRadar, FormBars } from "../../components/charts";
import { fmtMetric, type Attr } from "../../data/engine";
import type { MatchEntry } from "../../data/match";
import { ATTRIBUTE_ORDER, HLTV_ORIGIN, usePros, type Pro } from "../../data/packs";
import { PACKS_FOLDER } from "../../../host/host";
import { AttrIcon } from "../../icons/attributes";
import { fmtDate, fmtPct, fmtSwing, mapName, plural } from "../../lib/format";
import { scoreText, swingScore } from "../../lib/scale";
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

// ---------------------------------------------------------------- swing

/** METRIC.swing is in percent; fmtSwing and swingScore take a fraction. */
const swingOf = (s: Summary) => { const v = METRIC.swing.value(s); return v === null ? null : v / 100; };

export function SwingCard({ you, list, bots }: { you: Summary; list: MatchEntry[]; bots: Summary | null }) {
  const swing = swingOf(you);
  const botSwing = bots ? swingOf(bots) : null;
  const per = [...list].reverse().map((s) => ({ s, v: swingOf(s.summary) }));
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
            {swing === null ? "No round in these matches has swing data."
              : `Each round you ${swing >= 0 ? "add" : "take"} ${Math.abs(100 * swing).toFixed(2)} percentage points ${swing >= 0 ? "to" : "from"} your team's chance of winning it, through your kills and deaths.`}
          </p>
          {botSwing !== null && <p className="meta">Bots in the same matches: <b className="num">{fmtSwing(botSwing)}</b>. <Delta d={swing === null ? null : 100 * (swing - botSwing)} span={3} fmt={(x) => `${x.toFixed(2)} pts`} /> against them.</p>}
        </div>
        <div className="swingcard__chart">
          <FormBars height={150} refValue={0} fmt={(x) => fmtSwing(x / 100)} score={(x) => swingScore(x / 100)} bars={per.map((x) => ({
            key: x.s.file, value: x.v === null ? null : 100 * x.v, label: fmtDate(x.s.match.date), sub: x.s.result, result: x.s.result,
            onClick: () => openMatch(matchHref(x.s.file)), tip: `${mapName(x.s.match.map)} ${x.s.score.us}:${x.s.score.them}: ${fmtSwing(x.v)} per round`,
          }))} />
          <div className="swingcard__facts">
            <span><b className="num">{positive}</b><span className="faint">/{known.length}</span> matches with positive swing</span>
            {best && <a href={matchHref(best.s.file)}>Best <b className="num good-text">{fmtSwing(best.v)}</b> {fmtDate(best.s.match.date)}</a>}
            {worst && <a href={matchHref(worst.s.file)}>Worst <b className="num poor-text">{fmtSwing(worst.v)}</b> {fmtDate(worst.s.match.date)}</a>}
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
export function RoleCard({ t, ct }: { t: Summary; ct: Summary }) {
  const sides = [roleBlend(t, "T"), roleBlend(ct, "CT")];
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
            ) : <p className="meta">The blend needs kills, deaths and position samples on this side; converted logs have no positions.</p>}
          </div>
        );
      })}
      <p className="meta">Shares come from a model of labelled pro roles (Jamie Packer's CS2 roles dataset) over opening duels, death timing, trades and spacing; the AWPer share is how often you carried an AWP.</p>
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
const styleOf = (v: (number | null)[]) => STYLE.map((id) => v[ATTRIBUTE_ORDER.indexOf(id)]);
/** The pro pack in the engine's shape for mostSimilar: style scores per side. */
const toPack = (pros: Pro[]): PackPlayer[] => pros.map((p) => ({
  name: p.slug,
  sides: Object.fromEntries((["both", "CT", "T"] as const).map((s) => [s, { style: Object.fromEntries(STYLE.map((id, i) => [id, styleOf(proScores(p, s))[i]])) }])),
}));

/**
 * "Plays like": your six style attributes against each pro's on the same side (identity.ts
 * mostSimilar: 100 minus the mean gap between the scores). Both sets are percentiles against pros,
 * so the level is comparable as well as the shape.
 */
export function PlaysLike({ attrs, side, initial }: { attrs: Attr[]; side: PoolSide; initial: string | null }) {
  const pack = usePros();
  if (pack.state === "ready") return <PlaysLikeBody attrs={attrs} side={side} initial={initial} pros={pack.pros} />;
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

function PlaysLikeBody({ attrs, side, initial, pros }: { attrs: Attr[]; side: PoolSide; initial: string | null; pros: Pro[] }) {
  const mine = useMemo(() => Object.fromEntries(attrs.filter((a) => a.kind === "identity").map((a) => [a.id, a.score])), [attrs]);
  const bySlug = useMemo(() => new Map(pros.map((p) => [p.slug, p])), [pros]);
  const ranked = useMemo(() => mostSimilar(mine, toPack(pros), side, "style", pros.length).map((x) => ({ item: bySlug.get(x.name)!, pct: Math.round(x.similarity) })), [mine, pros, side, bySlug]);
  const [sel, setSel] = useState<string | null>(initial);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { if (initial) ref.current?.scrollIntoView({ block: "start" }); }, [initial]);
  const top = ranked.slice(0, 6);
  const pick = (sel && ranked.find((x) => x.item.slug === sel)) || top[0];
  if (!pick) return null;
  const you = STYLE.map((id) => attrs.find((a) => a.id === id)?.score ?? null);
  const labels = STYLE.map((id) => attrs.find((a) => a.id === id)?.label ?? id);
  const sideLabel = side === "both" ? "both sides" : side;
  return (
    <div ref={ref} id="similar">
      <Card title="Plays like" aside={<span className="meta">Six style attributes, {sideLabel}</span>} foot={<><span>Your scores and a pro's are both percentiles against pros, so the match compares how high each attribute sits as well as the shape.</span><span>Pro scores and photos: HLTV</span></>}>
        <div className="likes">
          <div className="likes__left">
            <a className="probanner" href={`${HLTV_ORIGIN}${pick.item.hltv}`} target="_blank" rel="noreferrer" data-tip="Opens the player's HLTV page">
              <ProFace pro={pick.item} className="probanner__face" />
              <div className="probanner__body">
                <ProMarks pro={pick.item} />
                <b className="probanner__name">{pick.item.name}</b>
                <span className="meta">Rating 3.0 {pick.item.rating3.toFixed(2)} against top-20 teams</span>
              </div>
              <b className="probanner__pct num">{pick.pct}<small>%</small></b>
            </a>
            <ul className="prolist" role="radiogroup" aria-label="Pros by style match">
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
            <div className="legend likes__legend"><span><i className="swatch" style={{ background: "var(--cream)" }} />You</span><span><i className="swatch swatch--dash" />{pick.item.name}</span></div>
            <VsTable attrs={attrs} pro={pick.item} side={side} />
          </div>
        </div>
      </Card>
    </div>
  );
}

function VsTable({ attrs, pro, side }: { attrs: Attr[]; pro: Pro; side: PoolSide }) {
  const theirs = styleOf(proScores(pro, side));
  return (
    <div className="vs vs--wide">
      <div className="vs__head"><span className="caps">You</span><span /><span className="vs__pro">{pro.name}</span><span className="caps">Diff</span></div>
      {STYLE.map((id, i) => {
        const a = attrs.find((x) => x.id === id);
        const pv = theirs[i];
        const d = !a || a.score === null || pv === null ? null : a.score - pv;
        return (
          <div key={id} className="vs__row">
            <span className="num cream">{!a || a.score === null ? "–" : Math.round(a.score)}</span>
            <span className="vs__lbl"><AttrIcon id={id} size={13} />{a?.label ?? id}</span>
            <span className="num">{pv ?? "–"}</span>
            <Delta d={d} span={30} fmt={(x) => Math.round(x).toString()} />
          </div>
        );
      })}
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

/** Where a percentile sits, for performance metrics (higher is always better after compare()). */
export const rankText = (pct: number | null) => (pct === null ? "–" : pct >= 50 ? `Top ${Math.max(1, Math.round(100 - pct))}%` : `Bottom ${Math.max(1, Math.round(pct))}%`);

/** The performance tables HLTV pairs with Rating 3.0, each with its percentile against pros. */
export function HowGood({ s, baselines, side }: { s: Summary; baselines: Baselines; side: PoolSide }) {
  const p = compare(s, baselines, { side });
  return (
    <Card title="How good" aside={<span className="meta">HLTV's performance tables, against pros</span>}>
      <ul className="howgood">
        {HOW_GOOD.map((id) => {
          const m = METRIC[id];
          return (
            <li key={id} data-tip={m.def}>
              <span>{m.label}</span>
              <span className="howgood__v">
                <span className="meta num">{m.status === "unavailable" ? "Not measured yet" : rankText(p[id].pct)}</span>
                <b className="num">{m.status === "unavailable" ? <span className="faint">n/a</span> : fmtMetric(id, p[id].value)}</b>
              </span>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
