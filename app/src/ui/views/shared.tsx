// Pieces several views share: stat tiles, hover cards for players and rounds, empty states and
// skeletons shaped like the content they stand in for.
import type { ReactNode } from "react";
import { Delta, Num, Spark, VerdictLabel } from "../components/bits";
import { HoverCard } from "../components/overlay";
import { BOTS_TIP, provisionalText, ratingHeadline, statLine } from "../data/engine";
import type { Careers } from "../../worker/protocol";
import { roundSwing, sideOf, type MatchModel, type MRound } from "../data/match";
import { BUY_LABEL, BuyIcon, KillFlags, SkullIcon, WeaponIcon, WIN_LABEL, WinIcon } from "../icons/game";
import { fmtAdr, fmtClock, fmtMoney, fmtPct, fmtRating, fmtSecs, fmtSwing } from "../lib/format";
import { roundSwingScore, scoreText, swingScore, ratingText } from "../lib/scale";
import { BENCH, verdictOf, type BenchId } from "../lib/verdict";
import { pageHref } from "../router";

// ---------------------------------------------------------------- stat tile

/**
 * A tile draws its sparkline only from this many matches with a value: two points make a line that
 * reads as a trend. The review asked for three (PR #20 round 1); no data run picked it.
 */
const SPARK_MIN_POINTS = 3;

/** A pooled headline stat. It carries no delta: the last-match hero is the one place deltas show. */
export function StatTile({ label, value, sub, delta, spark, bench, raw, breakdown, def, color }: {
  label: string;
  value: string;
  sub?: ReactNode;
  /** the last match against the average, beside the sparkline */
  delta?: ReactNode;
  spark?: (number | null)[];
  bench?: BenchId;
  raw?: number | null;
  breakdown?: () => ReactNode;
  def?: string;
  color?: string;
}) {
  const v = bench ? verdictOf(raw, BENCH[bench]) : "na";
  const points = spark?.filter((x) => x !== null && Number.isFinite(x)).length ?? 0;
  const body = (
    <>
      <div className="tile__top">
        <span className="stat__l">{label}</span>
        {bench && <VerdictLabel v={v} />}
      </div>
      <div className="tile__v num" style={color ? { color } : undefined}><Num v={value} /></div>
      {(delta || (spark && points >= SPARK_MIN_POINTS)) && (
        <div className="tile__foot">
          {delta && <span className="tile__delta">{delta}</span>}
          {spark && points >= SPARK_MIN_POINTS && <Spark values={spark} w={120} h={28} refLine={bench ? BENCH[bench].ref : undefined} />}
        </div>
      )}
      {sub && <div className="tile__sub">{sub}</div>}
    </>
  );
  if (!breakdown) return <div className="tile" data-tip={def}>{body}</div>;
  return (
    <HoverCard as="div" className="tile" prefer="bottom" card={() => (
      <div className="bd">
        <div className="bd__head"><span className="caps">{label}</span><b className="num cream">{value}</b></div>
        {def && <p className="bd__def">{def}</p>}
        {breakdown()}
      </div>
    )}>
      {body}
    </HoverCard>
  );
}

/** Rows of a breakdown card: label, value, optional share bar. */
export function BreakRows({ rows }: { rows: { label: ReactNode; value: ReactNode; share?: number; color?: string }[] }) {
  return (
    <div className="bd__rows">
      {rows.map((r, i) => (
        <div key={i} className="bd__row">
          <span>{r.label}</span>
          {r.share !== undefined && <span className="hbar"><i style={{ width: `${Math.max(0, Math.min(1, r.share)) * 100}%`, background: r.color }} /></span>}
          <b className="num">{r.value}</b>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- player hover card

export function PlayerCardBody({ v, pi }: { v: MatchModel; pi: number }) {
  const p = v.players[pi];
  const [both, t, ct] = (["both", "t", "ct"] as const).map((k) => statLine(v.b.lines[k][pi]));
  return (
    <div className="pcard">
      <div className="pcard__head">
        <span className={`pcard__dot ${p.team === "us" ? "us" : "them"}`} />
        <div>
          <b>{p.name}</b>
          <div className="meta">{p.isHuman ? "You" : `${p.team === "us" ? "Teammate" : "Opponent"}${p.bot ? ", bot" : ""}`}</div>
        </div>
        <span className="pcard__rating num" style={{ color: ratingText(both.rating ?? 1) }}>{fmtRating(both.rating)}</span>
      </div>
      <div className="pcard__grid">
        <span className="caps">K–D</span><b className="num">{both.kills}–{both.deaths}</b>
        <span className="caps">ADR</span><b className="num">{fmtAdr(both.adr)}</b>
        <span className="caps">KAST</span><b className="num">{fmtPct(both.kast)}</b>
        <span className="caps">Swing</span><b className="num" style={{ color: both.swing === null ? undefined : scoreText(swingScore(both.swing)) }}>{fmtSwing(both.swing)}</b>
      </div>
      <div className="pcard__sides">
        <div><span className="t-text caps">T</span><b className="num">{fmtRating(t.rating)}</b><small className="meta">{t.kills}–{t.deaths}</small></div>
        <div><span className="ct-text caps">CT</span><b className="num">{fmtRating(ct.rating)}</b><small className="meta">{ct.kills}–{ct.deaths}</small></div>
      </div>
      <div className="meta">{ratingHeadline()}</div>
    </div>
  );
}

export function PlayerName({ v, pi, children }: { v: MatchModel; pi: number; children?: ReactNode }) {
  return (
    <HoverCard prefer="right" card={() => <PlayerCardBody v={v} pi={pi} />} className="pname">
      {children ?? v.players[pi].name}
    </HoverCard>
  );
}

// ---------------------------------------------------------------- round hover card

export function RoundCardBody({ v, r }: { v: MatchModel; r: MRound }) {
  const side = r.winSide === "T" ? "t" : r.winSide === "CT" ? "ct" : null;
  const human = v.human;
  const hSide = sideOf(v, r, human);
  const you = roundSwing(r.pr[human]);
  const top = r.pr.map((row, pi) => ({ s: roundSwing(row), pi })).filter((x): x is { s: number; pi: number } => x.s !== null).sort((a, b) => b.s - a.s)[0] ?? null;
  return (
    <div className="rcard">
      <div className="rcard__head">
        <WinIcon how={r.how} size={16} className={side ? `${side}-text` : "faint"} />
        <b>Round {r.number}</b>
        <span className="meta">{r.how ? WIN_LABEL[r.how] : "Result unknown"}</span>
        {r.scoreAfter && <span className="rcard__score num">{r.scoreAfter.us}<span className="faint">:</span>{r.scoreAfter.them}</span>}
      </div>
      <div className="rcard__eco">
        <span><BuyIcon buy={r.buy.us} size={14} /> {r.buy.us ? BUY_LABEL[r.buy.us] : "Buy unknown"} <span className="faint">{fmtMoney(r.equip.us)}</span></span>
        <span className="faint">vs</span>
        <span><BuyIcon buy={r.buy.them} size={14} /> {r.buy.them ? BUY_LABEL[r.buy.them] : "Buy unknown"} <span className="faint">{fmtMoney(r.equip.them)}</span></span>
      </div>
      {r.kills.length > 0 ? (
        <ol className="kf kf--compact">
          {r.kills.slice(0, 10).map((k, i) => (
            <li key={i}>
              <span className="mono faint">{fmtClock(k.t)}</span>
              <span className={k.killer !== null && v.players[k.killer].team === "us" ? "us-text" : "them-text"}>{k.killer === null ? "World" : v.players[k.killer].name}</span>
              <WeaponIcon name={k.weapon} size={11} />
              <KillFlags kill={k} size={11} />
              <span className={v.players[k.victim].team === "us" ? "us-text" : "them-text"}>{v.players[k.victim].name}</span>
            </li>
          ))}
          {r.kills.length > 10 && <li className="faint">{r.kills.length - 10} more</li>}
        </ol>
      ) : <p className="meta">No kills recorded.</p>}
      <div className="rcard__foot">
        {you !== null && <span>You <b className="num" style={{ color: scoreText(roundSwingScore(you)) }}>{fmtSwing(you)}</b></span>}
        {top && top.s > 0 && <span>Top swing <b>{v.players[top.pi].name}</b> <b className="num good-text">{fmtSwing(top.s)}</b></span>}
        <span className={hSide === "T" ? "t-text" : "ct-text"}>You on {hSide}</span>
      </div>
    </div>
  );
}

/** Kill icons for one player's round, headshots marked. */
export function Skulls({ kills, size = 10 }: { kills: { hs: boolean }[]; size?: number }) {
  return <span className="skulls">{kills.map((k, i) => <SkullIcon key={i} hs={k.hs} size={size} className={k.hs ? "skull skull--hs" : "skull"} />)}</span>;
}

// ---------------------------------------------------------------- places

/** Seconds alive by place name, sorted, the top `n`. */
export function PlaceList({ places, n = 10 }: { places: Record<string, number>; n?: number }) {
  const rows = Object.entries(places).sort((a, b) => b[1] - a[1]).slice(0, n);
  const max = rows[0]?.[1] ?? 1;
  return (
    <ul className="places">
      {rows.map(([p, secs]) => <li key={p}><span>{p}</span><span className="hbar"><i style={{ width: `${(secs / max) * 100}%` }} /></span><b className="num">{fmtSecs(secs, 0)}</b></li>)}
    </ul>
  );
}

// ---------------------------------------------------------------- states

/** Empty state: a small line graphic, one sentence, one action. */
export function Empty({ icon, text, action }: { icon?: ReactNode; text: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      {icon && <div className="empty__art" aria-hidden>{icon}</div>}
      <p>{text}</p>
      {action}
    </div>
  );
}

export function SkeletonRows({ rows = 6, height = 36 }: { rows?: number; height?: number }) {
  return (
    <div className="skel-rows" aria-hidden>
      {Array.from({ length: rows }, (_, i) => <div key={i} className="skel" style={{ height: height - 8, opacity: 1 - i * 0.1 }} />)}
    </div>
  );
}

export function SectionAside({ label, value, color }: { label: string; value: ReactNode; color?: string }) {
  return <span className="aside-metric"><span className="caps">{label}</span><b className="num" style={color ? { color } : undefined}>{value}</b></span>;
}

export const deltaOf = (a: number | null, b: number | null) => (a === null || b === null ? null : a - b);
export { Delta };

/**
 * The label the user's style scores carry while fewer bot careers qualify than the engine's minimum
 * (compare.ts BOT_CAREERS_MIN): the scores still show, under a "Provisional" chip whose tooltip holds
 * the count. Focusable, so the tooltip opens from the keyboard too.
 */
export function Provisional({ c }: { c: Careers }) {
  if (!c.provisional) return null;
  return (
    <span className="chip chip--prov" tabIndex={0} data-tip={`${provisionalText(c)}. ${BOTS_TIP} Until ${c.needed} bot careers have ${c.minRounds} or more rounds, the population is small and the scores can move as you play more.`}>
      Provisional
    </span>
  );
}

// ---------------------------------------------------------------- missing data

/** The one phrasing for a number the user's matches cannot give yet. */
export const NEEDS_DEMO = "Needs a recorded demo";

/**
 * NEEDS_DEMO with a link to Data & settings, whose first card is the recording source. `detail` (the
 * specific gap, such as how many bot careers a pool has) is the tooltip of the phrase and of the link,
 * so focusing the link opens it and describes the link to a screen reader.
 */
export function NeedsDemo({ detail }: { detail?: string }) {
  return (
    <span className="needs">
      <span className="needs__t" data-tip={detail}>{NEEDS_DEMO}</span>
      <a className="needs__link" href={pageHref("settings")} data-tip={detail}>Data & settings</a>
    </span>
  );
}

/**
 * A value with no percentile, and why (compare.ts Percentile.reason): a kept match lacks an input the
 * metric needs, or the pro pool was built under another model. Stands where the rank would be.
 */
export function NotCompared({ reason }: { reason: string }) {
  return <span className="nocmp" tabIndex={0} data-tip={reason}>Not compared</span>;
}

/** Marks a metric whose status is "approx" (metrics.ts): our reading of an unpublished definition. */
export function ApproxMark() {
  return (
    <span className="approx" data-tip="Approximate: our reading of an unpublished definition">
      <span aria-hidden>≈</span><span className="sr-only">, approximate</span>
    </span>
  );
}

/** A match's swing is shown per round; its sum over the valued rounds goes in the tooltip. */
export function swingSumTip(m: { swing: number; swingRounds: number }): string | undefined {
  return m.swingRounds ? `${fmtSwing(m.swing)} summed over ${m.swingRounds} ${m.swingRounds === 1 ? "round" : "rounds"} with swing` : undefined;
}
