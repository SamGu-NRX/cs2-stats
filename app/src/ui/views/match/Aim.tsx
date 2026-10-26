// The match's Aim tab: the human's aim in this match. Recorded matches only.
import { useMemo } from "react";
import { AimIcon } from "../../icons/ui";
import { pageHref } from "../../router";
import { AimPanels } from "../aim/AimPanels";
import { Empty, NeedsDemo } from "../shared";
import type { TabProps } from "./MatchView";

export default function Aim({ v }: TabProps) {
  const query = useMemo(() => ({ files: [v.file], filter: { player: v.players[v.human].key } }), [v]);
  if (!v.entry.hasAim) {
    return (
      <div className="tabpad">
        <div className="card">
          <Empty
            icon={<AimIcon size={40} />}
            text={<NeedsDemo detail="Converted logs and older plugin versions record no shots." />}
            action={<a className="btn" href={pageHref("aim")}>Open career aim</a>}
          />
        </div>
      </div>
    );
  }
  return <div className="tabpad"><AimPanels query={query} label="this match" visibility={v.visibility} statuses={[v.entry.match.visibility]} /></div>;
}
