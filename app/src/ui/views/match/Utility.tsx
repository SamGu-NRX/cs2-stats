// Utility: flashes, grenade damage and smokes per player, split by side, and where grenades landed.
import { useMemo, useState } from "react";
import type { PlayerRow } from "../../../stats/derive";
import { sideSlices, type UtilSlice } from "../../../stats/utility";
import { Num } from "../../components/bits";
import { Card } from "../../components/Card";
import { Segmented } from "../../components/controls";
import { DataTable } from "../../components/DataTable";
import { frameFor, RadarView } from "../../components/MapArt";
import { SIDE_OPTIONS, sideOfKey, type SideKey } from "../../data/engine";
import { useMapPositions, useRawMatch } from "../../data/hooks";
import { NadeIcon, NADE_LABEL, type Nade } from "../../icons/game";
import { fmtDec, fmtSecs, plural } from "../../lib/format";
import { PlayerName, SectionAside, Empty } from "../shared";
import type { TabProps } from "./MatchView";

const per = (a: number, b: number) => (b > 0 ? a / b : null);

export default function Utility({ v, file }: TabProps) {
  const [side, setSide] = useState<SideKey>("both");
  const sl = (p: PlayerRow): UtilSlice => sideSlices(p.c.util, side === "both" ? "both" : sideOfKey(side)!);
  const team = (t: "us" | "them") => v.players.filter((p) => p.team === t);
  const sum = (t: "us" | "them", f: (u: UtilSlice) => number) => team(t).reduce((a, p) => a + f(sl(p)), 0);
  const maxDmg = Math.max(1, ...v.players.map((p) => sl(p).utilDmg));
  return (
    <div className="tabpad utility">
      <div className="toolbar">
        <Segmented label="Side" value={side} onChange={setSide} options={SIDE_OPTIONS.map((o) => ({ ...o, label: o.value === "both" ? "Both sides" : o.label, side: o.value === "both" ? undefined : o.value }))} />
        <div className="toolbar__end">
          <SectionAside label="Utility damage" value={<><span className="cream">{sum("us", (u) => u.utilDmg)}</span><span className="faint">–</span>{sum("them", (u) => u.utilDmg)}</>} />
          <SectionAside label="Enemies blinded" value={<><span className="cream">{sum("us", (u) => u.enemiesFlashed)}</span><span className="faint">–</span>{sum("them", (u) => u.enemiesFlashed)}</>} />
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
            { key: "ef", label: "Blinded", tip: "Enemies your flashes blinded, once per enemy per flash", sort: (p) => sl(p).enemiesFlashed, render: (p) => sl(p).enemiesFlashed },
            { key: "bt", label: "Blind time", tip: "Seconds of blindness your flashes caused on enemies", sort: (p) => sl(p).enemyBlindMs, render: (p) => <Num v={fmtSecs(sl(p).enemyBlindMs / 1000)} /> },
            { key: "pf", label: "Per flash", tip: "Enemies blinded per flash thrown", sort: (p) => per(sl(p).enemiesFlashed, sl(p).flashes), render: (p) => fmtDec(per(sl(p).enemiesFlashed, sl(p).flashes)) },
            { key: "fa", label: "Assists", tip: "Flash assists: a teammate killed an enemy you had blinded", sort: (p) => sl(p).flashAssists, render: (p) => sl(p).flashAssists },
            { key: "tf", label: "Team flashed", tip: "Times your flashes blinded a teammate", sort: (p) => sl(p).teamFlashed, firstDir: "asc", render: (p) => <span className={sl(p).teamFlashed ? "poor-text" : undefined}>{sl(p).teamFlashed}</span> },
            { key: "he", label: <><NadeIcon type="he" size={12} />Dmg</>, tip: "Damage from your HE grenades to enemies", sort: (p) => sl(p).heDmg, render: (p) => sl(p).heDmg },
            { key: "fire", label: <><NadeIcon type="molotov" size={12} />Dmg</>, tip: "Fire damage from your molotovs and incendiaries to enemies", sort: (p) => sl(p).fireDmg, render: (p) => sl(p).fireDmg },
            { key: "sm", label: <><NadeIcon type="smoke" size={12} />Smokes</>, tip: "Smokes thrown", sort: (p) => sl(p).smokes, render: (p) => sl(p).smokes },
            { key: "dmg", label: "Utility dmg", tip: "All grenade and fire damage to enemies", sort: (p) => sl(p).utilDmg, render: (p) => (
              <span className="cellbar"><span className="hbar"><i style={{ width: `${(sl(p).utilDmg / maxDmg) * 100}%`, background: p.team === "us" ? "var(--cream)" : "var(--ink2)" }} /></span><b className="num">{sl(p).utilDmg}</b></span>
            ), width: 150 },
          ]}
        />
      </Card>
      <Landing v={v} file={file} />
    </div>
  );
}

const TYPES: Nade[] = ["smoke", "flash", "he", "molotov"];
const COLOR: Record<Nade, string> = { smoke: "var(--ink)", flash: "var(--cream)", he: "var(--poor-text)", molotov: "var(--t)", decoy: "var(--ink3)" };

/** Where grenades landed (detonation points), with the throw origin when the plugin recorded it. */
function Landing({ v, file }: { v: TabProps["v"]; file: string }) {
  const raw = useRawMatch(file).data;
  const pos = useMapPositions(v.map).data;
  const [who, setWho] = useState<"you" | "team" | "all">("you");
  const [types, setTypes] = useState<Set<Nade>>(new Set(TYPES));
  const nades = useMemo(() => {
    if (!raw) return [];
    const g = raw.grenades;
    const out: { x: number; y: number; type: Nade; from: [number, number] | null; pi: number }[] = [];
    for (let i = 0; i < g.ri.length; i++) {
      const p = g.pos[i];
      const t = g.thrower[i];
      if (!p || t === null) continue;
      const th = g.throw?.[i];
      const from = th != null && raw.throws?.pos[th] ? [raw.throws.pos[th]![0], raw.throws.pos[th]![1]] as [number, number] : null;
      out.push({ x: p[0], y: p[1], type: g.type[i] as Nade, from, pi: t });
    }
    return out;
  }, [raw]);
  const frame = useMemo(() => frameFor(v.map, pos, nades.map((n) => [n.x, n.y])), [v.map, pos, nades]);
  const shown = nades.filter((n) => types.has(n.type) && (who === "all" || (who === "you" ? n.pi === v.human : v.players[n.pi]?.team === "us")));
  const toggle = (t: Nade) => setTypes((s) => { const n = new Set(s); if (n.has(t)) n.delete(t); else n.add(t); return n; });
  return (
    <Card title="Where grenades landed" aside={<span className="meta">{plural(shown.length, "grenade")}</span>} collapsible id="match-landing">
      {!raw ? <div className="skel" style={{ height: 320 }} /> : !nades.length || !frame ? (
        <Empty icon={<NadeIcon type="smoke" size={36} />} text="This match has no grenade positions. Recorded matches carry them." />
      ) : (
        <div className="landing">
          <div className="landing__side">
            <Segmented label="Whose grenades" value={who} onChange={setWho} options={[{ value: "you", label: "You" }, { value: "team", label: "Your team" }, { value: "all", label: "Everyone" }]} />
            <div className="landing__types" role="group" aria-label="Grenade types">
              {TYPES.map((t) => {
                const n = nades.filter((x) => x.type === t && (who === "all" || (who === "you" ? x.pi === v.human : v.players[x.pi]?.team === "us"))).length;
                return (
                  <button key={t} className="landing__type" aria-pressed={types.has(t)} onClick={() => toggle(t)}>
                    <i style={{ background: COLOR[t] }} /><NadeIcon type={t} size={14} /><span>{NADE_LABEL[t]}</span><b className="num">{n}</b>
                  </button>
                );
              })}
            </div>
            <p className="meta">Lines run from where the grenade was thrown, when the plugin recorded it.</p>
          </div>
          <div className="landing__map">
            <RadarView map={v.map} frame={frame} label={`${shown.length} grenade landing points`}>
              {shown.map((n, i) => {
                const [x, y] = frame.to(n.x, n.y);
                const from = n.from ? frame.to(...n.from) : null;
                return (
                  <g key={i}>
                    {from && <line x1={from[0]} y1={from[1]} x2={x} y2={y} stroke={COLOR[n.type]} strokeOpacity="0.35" strokeWidth="2" />}
                    {n.type === "smoke" ? <circle cx={x} cy={y} r="18" fill="rgba(230,226,220,.16)" stroke="rgba(230,226,220,.6)" strokeWidth="2" />
                      : n.type === "molotov" ? <circle cx={x} cy={y} r="14" fill="rgba(219,136,28,.28)" stroke="var(--t)" strokeWidth="2" />
                      : <circle cx={x} cy={y} r="7" fill={COLOR[n.type]} stroke="var(--bg0)" strokeWidth="2" />}
                  </g>
                );
              })}
            </RadarView>
          </div>
        </div>
      )}
    </Card>
  );
}
