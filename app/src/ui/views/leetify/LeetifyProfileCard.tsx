// Profile, Overview: Leetify's ratings and averages beside this app's numbers over the same player's
// matches here. The two columns come from different matches (Leetify's recent ones, and the career
// matches under the title bar's Map and Matches controls) and different definitions, which the sample line
// and the seam say. Until the data is in, the card says why instead: not connected, fetching, or failed
// (store.ts leetifyPhase); it never shows a number it does not have. Anyone's public profile can be
// connected; when it is not the player whose matches are here (store.ts leetifyOwner), the card shows
// Leetify's numbers alone and says whose they are.
import { useMemo } from "react";
import { Card } from "../../components/Card";
import { PROFILE_GROUPS, PROFILE_SCORES, lf, type OursSource } from "../../data/leetify/present";
import { leetifyPhase, useLeetify, useLeetifyJoin } from "../../data/leetify/store";
import { useRollups } from "../../data/hooks";
import { plural } from "../../lib/format";
import type { Query, Rolled } from "../../../worker/protocol";
import { pageHref } from "../../router";
import { Attribution, CompareTable, fetchedAgo, LeetifyLink, LeetifyPending, SyntheticChip } from "./parts";

export function LeetifyProfileCard({ q, t, ct, matches }: { q: Query; t: Rolled; ct: Rolled; matches: number }) {
  const l = useLeetify();
  const j = useLeetifyJoin();
  const phase = leetifyPhase(l?.state ?? null);
  // both sides whatever the Side control says: Leetify's numbers are over both
  const on = j !== null;
  const both = useRollups(useMemo(() => (on ? [{ files: q.files, filter: { player: q.filter.player } }] : null), [q, on])).data?.[0] ?? null;
  if (phase === "none") return null;
  if (phase === "off") {
    return (
      <Card title="Leetify" className="lt-card lt-card--off" aside={<Attribution />}>
        <p className="meta">Not connected. <a className="link lt-inline" href={pageHref("settings")}>Connect your Leetify profile</a> in Data &amp; settings to see its ratings beside yours.</p>
      </Card>
    );
  }
  if (!j || phase !== "ready") {
    return (
      <Card title="Leetify" className="lt-card" aside={<Attribution />}>
        <LeetifyPending phase={phase === "failed" ? "failed" : "loading"} error={l?.state.fetchError ?? l?.state.error ?? null} hasKey={l?.state.status?.hasKey ?? false} retry={() => void l?.store.refresh()} />
      </Card>
    );
  }
  const p = j.data.profile;
  if (j.owner === "other") {
    return (
      <Card title="Leetify" className="lt-card lt-card--other"
        aside={<span className="card__aside-row">{j.synthetic && <SyntheticChip />}<span className="meta">{fetchedAgo(j.data.fetchedAt)}</span><LeetifyLink url={p.url} personal /><Attribution badge /></span>}>
        <p className="meta lt-sample lt-sample--top">
          {p.name}'s Leetify profile. They are not the player in your matches here, so nothing of ours sits beside their numbers.
        </p>
        <div className="lt-scores">
          {PROFILE_SCORES.map((s) => (
            <div key={s.key} className="lt-score">
              <span className="caps has-def" data-tip={s.what} tabIndex={0}>{s.label}</span>
              <b className="disp lt-score__v">{lf.score(p.rating[s.key])}</b>
            </div>
          ))}
        </div>
        <CompareTable groups={PROFILE_GROUPS} source={p} ours={null} label={`${p.name}'s Leetify numbers`} solo />
      </Card>
    );
  }
  const ours: OursSource | null = both ? { both: { v: both.v, m: both.m }, t: { v: t.v, m: t.m }, ct: { v: ct.v, m: ct.m } } : null;
  return (
    <Card
      title="Leetify"
      className="lt-card"
      tip="Leetify's ratings and averages beside ours. = counts the same thing, ≠ counts it differently; focus either for how."
      aside={<span className="card__aside-row">{j.synthetic && <SyntheticChip />}<span className="meta">{fetchedAgo(j.data.fetchedAt)}</span><LeetifyLink url={p.url} personal /><Attribution badge /></span>}
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
