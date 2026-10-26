// Game objects: weapons, grenades, kill flags, round ends, the bomb and buys, each drawn by the CS2
// icon pack through GameIcon (components/GameIcon.tsx) with the pack ids from design-target-v2/SYSTEM.md's
// icon table, and named in words. Nothing here is drawn by hand: without the pack an object shows its
// name. The first-kill pip and the death mark are text, not icons (components/bits.tsx).
//
// `beside`: the object's name is already in the text beside it or in its element's tooltip, so the icon
// is silent and needs no text without the pack. `compact`: the cell is too small for the name, so the
// no-pack fallback is one letter (round rails, the economy chart); the cell's own label names it.
import type { BuyClass } from "../../stats/economy";
import type { KillFact } from "../../stats/facts";
import { weaponLabel } from "../../stats/weapons";
import { GameIcon } from "../components/GameIcon";
import type { RoundHow } from "../data/match";

// ---------------------------------------------------------------- round ends

export const WIN_LABEL: Record<RoundHow, string> = { elim: "Elimination", bomb: "Bomb exploded", defuse: "Bomb defused", time: "Time ran out" };
const WIN_ID: Record<RoundHow, string> = { elim: "elimination", bomb: "bomb_exploded", defuse: "bomb_defused", time: "time" };
const WIN_SHORT: Record<RoundHow, string> = { elim: "E", bomb: "B", defuse: "D", time: "T" };

/** How a round ended; an unknown end is the pack's plain round win. Colour comes from the parent. */
export function WinIcon({ how, size, beside, compact }: { how: RoundHow | null; size: number; beside?: boolean; compact?: boolean }) {
  return <GameIcon id={how ? WIN_ID[how] : "round_win"} name={how ? WIN_LABEL[how] : "Round won"} width={size} beside={beside || compact} text={compact ? (how ? WIN_SHORT[how] : "W") : undefined} />;
}

// ---------------------------------------------------------------- buys

export const BUY_LABEL: Record<BuyClass, string> = { pistol: "Pistol", eco: "Eco", half: "Half buy", full: "Full buy" };
/** SYSTEM.md: money for a full buy, eco_request for an eco, buyzone for a pistol round. A half buy is
 * also money; the text label beside it tells the two apart. */
const BUY_ID: Record<BuyClass, string> = { pistol: "buyzone", eco: "eco_request", half: "money", full: "money" };
const BUY_SHORT: Record<BuyClass, string> = { pistol: "P", eco: "E", half: "H", full: "F" };

/** A team's or a player's buy; nothing for an unknown buy, whose text says so. */
export function BuyIcon({ buy, size, beside, compact, className }: { buy: BuyClass | null; size: number; beside?: boolean; compact?: boolean; className?: string }) {
  if (!buy) return null;
  return <GameIcon id={BUY_ID[buy]} name={BUY_LABEL[buy]} width={size} beside={beside || compact} text={compact ? BUY_SHORT[buy] : undefined} className={className} />;
}

// ---------------------------------------------------------------- grenades

export type Nade = "he" | "flash" | "smoke" | "molotov" | "decoy";
export const NADE_LABEL: Record<Nade, string> = { he: "HE grenade", flash: "Flashbang", smoke: "Smoke", molotov: "Molotov", decoy: "Decoy" };
const NADE_ID: Record<Nade, string> = { he: "hegrenade", flash: "flashbang", smoke: "smokegrenade", molotov: "molotov", decoy: "decoy" };

/** A grenade; CT's fire grenade is the incendiary. */
export function NadeIcon({ type, size, side, beside }: { type: Nade; size: number; side?: "T" | "CT"; beside?: boolean }) {
  const id = type === "molotov" && side === "CT" ? "incgrenade" : NADE_ID[type];
  return <GameIcon id={id} name={type === "molotov" && side === "CT" ? "Incendiary" : NADE_LABEL[type]} width={size} beside={beside} />;
}

// ---------------------------------------------------------------- weapons

/** The pack id for an engine weapon name: the bomb and the world are equipment, the rest are their own names. */
const weaponId = (name: string) => (name === "trigger_hurt" || name === "" ? "world" : name);

/** A gun, knife, grenade or the bomb, at a fixed height; guns are wide, so their box is about three times as wide. */
export function WeaponIcon({ name, height = 14, beside, className }: { name: string; height?: number; beside?: boolean; className?: string }) {
  const square = /grenade|flashbang|molotov|decoy|inferno|c4|world/.test(name);
  return <GameIcon id={weaponId(name)} name={weaponLabel(name)} width={square ? height : Math.round(height * 2.9)} height={height} beside={beside} className={`gicon--gun ${className ?? ""}`} />;
}

/** A weapon class as the class's representative weapon (SYSTEM.md): ak47, awp, mp9, nova, glock, knife, hegrenade, taser. */
const CLASS_GUN: Record<string, string> = { rifle: "ak47", sniper: "awp", smg: "mp9", heavy: "nova", pistol: "glock", knife: "knife", grenade: "hegrenade", other: "taser" };
export function WeaponClassIcon({ cls, height = 12 }: { cls: string; height?: number }) {
  return <WeaponIcon name={CLASS_GUN[cls] ?? "ak47"} height={height} beside />;
}

// ---------------------------------------------------------------- kill flags

type Flag = "headshot" | "wallbang" | "smoke" | "noscope" | "killerBlind" | "killerInAir";
/** The kill's flags as the engine's KillFact carries them, with the pack's killfeed icon for each. */
export const KILL_FLAGS: { flag: Flag; id: string; label: string }[] = [
  { flag: "headshot", id: "headshot", label: "Headshot" },
  { flag: "wallbang", id: "wallbang", label: "Wallbang" },
  { flag: "smoke", id: "smoke", label: "Through smoke" },
  { flag: "noscope", id: "noscope", label: "No-scope" },
  { flag: "killerBlind", id: "blind", label: "Killer was blind" },
  { flag: "killerInAir", id: "inair", label: "Airborne" },
];

/** One killfeed flag by its pack id. */
export function FlagIcon({ id, label, size }: { id: string; label: string; size: number }) {
  return <GameIcon id={id} name={label} width={size} />;
}

/** The flags set on a kill. killerBlind and killerInAir are null when the source did not record them, which shows nothing. */
export function KillFlags({ kill, size = 13 }: { kill: Pick<KillFact, Flag>; size?: number }) {
  const on = KILL_FLAGS.filter((f) => kill[f.flag] === true);
  if (!on.length) return null;
  return <span className="kflags">{on.map(({ flag, id, label }) => <FlagIcon key={flag} id={id} label={label} size={size} />)}</span>;
}
