// Icons shared by the match tabs. Weapons, grenades and round ends draw the official CS2 icon from the
// local pack (components/GameIcon.tsx) and fall back to the app's own glyph when the pack is missing.
import { GameIcon } from "../../components/GameIcon";
import type { RoundHow } from "../../data/match";
import { KILL_FLAGS, NadeIcon, NADE_LABEL, WeaponIcon, WinIcon, WIN_LABEL, type Nade } from "../../icons/game";
import type { KillFact } from "../../../stats/facts";
import { weaponLabel } from "../../../stats/weapons";

export { FirstKillIcon } from "../../icons/game";
export { TradingIcon as TradingGlyph, UtilityIcon as UtilityGlyph, SnipingIcon as AimGlyph } from "../../icons/attributes";

/** The pack's round_end icons by the app's round-end names. */
const ROUND_END_ID: Record<RoundHow, string> = { elim: "elimination", bomb: "bomb_exploded", defuse: "bomb_defused", time: "time" };
/** The pack's grenade icons by the app's grenade names. */
const NADE_ID: Record<Nade, string> = { he: "hegrenade", flash: "flashbang", smoke: "smokegrenade", molotov: "molotov", decoy: "decoy" };

/** How a round ended; colour comes from the parent (the winning side's text class). */
export function RoundEndIcon({ how, size, label }: { how: RoundHow | null; size: number; label?: boolean }) {
  const name = label && how ? WIN_LABEL[how] : undefined;
  return <GameIcon id={how ? ROUND_END_ID[how] : null} width={size} label={name} fallback={<WinIcon how={how} size={size} label={name} />} />;
}

export function GameNade({ type, size, label }: { type: Nade; size: number; label?: boolean }) {
  const name = label ? NADE_LABEL[type] : undefined;
  return <GameIcon id={NADE_ID[type]} width={size} label={name} fallback={<NadeIcon type={type} size={size} label={name} />} />;
}

/** A gun at a fixed height; the official icons are wide, so the box is about three times as wide. */
export function GameWeapon({ name, height }: { name: string; height: number }) {
  return <GameIcon id={name} width={Math.round(height * 2.9)} height={height} label={weaponLabel(name)} className="gicon--gun" fallback={<WeaponIcon name={name} size={height} />} />;
}

/** A kill's flags (headshot, wallbang, through smoke, no-scope) as the official killfeed icons. */
export function GameKillFlags({ kill, size }: { kill: Pick<KillFact, "headshot" | "wallbang" | "smoke" | "noscope">; size: number }) {
  const on = KILL_FLAGS.filter((f) => kill[f.flag]);
  if (!on.length) return null;
  return <span className="kflags">{on.map(({ flag, label, Icon }) => <GameIcon key={flag} id={flag} width={size} label={label} fallback={<Icon size={size} label={label} />} />)}</span>;
}

/** The "?" after a panel title: the panel's explanation, one short sentence, on hover and focus. */
export function Hint({ tip }: { tip: string }) {
  return <span className="hint" data-tip={tip} tabIndex={0} role="note" aria-label={tip}>?</span>;
}
