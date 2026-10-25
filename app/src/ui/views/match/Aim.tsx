// The match's Aim tab: the human's aim in this match. Recorded matches only.
import { useMemo } from "react";
import { hitMap, weaponTallies } from "../../data/interim";
import { useRawMatch } from "../../data/hooks";
import { AimIcon } from "../../icons/ui";
import { pageHref } from "../../router";
import { AimPanels } from "../aim/AimPanels";
import { Empty } from "../shared";
import type { TabProps } from "./MatchView";

export default function Aim({ v, file }: TabProps) {
  const raw = useRawMatch(v.aim ? file : null).data;
  const hits = useMemo(() => (raw ? hitMap(raw) : null), [raw]);
  const guns = useMemo(() => (raw ? [...weaponTallies(raw).values()] : null), [raw]);
  if (!v.aim) {
    return (
      <div className="tabpad">
        <div className="card">
          <Empty
            icon={<AimIcon size={40} />}
            text="This match is a converted log, which has no shots. Record a match with the capture plugin to see your accuracy, spray and hit map."
            action={<a className="btn" href={pageHref("aim")}>Open career aim</a>}
          />
        </div>
      </div>
    );
  }
  return <div className="tabpad"><AimPanels a={v.aim} hits={hits} guns={guns} scope="this match" /></div>;
}
