// A match's Overview, when the match is joined to a Leetify match (data/leetify/join.ts): Leetify's
// numbers for the player beside ours from the same match. Nothing renders for a match with no Leetify
// partner, or when no Leetify profile is connected. While a connected profile's data is on its way, or
// failed to load, a short card says so: whether this match is joined is not known until the data is in.
import { Card } from "../../components/Card";
import { matchUrl } from "../../data/leetify/api";
import { MATCH_GROUPS, sourceName, type OursSource } from "../../data/leetify/present";
import { leetifyPhase, useLeetify, useLeetifyJoin } from "../../data/leetify/store";
import type { MatchModel } from "../../data/match";
import { Attribution, CompareTable, LeetifyLink, LeetifyPending, SyntheticChip } from "./parts";

const RULE = {
  "match-id": { label: "Same match id", tip: "Leetify's share code for this match holds the same Valve match id as this demo's file name." },
  time: { label: "Same time, map and score", tip: "Leetify's match ended within 10 minutes of this one, on the same map with the same score, and no other match fits." },
};

export function LeetifyMatchCard({ v }: { v: MatchModel }) {
  const l = useLeetify();
  const j = useLeetifyJoin();
  const phase = leetifyPhase(l?.state ?? null);
  if (phase === "loading" || phase === "failed") {
    return (
      <Card title="Leetify, this match" className="lt-card lt-card--match" aside={<Attribution />}>
        <LeetifyPending phase={phase} error={l?.state.error ?? null} hasKey={l?.state.status?.hasKey ?? false} retry={() => void l?.store.refresh()} />
      </Card>
    );
  }
  const hit = j?.joined.byFile.get(v.file);
  if (!j || !hit || phase !== "ready") return null;
  const line = (side: "both" | "t" | "ct") => v.b.lines[side][v.human];
  const ours: OursSource = { both: line("both"), t: line("t"), ct: line("ct") };
  const rule = RULE[hit.rule];
  return (
    <Card
      title="Leetify, this match"
      className="lt-card lt-card--match"
      tip="Leetify's numbers for you in this match beside ours. = counts the same thing, ≠ counts it differently; focus either for how."
      aside={(
        <span className="card__aside-row">
          {j.synthetic && <SyntheticChip />}
          <span className="chip chip--outline has-def" data-tip={rule.tip} tabIndex={0}>{rule.label}</span>
          <span className="meta">{sourceName(hit.match.dataSource)}</span>
          <LeetifyLink url={matchUrl(hit.match)} />
          <Attribution badge />
        </span>
      )}
    >
      <CompareTable groups={MATCH_GROUPS} source={hit.match.me} ours={ours} label="Leetify's numbers for this match beside ours" />
    </Card>
  );
}
