// Overview's "Moves with winning": which of your stats per match rise and fall with winning that match
// (worker winCorrelation, a point-biserial Pearson r), and the trend behind each. Every row is a
// diverging bar from 0 toward -1 or +1 over a shaded band: the |r| chance alone reaches 5% of the time
// at that row's sample (stats/correlation.ts noiseBand), so a bar inside it reads as no relation. A
// stat shows only from WIN_CORRELATION_MIN decided matches with a value for it, and only with an r: a
// stat the same in every match, or matches all won or all lost, have none, and the card says so
// rather than drawing 0 (winState). Picking a row (?trend=<id>) shows that
// stat by match with each match's W or L under it, its mean in wins and in losses, and its slope.
// Nothing moves: picking a row is a tab switch, done many times in a sitting.
import { useId, useMemo, useRef, type KeyboardEvent, type ReactNode } from "react";
import { noiseBand, WIN_CORRELATION_MIN, winLossMeans } from "../../../stats/correlation";
import { Card } from "../../components/Card";
import { rovingIndex } from "../../components/controls";
import { Fig, MatchLine } from "../../components/MatchSeries";
import { fmtMetric } from "../../data/engine";
import { useCall } from "../../data/hooks";
import type { MatchEntry } from "../../data/match";
import { metric } from "../../data/meta";
import { tipOf } from "../../data/tips";
import { fmtMatchDay, plural } from "../../lib/format";
import { matchHref, setQuery, useRoute } from "../../router";
import type { WinCorrelation } from "../../../stats/trends";
import type { Query } from "../../../worker/protocol";
import { Empty } from "../shared";

/** The stats asked about: the player card's and Where you rank's headline numbers, plus openings and headshots. */
export const WIN_STATS = ["rating3", "swing", "adr", "kpr", "dpr", "kast", "openingSuccess", "hs"] as const;
const LABEL: Record<string, string> = { rating3: "Rating 3.0", swing: "Round swing", openingSuccess: "Opening duels won", hs: "Headshot kills" };
/** Matches the trend line draws, newest last: at its 48 px a match, more would outgrow the panel. */
const LINE_MATCHES = 12;

export interface WinRow { id: string; r: number; n: number; band: number }

/** What the card shows for the engine's answer, each stat sorted into one place by its own sample. */
export interface WinState {
  /** stats with an r over at least WIN_CORRELATION_MIN decided matches with a value, highest r first */
  rows: WinRow[];
  /** stats under the minimum, with their own n, fewest first */
  short: { id: string; n: number }[];
  /** stats over the minimum that never changed, so have no r */
  flat: string[];
  /** stats over the minimum whose decided matches were all won, or all lost */
  oneSided: { id: string; n: number; won: boolean }[];
}

/** Sorts the engine's answer (worker winCorrelation) into the card's rows and the stats it leaves out, each with why. */
export function winState(corr: Record<string, WinCorrelation>): WinState {
  const out: WinState = { rows: [], short: [], flat: [], oneSided: [] };
  for (const [id, c] of Object.entries(corr)) {
    if (c.n < WIN_CORRELATION_MIN) out.short.push({ id, n: c.n });
    else if (c.r !== null) out.rows.push({ id, r: c.r, n: c.n, band: noiseBand(c.n)! });
    else if (c.reason === "allWon" || c.reason === "allLost") out.oneSided.push({ id, n: c.n, won: c.reason === "allWon" });
    else out.flat.push(id);
  }
  out.rows.sort((a, b) => b.r - a.r);
  out.short.sort((a, b) => a.n - b.n);
  return out;
}

const signedR = (r: number) => `${r > 0 ? "+" : r < 0 ? "−" : ""}${Math.abs(r).toFixed(2)}`;
const labelOf = (id: string) => LABEL[id] ?? metric(id).label;

export function WinCorrelationCard({ q, list, sectionRef }: { q: Query; list: MatchEntry[]; sectionRef?: (el: HTMLElement | null) => void }) {
  const corr = useCall("winCorrelation", [q, [...WIN_STATS]]);
  const st = useMemo(() => (corr.data ? winState(corr.data) : null), [corr.data]);
  const rows = st?.rows ?? null;
  const asked = useRoute().query.get("trend");
  const on = rows?.find((x) => x.id === asked) ?? rows?.[0] ?? null;
  const most = rows?.length ? Math.max(...rows.map((x) => x.n)) : 0;
  return (
    <section id="wins" ref={sectionRef} className="psec">
      <Card title="Moves with winning" tip="How each stat, match by match, rises and falls with winning. Correlation, not cause."
        aside={rows?.length ? <span className="meta">{plural(most, "decided match", "decided matches")}</span> : undefined} className="wcor-card">
        {corr.error && !corr.stale ? <Empty text={corr.error} />
          : !st || !rows ? <div className="skel" style={{ height: 260 }} />
          : !rows.length ? <NoRows st={st} />
          : <WinBody rows={rows} on={on!} q={q} list={list} left={<LeftOut st={st} />} />}
      </Card>
    </section>
  );
}

const names = (ids: string[]) => ids.map(labelOf).join(", ");

/**
 * No stat has a row. Every decided match won (or lost) says so; a stat that never changed says so;
 * otherwise the count toward the minimum, as pips for the stat with the fewest decided matches with a
 * value, and the range when the stats' counts differ.
 */
function NoRows({ st }: { st: WinState }) {
  const one = st.oneSided[0];
  if (one && st.oneSided.every((x) => x.won === one.won)) {
    return <p className="meta wcor__state">{`All ${plural(Math.max(...st.oneSided.map((x) => x.n)), "decided match was", "decided matches were")} ${one.won ? "wins" : "losses"}, so nothing can move with winning yet.`}</p>;
  }
  if (!st.short.length) return <p className="meta wcor__state">{`${names(st.flat)} stayed the same in every match, so nothing moves with winning.`}</p>;
  const lo = st.short[0].n;
  const hi = st.short[st.short.length - 1].n;
  const have = Math.min(lo, WIN_CORRELATION_MIN);
  return (
    <div className="wcor__empty">
      <span className="wcor__pips" aria-hidden>{Array.from({ length: WIN_CORRELATION_MIN }, (_, i) => <i key={i} className={i < have ? "is-on" : undefined} />)}</span>
      <p className="meta">Shows each stat from {WIN_CORRELATION_MIN} matches with a winner and a value. {lo === hi ? `${lo} so far.` : `${lo} to ${hi} so far.`}</p>
    </div>
  );
}

/** Under the rows: the stats left out, each with why. */
function LeftOut({ st }: { st: WinState }) {
  const lines = [
    st.short.length ? `Not yet, under ${WIN_CORRELATION_MIN} matches: ${st.short.map((x) => `${labelOf(x.id)} (${x.n})`).join(", ")}.` : null,
    st.flat.length ? `Left out, the same in every match: ${names(st.flat)}.` : null,
    ...[true, false].map((won) => {
      const ids = st.oneSided.filter((x) => x.won === won).map((x) => x.id);
      return ids.length ? `Left out, every match with a value ${won ? "won" : "lost"}: ${names(ids)}.` : null;
    }),
  ].filter((x): x is string => x !== null);
  return lines.length ? <div className="wcor__left meta">{lines.map((l) => <p key={l}>{l}</p>)}</div> : null;
}

function WinBody({ rows, on, q, list, left }: { rows: WinRow[]; on: WinRow; q: Query; list: MatchEntry[]; left: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const uid = useId();
  const pick = (id: string) => setQuery("trend", id === rows[0].id ? null : id);
  const onKey = (e: KeyboardEvent) => {
    // a vertical tablist: Up and Down step, Home and End jump; Left and Right are left to the page
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") return;
    const to = rovingIndex(e.key, rows.indexOf(on), rows.length, true);
    if (to === null) return;
    e.preventDefault();
    pick(rows[to].id);
    ref.current?.querySelector<HTMLElement>(`[data-stat="${rows[to].id}"]`)?.focus();
  };
  const n = rows[0].n;
  const sameN = rows.every((x) => x.n === n);
  return (
    <div className="wcor">
      <div>
        <div ref={ref} className="wcor__list" role="tablist" aria-orientation="vertical" aria-label="Stats by how they move with winning" onKeyDown={onKey}>
          {rows.map((x) => {
            const chance = Math.abs(x.r) <= x.band;
            const w = Math.min(1, Math.abs(x.r)) * 50;
            return (
              <button key={x.id} id={`${uid}-${x.id}`} data-stat={x.id} role="tab" aria-selected={x === on} aria-controls={`${uid}-panel`} tabIndex={x === on ? 0 : -1}
                className="wcor__row" data-chance={chance || undefined} onClick={() => pick(x.id)}
                data-tip={`r ${signedR(x.r)} over ${plural(x.n, "match", "matches")}.${chance ? " Inside the shaded band: chance alone often gives this much." : ""}`}>
                <span className="wcor__lab">{labelOf(x.id)}</span>
                <span className="wcor__trk" aria-hidden>
                  <i className="wcor__band" style={{ left: `${50 - 50 * x.band}%`, width: `${100 * x.band}%` }} />
                  <i className="wcor__mid" />
                  <i className="wcor__bar" style={x.r >= 0 ? { left: "50%", width: `${w}%` } : { right: "50%", width: `${w}%` }} />
                </span>
                <b className="num wcor__r">{signedR(x.r)}</b>
              </button>
            );
          })}
        </div>
        <div className="wcor__key" aria-hidden>
          <span className="wcor__ends"><span>with losses</span><span>with wins</span></span>
          <span className="wcor__chance"><span className="wcor__swatch" />{sameN ? `What chance alone gives at ${plural(n, "match", "matches")}` : "What chance alone gives at each row's matches"}</span>
        </div>
        {left}
      </div>
      <div id={`${uid}-panel`} role="tabpanel" aria-labelledby={`${uid}-${on.id}`} className="wcor__panel">
        <Trend id={on.id} q={q} list={list} />
      </div>
    </div>
  );
}

/** One stat by match, oldest first, each match's W or L under it; its mean in wins and losses over every match; its slope. */
function Trend({ id, q, list }: { id: string; q: Query; list: MatchEntry[] }) {
  // the one metric per match, by file, from the worker's single pass (matchValues)
  const call = useCall("matchValues", [q, id]);
  const byFile = call.stale ? null : call.data;
  const pts = useMemo(() => (byFile ? list.map((e) => ({ e, value: byFile[e.file] ?? null, won: e.result === "T" ? null : e.result === "W" })) : null), [byFile, list]);
  // the slope over match order, oldest first (trends.ts trend)
  const series = useMemo(() => (pts ? [[...pts].reverse().map((p) => p.value)] : null), [pts]);
  const slope = useCall("trends", series ? [series] : null).data?.[0] ?? null;
  if (!pts) return <div className="skel" style={{ height: 200 }} />;
  const means = winLossMeans(pts);
  const recent = pts.slice(0, LINE_MATCHES).reverse();
  const fmt = (v: number) => fmtMetric(id, v);
  const signedFmt = (v: number) => `${v > 0 ? "+" : v < 0 ? "−" : ""}${fmtMetric(id, Math.abs(v))}`;
  const wins = pts.filter((p) => p.won === true && p.value !== null).length;
  const losses = pts.filter((p) => p.won === false && p.value !== null).length;
  return (
    <>
      <p className="wcor__head"><b data-tip={tipOf(id)} tabIndex={0}>{labelOf(id)}</b><span className="meta">by match, oldest first{pts.length > LINE_MATCHES ? `, last ${LINE_MATCHES}` : ""}</span></p>
      <div className="wcor__line">
        <MatchLine label={`${labelOf(id)} by match`} fmt={fmt} pooled={null}
          points={recent.map((p) => ({ key: p.e.file, value: p.value, label: fmtMatchDay(p.e.match), result: p.e.result, href: matchHref(p.e.file) }))} />
      </div>
      <dl className="figs figs--wide wcor__figs">
        <Fig label="In wins" value={means.won === null ? "–" : fmt(means.won)} sub={plural(wins, "match", "matches")} />
        <Fig label="In losses" value={means.lost === null ? "–" : fmt(means.lost)} sub={plural(losses, "match", "matches")} />
        <Fig label="Trend" value={slope ? signedFmt(slope.slope) : "–"} sub={slope ? `per match, over ${plural(slope.n, "match", "matches")}` : "Needs 3 matches"} />
      </dl>
    </>
  );
}
