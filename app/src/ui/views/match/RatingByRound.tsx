// Rating 3.0 round by round (worker ratingBreakdown): each round's rating as a lollipop from your match
// rating, which the counted rounds average to, with 1.00 and your usual rating (your recent matches,
// worker yourMatch) as reference lines. Beside it, a waterfall of where a rating came from: the
// base, then each input's contribution (the engine's split), ending at the rating. It shows the whole
// match until a round is hovered or focused; a click opens the round in the drawer.
// No motion: the panel swaps at once, since it follows the pointer across rounds.
import { useMemo, useState } from "react";
import type { RatingBreakdown } from "../../../worker/protocol";
import type { RoundRating } from "../../../stats/matchviews";
import { Card } from "../../components/Card";
import { useCall } from "../../data/hooks";
import type { ViewedMatch } from "../../data/match";
import { ratingInfo } from "../../data/meta";
import { fmtRating } from "../../lib/format";
import { ratingText, scoreText, toScore } from "../../lib/scale";
import { matchHref, setQuery } from "../../router";
import { Hint } from "./glyphs";
import { LoadFailed } from "./LoadFailed";
import { contributions, ratingDomain, ratingOrder, ratingSteps, signedIn, TERM_LABEL, type Step } from "./parity";
import { useRoving } from "./roving";

const PITCH = 24;
const HALF_GAP = 12;
const LEFT = 34;
const RIGHT = 92;
const TOP = 18;
const PLOT = 196;
const FOOT = 36;

const diff = (d: number) => signedIn(fmtRating, d);

/** The rating split as a waterfall (views.css .wfall), with 0 and 1.00 marked on the track. */
export function RatingWaterfall({ steps, total }: { steps: Step[]; total: number }) {
  const ends = steps.flatMap((s) => [s.from, s.to]);
  const lo = Math.min(0, ...ends), hi = Math.max(1, ...ends);
  const x = (v: number) => (100 * (v - lo)) / (hi - lo || 1);
  const bar = (from: number, to: number, color: string) => (
    <span className="wfall__track" aria-hidden>
      <span className="wfall__zero" style={{ left: `${x(0)}%` }} />
      <span className="rbr__one" style={{ left: `${x(1)}%` }} />
      <i style={{ left: `${x(Math.min(from, to))}%`, width: `${Math.max(0.6, x(Math.max(from, to)) - x(Math.min(from, to)))}%`, background: color }} />
    </span>
  );
  return (
    <div className="wfall rbr__wf">
      <ul>
        {steps.map((s) => {
          const base = s.key === "base";
          const tip = base ? "Rating 3.0's constant: where every round starts." : TERM_LABEL[s.key as keyof typeof TERM_LABEL].tip;
          return (
            <li key={s.key} className="wfall__row">
              <span className="wfall__l" data-tip={tip} tabIndex={0}>{s.label}</span>
              {bar(s.from, s.to, base ? "var(--tan)" : s.value >= 0 ? "var(--good-text)" : "var(--poor-text)")}
              <b className="num" style={{ color: base ? "var(--ink2)" : scoreText(toScore(s.value, 0, 0.5)) }}>{base ? fmtRating(s.value) : diff(s.value)}</b>
            </li>
          );
        })}
        <li className="wfall__row wfall__row--total">
          <span className="wfall__l">Rating</span>
          {bar(0, total, "var(--cream)")}
          <b className="num" style={{ color: ratingText(total) }}>{fmtRating(total)}</b>
        </li>
      </ul>
    </div>
  );
}

/** The best or worst round's value: above an upper dot, below a lower one, or beside it where below would reach the W/L row. */
function ExtLabel({ x, y, up, text }: { x: number; y: number; up: boolean; text: string }) {
  if (up) return <text x={x} y={y - 9} textAnchor="middle" className="ax ms__ext">{text}</text>;
  if (y + 17 <= PLOT - 2) return <text x={x} y={y + 17} textAnchor="middle" className="ax ms__ext">{text}</text>;
  return <text x={x + 8} y={y + 4} className="ax ms__ext">{text}</text>;
}

/** A round's waterfall from its engine base and terms; null when the round is not rated. */
export function roundSteps(r: RoundRating) {
  if (!r.terms || r.base === null) return null;
  return ratingSteps(r.base, contributions(ratingOrder(ratingInfo().inputs), r.terms));
}

export function RatingByRound({ v, file, rb, error, selected }: { v: ViewedMatch; file: string; rb: RatingBreakdown | null; error: string | null; selected: number | null }) {
  const me = v.players[v.human];
  const usual = useCall("yourMatch", [file, me.key, 10]).data;
  const recent = usual?.rows.find((r) => r.id === "rating3")?.average ?? null;
  const [hover, setHover] = useState<number | null>(null);
  const rows = rb?.rows ?? [];
  const roving = useRoving(rows.length);
  const matchSteps = useMemo(() => {
    if (!rb?.match.terms || rb.match.base === null) return null;
    return ratingSteps(rb.match.base, contributions(ratingOrder(ratingInfo().inputs), rb.match.terms));
  }, [rb]);

  const n = usual?.recent.length ?? 0;
  const title = <>Rating, round by round <Hint tip={`Each round's Rating 3.0 on its own; the filled rounds average to your match rating.${n ? ` Usual is your rating over your last ${n === 1 ? "match" : `${n} matches`}.` : ""}`} /></>;
  if (error) return <Card title={title}><LoadFailed what="Your rating by round" error={error} /></Card>;
  if (!rb) return <Card title={title}><div className="skel" style={{ height: PLOT + FOOT }} /></Card>;
  const avg = rb.match.value;
  if (avg === null) return <Card title={title}><p className="meta">Rating 3.0 does not rate this match: {rb.match.reason ?? "too few rounds could be valued"}.</p></Card>;

  const byNumber = new Map(v.rounds.map((r) => [r.number, r]));
  // x of each round: one pitch each, and a gap where the sides swap
  let gaps = 0;
  const xs = rows.map((r, i) => {
    if (i > 0 && byNumber.get(r.number)?.halfStart) gaps++;
    return LEFT + PITCH / 2 + i * PITCH + gaps * HALF_GAP;
  });
  const end = (xs[xs.length - 1] ?? LEFT) + PITCH / 2;
  const [lo, hi] = ratingDomain(rows.map((r) => r.rating), [avg, recent, 1]);
  const Y = (val: number) => TOP + ((hi - val) / (hi - lo)) * (PLOT - TOP);
  const rated = rows.filter((r) => r.rating !== null) as (RoundRating & { rating: number })[];
  const best = Math.max(...rated.map((r) => r.rating));
  const worst = Math.min(...rated.map((r) => r.rating));
  const shown = hover === null ? null : rows[hover];
  const stepsShown = shown ? roundSteps(shown) : matchSteps;
  // labels on the right: keep the usual rating's clear of the match rating's
  const recentDy = recent !== null && Math.abs(Y(recent) - Y(avg)) < 12 ? (Y(recent) > Y(avg) ? 12 : -12) : 0;
  const halves = rows.flatMap((r, i) => (i === 0 || byNumber.get(r.number)?.halfStart ? [{ i, side: r.side }] : []));

  return (
    <Card title={title} aside={<span className="meta">{rated.length === rows.length ? `${rows.length} rounds rated` : `${rated.length} of ${rows.length} rounds rated`}</span>}>
      <div className="rbr">
        <div className="rbr__scroll">
          <svg className="ms rbr__chart" width={end + RIGHT} height={PLOT + FOOT} role="group" aria-label={`Your Rating 3.0 in each round, match ${fmtRating(avg)}`} onKeyDown={roving.onKeyDown} onPointerLeave={(e) => e.pointerType === "mouse" && setHover(null)}>
            <g aria-hidden>
              <line x1={LEFT} x2={end} y1={Y(0)} y2={Y(0)} className="ms__grid" />
              <text x={LEFT - 8} y={Y(0) + 4} textAnchor="end" className="ax">0</text>
              <line x1={LEFT} x2={end} y1={Y(1)} y2={Y(1)} className="ms__ref" />
              <text x={LEFT - 8} y={Y(1) + 4} textAnchor="end" className="ax">1.00</text>
              {recent !== null && <>
                <line x1={LEFT} x2={end} y1={Y(recent)} y2={Y(recent)} className="rbr__usual" />
                <text x={end + 6} y={Y(recent) + 4 + recentDy} className="ax">usual {fmtRating(recent)}</text>
              </>}
              <line x1={LEFT} x2={end} y1={Y(avg)} y2={Y(avg)} className="ms__mean" />
              <text x={end + 6} y={Y(avg) + 4} className="ax ms__meanl">match {fmtRating(avg)}</text>
              {halves.map(({ i, side }) => <text key={i} x={xs[i] - PITCH / 2 + 2} y={10} className={`ax rbr__side ${side === "T" ? "is-t" : "is-ct"}`}>{side}</text>)}
            </g>
            {rows.map((r, i) => {
              const x = xs[i];
              const on = hover === i || selected === r.number;
              const result = r.won === null ? "no result" : r.won ? "won" : "lost";
              const what = r.rating === null ? "not rated" : `rating ${fmtRating(r.rating)}, ${diff(r.vsAverage ?? 0)} against your match`;
              const ext = r.rating !== null && rated.length > 1 && (r.rating === best || r.rating === worst);
              return (
                <a
                  key={r.number}
                  href={matchHref(file, "rounds", { round: r.number })}
                  className="rbr__col"
                  aria-label={`Round ${r.number} on ${r.side}, ${result}: ${what}${r.rating !== null && !r.counts ? ", not counted in the match rating" : ""}`}
                  aria-current={selected === r.number ? "true" : undefined}
                  onClick={(e) => { e.preventDefault(); setQuery("round", String(r.number)); }}
                  onPointerEnter={(e) => e.pointerType === "mouse" && setHover(i)}
                  onBlur={() => setHover(null)}
                  {...roving.item(i)}
                  onFocus={() => { roving.item(i).onFocus(); setHover(i); }}
                >
                  <rect x={x - PITCH / 2} y={0} width={PITCH} height={PLOT + FOOT} rx="4" className={`rbr__band ${on ? "is-on" : ""}`} />
                  {r.rating !== null && (
                    <g className={r.rating >= avg ? "is-good" : "is-poor"}>
                      <line x1={x} x2={x} y1={Y(avg)} y2={Y(r.rating)} className="ms__stem" />
                      <circle cx={x} cy={Y(r.rating)} r="4.5" className={`ms__pop ${r.counts ? "" : "rbr__hollow"}`} />
                      {ext && <ExtLabel x={x} y={Y(r.rating)} up={r.rating >= avg} text={fmtRating(r.rating)} />}
                    </g>
                  )}
                  <g transform={`translate(${x - 7} ${PLOT + 4})`}>
                    <rect width="14" height="14" rx="3" className={r.won ? "ms__w" : "ms__l"} />
                    <text x="7" y="10.5" textAnchor="middle" className={`ms__wlt ${r.won ? "is-w" : ""}`}>{r.won === null ? "–" : r.won ? "W" : "L"}</text>
                  </g>
                  <text x={x} y={PLOT + FOOT - 4} textAnchor="middle" className={`ax ${on ? "ax--cream ax--strong" : ""}`}>{r.number}</text>
                </a>
              );
            })}
          </svg>
        </div>
        <section className="rbr__panel" aria-label="Where the rating came from">
          <header className="rbr__head">
            <span className="caps">{shown ? `Round ${shown.number}` : "Whole match"}</span>
            {shown && <span className={`chip ${shown.side === "T" ? "chip--t" : "chip--ct"}`}>{shown.side}</span>}
            {shown && <span className="meta">{shown.won === null ? "No result" : shown.won ? "Won" : "Lost"}</span>}
          </header>
          {stepsShown ? (
            <>
              <div className="rbr__big">
                <b className="disp disp--m" style={{ color: ratingText(stepsShown.total) }}>{fmtRating(stepsShown.total)}</b>
                <span className="meta">
                  {shown ? (shown.counts ? `${diff(shown.vsAverage ?? 0)} against your match` : "Not counted: its side has too few rated rounds")
                    : recent !== null ? `${diff(avg - recent)} against your last ${n === 1 ? "match" : `${n} matches`}` : `Over ${rb.match.rounds} rated rounds`}
                </span>
              </div>
              <RatingWaterfall {...stepsShown} />
            </>
          ) : <p className="meta">Not rated: this round's swing or eco value is unknown.</p>}
        </section>
      </div>
    </Card>
  );
}
