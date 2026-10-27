// Profile, Overview: Leetify's ratings and averages beside this app's numbers over the same player's
// matches here. Shown only once a Leetify profile is connected and fetched; otherwise nothing, since an
// empty card would only advertise. The two columns come from different matches (Leetify's recent ones,
// and the career matches under the title bar's Map and Matches controls) and different definitions, which
// the sample line and the seam say.
import { useMemo } from "react";
import { Card } from "../../components/Card";
import { PROFILE_GROUPS, PROFILE_SCORES, lf, type OursSource } from "../../data/leetify/present";
import { useLeetifyJoin } from "../../data/leetify/store";
import { useRollups } from "../../data/hooks";
import { plural } from "../../lib/format";
import type { Query, Rolled } from "../../../worker/protocol";
import { Attribution, CompareTable, fetchedAgo, LeetifyLink, SyntheticChip } from "./parts";

export function LeetifyProfileCard({ q, t, ct, matches }: { q: Query; t: Rolled; ct: Rolled; matches: number }) {
  const j = useLeetifyJoin();
  // both sides whatever the Side control says: Leetify's numbers are over both
  const on = j !== null;
  const both = useRollups(useMemo(() => (on ? [{ files: q.files, filter: { player: q.filter.player } }] : null), [q, on])).data?.[0] ?? null;
  if (!j) return null;
  const p = j.data.profile;
  const ours: OursSource | null = both ? { both: { v: both.v, m: both.m }, t: { v: t.v, m: t.m }, ct: { v: ct.v, m: ct.m } } : null;
  return (
    <Card
      title="Leetify"
      className="lt-card"
      tip="Leetify's ratings and averages beside ours. = counts the same thing, ≠ counts it differently; focus either for how."
      aside={<span className="card__aside-row">{j.synthetic && <SyntheticChip />}<span className="meta">{fetchedAgo(j.data.fetchedAt)}</span><LeetifyLink url={p.url} personal /><Attribution /></span>}
    >
      <div className="lt-scores">
        {PROFILE_SCORES.map((s) => (
          <div key={s.key} className="lt-score">
            <span className="caps has-def" data-tip={s.what} tabIndex={0}>{s.label}</span>
            <b className="disp lt-score__v">{lf.score(p.rating[s.key])}</b>
            <span className="meta">Leetify only</span>
          </div>
        ))}
      </div>
      <p className="meta lt-sample">
        Leetify: its profile averages over the recent matches it has analysed{p.totalMatches !== null ? ` (${plural(p.totalMatches, "match", "matches")} in total)` : ""}. Ours: {plural(matches, "match", "matches")} here, both sides.
      </p>
      <CompareTable groups={PROFILE_GROUPS} source={p} ours={ours} label="Leetify's numbers beside ours" />
    </Card>
  );
}
