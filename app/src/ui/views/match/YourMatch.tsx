// "Your match": this match against your last ten earlier matches (worker yourMatch, the reference pooled
// over those matches). Each metric is a lollipop from your usual value at the track's middle tick: its
// length is the change as a share of the usual value, capped at half either way, and its colour says
// better or worse (a lower death rate is better). The value, your usual value and the change are text.
import { Card } from "../../components/Card";
import { fmtMetric } from "../../data/engine";
import { useCall } from "../../data/hooks";
import type { ViewedMatch } from "../../data/match";
import { metric } from "../../data/meta";
import { Num } from "../../components/bits";
import { plural } from "../../lib/format";
import type { YourMatchRow } from "../../../stats/matchviews";
import { relChange, signedIn, YOUR_MATCH } from "./parity";

/** Recent matches the worker compares against. */
const RECENT = 10;
/** A change of this share of your usual value reaches the track's end; a drawing scale only. */
const CAP = 0.5;

function Row({ row, n }: { row: YourMatchRow; n: number }) {
  const m = metric(row.id);
  const fmt = (x: number | null) => fmtMetric(row.id, x);
  const rel = relChange(row.value, row.average);
  const at = rel === null ? null : 50 + (50 * Math.max(-CAP, Math.min(CAP, rel))) / CAP;
  const tone = row.direction === "better" ? "q5" : row.direction === "worse" ? "q1" : "q3";
  const tip = [m.tip, row.average === null ? "Not in your earlier matches." : `This match ${fmt(row.value)}; your last ${plural(n, "match", "matches")} ${fmt(row.average)}.`].join("\n");
  return (
    <li className="ymr" data-tip={tip} tabIndex={0}>
      <span className="ymr__l">{m.label}</span>
      <span className={`trk ymr__trk ${tone}`} aria-hidden>
        <span className="trk__mid" />
        {at !== null && <>
          <i className="ymr__stem" style={{ left: `${Math.min(50, at)}%`, width: `${Math.abs(at - 50)}%` }} />
          <i className="trk__dot" style={{ left: `${at}%` }} />
        </>}
      </span>
      <b className="num ymr__v"><Num v={fmt(row.value)} /></b>
      <span className="num ymr__avg"><Num v={fmt(row.average)} /></span>
      <span className={`num ymr__d ${row.direction === "better" ? "good-text" : row.direction === "worse" ? "poor-text" : "faint"}`}>
        {row.delta === null ? "–" : <Num v={signedIn((x) => fmt(x), row.delta)} />}
      </span>
    </li>
  );
}

export function YourMatch({ v, file }: { v: ViewedMatch; file: string }) {
  const me = v.players[v.human];
  const r = useCall("yourMatch", [file, me.key, RECENT]);
  const n = r.data?.recent.length ?? 0;
  const byId = new Map((r.data?.rows ?? []).map((x) => [x.id, x]));
  const rowOf = (id: string) => {
    const x = byId.get(id);
    if (!x) throw new Error(`yourMatch returned no row for "${id}"`);
    return x;
  };
  return (
    <Card title="Against your recent matches" aside={n ? <span className="meta">Your last {plural(n, "match", "matches")} before this</span> : undefined}>
      {r.error ? <p className="meta">{r.error}</p> : !r.data ? <div className="skel" style={{ height: 200 }} /> : !n ? (
        <p className="meta">No earlier match of {me.name} in your folder to compare with.</p>
      ) : (
        <div className="ym">
          <div className="ymr ymr--head caps" aria-hidden>
            <span />
            <span className="ymr__scale"><span>Lower</span><span>Usual</span><span>Higher</span></span>
            <span className="ymr__v">Match</span>
            <span className="ymr__avg">Usual</span>
            <span className="ymr__d">Change</span>
          </div>
          {YOUR_MATCH.map((g) => (
            <section key={g.group} aria-label={g.group}>
              <h3 className="caps ym__h">{g.group}</h3>
              <ul className="ym__rows">{g.ids.map((id) => <Row key={id} row={rowOf(id)} n={n} />)}</ul>
            </section>
          ))}
        </div>
      )}
    </Card>
  );
}
