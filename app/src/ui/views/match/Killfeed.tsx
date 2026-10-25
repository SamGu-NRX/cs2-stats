// The round drawer's killfeed, read like CS2's: killer, gun, modifiers, victim, in fixed columns so
// nothing overlaps at any name length. Time sits on the left; swing on the right is always from your
// team's side (a kill by an enemy reads negative). Official icons come from the local pack, with the
// app's glyphs as the fallback.
import { GameIcon } from "../../components/GameIcon";
import { HeadshotIcon, NoscopeIcon, SmokeKillIcon, WallbangIcon, WeaponIcon } from "../../icons/game";
import type { Side } from "../../../stats/tables";
import { weaponLabel } from "../../../stats/weapons";

export interface FeedKill {
  /** seconds since freeze end */
  t: number | null;
  killer: { name: string; side: Side } | null;
  victim: { name: string; side: Side };
  assister: { name: string; flash: boolean } | null;
  weapon: string;
  headshot: boolean;
  wallbang: boolean;
  smoke: boolean;
  noscope: boolean;
  opening: boolean;
  tradeKill: boolean;
  /** change in your team's chance to win the round, a fraction; null when the round is not valued */
  swing: number | null;
  /** you made or took this kill */
  mine: boolean;
}

const MODS: { key: "noscope" | "smoke" | "wallbang" | "headshot"; id: string; label: string; Glyph: typeof HeadshotIcon }[] = [
  { key: "noscope", id: "noscope", label: "No scope", Glyph: NoscopeIcon },
  { key: "smoke", id: "smoke", label: "Through smoke", Glyph: SmokeKillIcon },
  { key: "wallbang", id: "wallbang", label: "Through a wall", Glyph: WallbangIcon },
  { key: "headshot", id: "headshot", label: "Headshot", Glyph: HeadshotIcon },
];

const clock = (t: number | null) => (t === null ? "–" : `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`);
const sideClass = (s: Side) => (s === "T" ? "t-text" : "ct-text");

export function KillRow({ k }: { k: FeedKill }) {
  const sw = k.swing;
  return (
    <div className="kfeed" data-mine={k.mine || undefined}>
      <span className="kfeed__t mono">{clock(k.t)}</span>
      <span className={`kfeed__n kfeed__n--k ${k.killer ? sideClass(k.killer.side) : "faint"}`} title={k.killer ? `${k.killer.name}${k.assister ? ` with ${k.assister.name}${k.assister.flash ? " (flash)" : ""}` : ""}` : "The world"}>
        {k.killer?.name ?? "World"}
        {k.assister ? <small> + {k.assister.name}</small> : null}
      </span>
      <span className="kfeed__w">
        <GameIcon id={k.weapon} width={40} height={14} label={weaponLabel(k.weapon)} fallback={<WeaponIcon name={k.weapon} size={14} />} />
        {MODS.filter((m) => k[m.key]).map((m) => (
          <span key={m.key} title={m.label}><GameIcon id={m.id} width={14} label={m.label} fallback={<m.Glyph size={14} label={m.label} />} /></span>
        ))}
        {k.opening ? <span className="kfeed__tag" title="First kill of the round">1ST</span> : null}
        {k.tradeKill ? <span className="kfeed__tag" title="Avenged a teammate killed in the last 5 s">TRADE</span> : null}
      </span>
      <span className={`kfeed__n ${sideClass(k.victim.side)}`} title={k.victim.name}>{k.victim.name}</span>
      <span className={`kfeed__sw num ${sw === null ? "faint" : sw >= 0 ? "good-text" : "poor-text"}`} title="Change in your team's chance to win the round">
        {sw === null ? "–" : `${sw >= 0 ? "+" : "−"}${Math.abs(100 * sw).toFixed(1)}%`}
      </span>
    </div>
  );
}

export function Killfeed({ kills }: { kills: FeedKill[] }) {
  if (!kills.length) return <p className="meta">No kills this round.</p>;
  return <div className="kfeeds" role="list" aria-label="Killfeed">{kills.map((k, i) => <div role="listitem" key={i}><KillRow k={k} /></div>)}</div>;
}
