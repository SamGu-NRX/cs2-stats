// Utility: grenades thrown, flash assists and HE damage per player, split by side.
import { useMemo, useState } from "react";
import type { Measures } from "../../../stats/facts";
import { rollup } from "../../../stats/rollup";
import { Card } from "../../components/Card";
import { Segmented } from "../../components/controls";
import { DataTable } from "../../components/DataTable";
import { SIDE_OPTIONS, sidesOf, type SideKey } from "../../data/engine";
import type { MPlayer as PlayerRow } from "../../data/match";
import { NadeIcon } from "../../icons/game";
import { PlayerName, SectionAside } from "../shared";
import type { TabProps } from "./MatchView";

export default function Utility({ v }: TabProps) {
  const [side, setSide] = useState<SideKey>("both");
  const ms = useMemo(() => v.players.map((p) => rollup([v.facts], { player: p.key, ...sidesOf(side) }).m), [v, side]);
  const sl = (p: PlayerRow): Measures => ms[p.pi];
  const team = (t: "us" | "them") => v.players.filter((p) => p.team === t);
  const sum = (t: "us" | "them", f: (m: Measures) => number) => team(t).reduce((a, p) => a + f(sl(p)), 0);
  const maxDmg = Math.max(1, ...v.players.map((p) => sl(p).heDmg));
  return (
    <div className="tabpad utility">
      <div className="toolbar">
        <Segmented label="Side" value={side} onChange={setSide} options={SIDE_OPTIONS.map((o) => ({ ...o, label: o.value === "both" ? "Both sides" : o.label, side: o.value === "both" ? undefined : o.value }))} />
        <div className="toolbar__end">
          <SectionAside label="HE damage" value={<><span className="cream">{sum("us", (u) => u.heDmg)}</span><span className="faint">–</span>{sum("them", (u) => u.heDmg)}</>} />
          <SectionAside label="Flash assists" value={<><span className="cream">{sum("us", (u) => u.flashAssists)}</span><span className="faint">–</span>{sum("them", (u) => u.flashAssists)}</>} />
        </div>
      </div>
      <Card title="Flashes, grenades and smokes" flush>
        <DataTable<PlayerRow>
          label="Utility by player"
          groups={[{ key: "us", label: "Your team", rows: team("us") }, { key: "them", label: "Opponents", rows: team("them") }]}
          rowKey={(p) => p.key}
          defaultSort={{ key: "dmg", dir: "desc" }}
          rowClass={(p) => (p.isHuman ? "is-you" : undefined)}
          columns={[
            { key: "name", label: "Player", align: "l", sticky: true, sort: (p) => p.name, render: (p) => <span className="name-cell"><PlayerName v={v} pi={p.pi} /></span>, width: 170 },
            { key: "fl", label: <><NadeIcon type="flash" size={12} />Thrown</>, tip: "Flashbangs thrown", sort: (p) => sl(p).flashes, render: (p) => sl(p).flashes },
            { key: "fa", label: "Assists", tip: "Flash assists: a teammate killed an enemy you had blinded", sort: (p) => sl(p).flashAssists, render: (p) => sl(p).flashAssists },
            { key: "fk", label: "Led to a kill", tip: "Enemies you flashed who died to your team while still blind", sort: (p) => sl(p).flashKills, render: (p) => sl(p).flashKills },
            { key: "hes", label: <><NadeIcon type="he" size={12} />Thrown</>, tip: "HE grenades thrown", sort: (p) => sl(p).hes, render: (p) => sl(p).hes },
            { key: "mo", label: <><NadeIcon type="molotov" size={12} />Thrown</>, tip: "Molotovs and incendiaries thrown", sort: (p) => sl(p).molotovs, render: (p) => sl(p).molotovs },
            { key: "sm", label: <><NadeIcon type="smoke" size={12} />Smokes</>, tip: "Smokes thrown", sort: (p) => sl(p).smokes, render: (p) => sl(p).smokes },
            { key: "dmg", label: <><NadeIcon type="he" size={12} />Dmg</>, tip: "Damage from your HE grenades to enemies", sort: (p) => sl(p).heDmg, render: (p) => (
              <span className="cellbar"><span className="hbar"><i style={{ width: `${(sl(p).heDmg / maxDmg) * 100}%`, background: p.team === "us" ? "var(--cream)" : "var(--ink2)" }} /></span><b className="num">{sl(p).heDmg}</b></span>
            ), width: 150 },
          ]}
        />
      </Card>
    </div>
  );
}
