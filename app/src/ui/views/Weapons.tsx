// Weapons: every gun you have used, best and weakest first, each with one signal: its accuracy against
// your pooled accuracy with every other gun (views/aim/guns.tsx, which Career aim's gun table shares).
import { useMemo } from "react";
import { weaponLabel } from "../../stats/weapons";
import { Num } from "../components/bits";
import { Card } from "../components/Card";
import { DataTable } from "../components/DataTable";
import { careerEntries, fmtMetric, WEAPON_CLASS_LABEL } from "../data/engine";
import { useData } from "../data/provider";
import { tipOf } from "../data/tips";
import { fmtInt, fmtRatio } from "../lib/format";
import { scoreText, toScore } from "../lib/scale";
import { BarContent } from "../shell/Bar";
import { useScope } from "../shell/filters";
import { bestAndWorst, EDGE_TIP, edgeText, edgeTip, GunCell, GunHero, HEAD_TIP, type Judged, MIN_SHOTS, PROF_TIP, share, SplitCell, useGuns } from "./aim/guns";
import { Empty } from "./shared";

export default function Weapons() {
  const { matches } = useData();
  const { map, n } = useScope();
  const list = useMemo(() => { const f = careerEntries(matches, map); return n ? f.slice(0, n) : f; }, [matches, map, n]);
  const guns = useGuns(list);
  const { best, worst } = guns ? bestAndWorst(guns) : { best: null, worst: null };
  return (
    <div className="view view--capped">
      <BarContent crumbs={[{ label: "Weapons" }]} scope={{ controls: ["map", "matches"] }} />
      <div className="view__in weapons">
        {!list.length ? <Card><Empty text="No gun kills or shots in this filter." /></Card> : !guns ? <div className="skel" style={{ height: 240 }} /> : !guns.length ? <Card><Empty text="No gun kills or shots in this filter." /></Card> : (
          <>
            <div className="grid-2">
              {best && <GunHero g={best} tone="best" />}
              {worst && <GunHero g={worst} tone="worst" />}
            </div>
            <GunTable guns={guns} />
          </>
        )}
      </div>
    </div>
  );
}

function GunTable({ guns }: { guns: Judged[] }) {
  return (
    <Card className="guntbl" title="Every gun" aside={<span className="meta">Accuracy needs {MIN_SHOTS}+ recorded shots</span>} flush>
      <DataTable<Judged>
        label="Every gun"
        rows={guns}
        rowKey={(g) => g.weapon}
        defaultSort={{ key: "kills", dir: "desc" }}
        columns={[
          { key: "gun", label: "Gun", align: "l", sort: (g) => weaponLabel(g.weapon), render: (g) => <GunCell g={g} cls={WEAPON_CLASS_LABEL[g.cls]} />, width: 260 },
          { key: "kills", label: "Kills", sort: (g) => g.kills.n, render: (g) => <SplitCell s={g.kills} what="kills" /> },
          { key: "hsk", label: "HS kills", tip: tipOf("hs"), sort: (g) => share(g.hsKills, g.kills.n), render: (g) => <Num v={fmtRatio(g.hsKills, g.kills.n)} /> },
          { key: "shots", label: "Shots", sort: (g) => g.shots, render: (g) => g.shots || <span className="faint">–</span> },
          { key: "acc", label: "Accuracy", colored: true, sort: (g) => g.acc, render: (g) => <span style={{ color: g.edge === null ? undefined : scoreText(toScore(g.edge, 0, 8)) }}><Num v={fmtMetric("accuracy", g.acc)} /></span>, tip: "Coloured against your accuracy with your other guns." },
          { key: "first", label: "First bullet", sort: (g) => g.first, render: (g) => <Num v={fmtMetric("firstBulletAccuracy", g.first)} />, tip: tipOf("firstBulletAccuracy") },
          { key: "head", label: "Head share", tip: HEAD_TIP, sort: (g) => share(g.head, g.hits), render: (g) => <Num v={fmtRatio(g.head, g.hits)} /> },
          { key: "rounds", label: "Rounds used", sort: (g) => g.rounds.n, render: (g) => <SplitCell s={g.rounds} what="rounds" /> },
          { key: "prof", label: "Proficiency", tip: PROF_TIP, sort: (g) => g.prof?.proficiency ?? null, render: (g) => <span data-tip={g.prof?.evidence} tabIndex={g.prof ? 0 : undefined}><Num v={fmtInt(g.prof?.proficiency)} /></span> },
          {
            key: "edge", label: "Vs your other guns", colored: true, sort: (g) => g.edge, tip: EDGE_TIP,
            render: (g) => (g.edge === null ? <span className="faint">–</span> : <span className="num" style={{ color: scoreText(toScore(g.edge, 0, 8)) }} data-tip={edgeTip(g)} tabIndex={0}>{edgeText(g.edge)}</span>),
          },
        ]}
      />
    </Card>
  );
}
