// Utility: flashes, grenade damage and smokes per player, split by side, and where grenades landed.
import { useMemo, useState } from "react";
import type { Measures } from "../../../stats/facts";
import { Num } from "../../components/bits";
import { Card } from "../../components/Card";
import { Segmented } from "../../components/controls";
import { DataTable } from "../../components/DataTable";
import { frameFor, RadarView } from "../../components/MapArt";
import { SIDE_OPTIONS, fmtMetric, type SideKey } from "../../data/engine";
import type { MPlayer as PlayerRow } from "../../data/match";
import { metric } from "../../data/meta";
import { NADE_LABEL, NadeIcon, type Nade } from "../../icons/game";
import { fmtSecs, plural } from "../../lib/format";
import { PlayerName, SectionAside, Empty, NeedsDemo } from "../shared";
import { Hint } from "./glyphs";
import type { TabProps } from "./MatchView";

export default function Utility({ v }: TabProps) {
  const [side, setSide] = useState<SideKey>("both");
  const lines = v.b.lines[side];
  const sl = (p: PlayerRow): Measures => lines[p.pi].m;
  const val = (p: PlayerRow, id: string) => lines[p.pi].v[id];
  const team = (t: "us" | "them") => v.players.filter((p) => p.team === t);
  const sum = (t: "us" | "them", f: (u: Measures) => number) => team(t).reduce((a, p) => a + f(sl(p)), 0);
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
            { key: "fl", label: <><NadeIcon type="flash" size={12} beside />Flashes thrown</>, tip: "Flashbangs thrown", sort: (p) => sl(p).flashes, render: (p) => sl(p).flashes },
            { key: "ef", label: "Blinded", tip: "Enemies your flashes blinded, once per enemy per flash", sort: (p) => sl(p).enemiesFlashed, render: (p) => sl(p).enemiesFlashed },
            { key: "bt", label: "Blind time", tip: "Seconds of blindness your flashes caused on enemies", sort: (p) => sl(p).enemyBlindSecs, render: (p) => <span data-tip={`${fmtMetric("blindPerFlash", val(p, "blindPerFlash"))} per flash`}><Num v={fmtSecs(sl(p).enemyBlindSecs)} /></span> },
            { key: "pf", label: "Per flash", tip: metric("enemiesPerFlash").def, sort: (p) => val(p, "enemiesPerFlash"), render: (p) => fmtMetric("enemiesPerFlash", val(p, "enemiesPerFlash")) },
            { key: "fa", label: "Assists", tip: "Flash assists: a teammate killed an enemy you had blinded", sort: (p) => sl(p).flashAssists, render: (p) => sl(p).flashAssists },
            { key: "tf", label: "Team flashed", tip: "Times your flashes blinded a teammate", sort: (p) => sl(p).teamFlashed, firstDir: "asc", render: (p) => <span className={sl(p).teamFlashed ? "poor-text" : undefined} data-tip={`${fmtSecs(sl(p).teamBlindSecs)} of teammate blindness, ${fmtMetric("teamFlashPR", val(p, "teamFlashPR"))} per round`}>{sl(p).teamFlashed}</span> },
            { key: "he", label: <><NadeIcon type="he" size={12} beside />HE damage</>, tip: "Damage from your HE grenades to enemies", sort: (p) => sl(p).heDmg, render: (p) => sl(p).heDmg },
            { key: "fire", label: <><NadeIcon type="molotov" size={12} beside />Fire damage</>, tip: "Fire damage from your molotovs and incendiaries to enemies", sort: (p) => sl(p).fireDmg, render: (p) => <span data-tip={`${fmtMetric("fireDmgPR", val(p, "fireDmgPR"))} per round`}>{sl(p).fireDmg}</span> },
            { key: "sm", label: <><NadeIcon type="smoke" size={12} beside />Smokes thrown</>, tip: "Smokes thrown", sort: (p) => sl(p).smokes, render: (p) => sl(p).smokes },
            { key: "dmg", label: "Utility damage", tip: "All grenade and fire damage to enemies", sort: (p) => sl(p).utilDmg, render: (p) => (
              <span className="cellbar" data-tip={`${fmtMetric("utilDmgPR", val(p, "utilDmgPR"))} per round`}><span className="hbar"><i style={{ width: `${(sl(p).utilDmg / maxDmg) * 100}%`, background: p.team === "us" ? "var(--cream)" : "var(--ink2)" }} /></span><b className="num">{sl(p).utilDmg}</b></span>
            ), width: 150 },
          ]}
        />
      </Card>
      <Landing v={v} />
    </div>
  );
}

const TYPES: Nade[] = ["smoke", "flash", "he", "molotov"];
const COLOR: Record<Nade, string> = { smoke: "var(--ink)", flash: "var(--cream)", he: "var(--poor-text)", molotov: "var(--t)", decoy: "var(--ink3)" };
/** GrenadeFact.weapon (the grenade class) as the grenade glyphs name it. */
const NADE_OF: Record<string, Nade> = { smokegrenade: "smoke", flashbang: "flash", hegrenade: "he", molotov: "molotov", incgrenade: "molotov", decoy: "decoy" };

/**
 * Where grenades landed, with the throw origin when it was recorded (grenadesOf in the worker). Plugin
 * files before 1.0.0 have no throw log, so the adapter rebuilt one throw per detonation, placed at the
 * detonation and with no landing point (MatchInfo.inputs.throws "rebuilt", plugin/adapter.ts). There
 * the throw point is the detonation: it is drawn as the landing point, marked approximate, with no
 * throw line.
 */
function Landing({ v }: { v: TabProps["v"] }) {
  const rebuilt = v.facts.match.inputs.throws === "rebuilt";
  const [who, setWho] = useState<"you" | "team" | "all">("you");
  const [types, setTypes] = useState<Set<Nade>>(new Set(TYPES));
  const nades = useMemo(() => v.b.grenades.flatMap((g) => {
    const type = NADE_OF[g.weapon];
    const at = rebuilt ? g.from : g.land;
    return at && type ? [{ x: at[0], y: at[1], type, from: rebuilt ? null : g.from, pi: g.pi }] : [];
  }), [v, rebuilt]);
  const frame = useMemo(() => frameFor(v.map, nades.map((n) => [n.x, n.y])), [v.map, nades]);
  const mine = (pi: number) => who === "all" || (who === "you" ? pi === v.human : v.players[pi]?.team === "us");
  const shown = nades.filter((n) => types.has(n.type) && mine(n.pi));
  const toggle = (t: Nade) => setTypes((s) => { const n = new Set(s); if (n.has(t)) n.delete(t); else n.add(t); return n; });
  return (
    <Card title={<>Where grenades landed {nades.length > 0 && <Hint tip={rebuilt ? "Points are detonations; where each was thrown is unknown." : "Lines run from where each grenade was thrown."} />}</>} aside={<span className="card__aside-row">{rebuilt && nades.length > 0 && <span className="chip chip--approx">Approximate</span>}<span className="meta">{plural(shown.length, "grenade")}</span></span>} collapsible id="match-landing">
      {!nades.length || !frame ? (
        <Empty text={<NeedsDemo detail={v.b.grenades.some((g) => g.from)
          ? "This file has throw points but no landing points."
          : "This match has no grenade positions."} />} />
      ) : (
        <div className="landing">
          <div className="landing__side">
            <Segmented label="Whose grenades" value={who} onChange={setWho} options={[{ value: "you", label: "You" }, { value: "team", label: "Your team" }, { value: "all", label: "Everyone" }]} />
            <div className="landing__types" role="group" aria-label="Grenade types">
              {TYPES.map((t) => {
                const n = nades.filter((x) => x.type === t && mine(x.pi)).length;
                return (
                  <button key={t} className="landing__type" aria-pressed={types.has(t)} onClick={() => toggle(t)}>
                    <i style={{ background: COLOR[t] }} /><NadeIcon type={t} size={14} beside /><span>{NADE_LABEL[t]}</span><b className="num">{n}</b>
                  </button>
                );
              })}
            </div>
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
