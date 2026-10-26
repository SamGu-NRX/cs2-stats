// Game glyphs: kill and death marks, round win types, team buy types, grenades and weapons.
import type { BuyClass } from "../../stats/economy";
import type { KillFact } from "../../stats/facts";
import type { RoundHow } from "../data/match";
import { weaponClass, weaponLabel } from "../../stats/weapons";
import { Svg, type IconProps } from "./Icon";

// ---------------------------------------------------------------- kills and deaths (16 grid, filled)

const SKULL = "M8 1.25C4.6 1.25 2.25 3.6 2.25 6.75c0 1.95.9 3.4 2.25 4.25v2.1c0 .55.45 1 1 1h5c.55 0 1-.45 1-1V11c1.35-.85 2.25-2.3 2.25-4.25C13.75 3.6 11.4 1.25 8 1.25z";
const EYES = "M5.9 5.7a1.55 1.55 0 1 1 0 3.1 1.55 1.55 0 0 1 0-3.1zM10.1 5.7a1.55 1.55 0 1 1 0 3.1 1.55 1.55 0 0 1 0-3.1zM8 9.3l.85 1.5h-1.7z";
const TEETH = "M6.65 12.4h.8v1.7h-.8zM8.55 12.4h.8v1.7h-.8z";

/** A kill. The headshot variant has a bullet hole in the forehead; colour comes from CSS. */
export const SkullIcon = ({ hs, ...p }: IconProps & { hs?: boolean }) => (
  <Svg {...p} grid={16} solid>
    <path fillRule="evenodd" d={`${SKULL}${EYES}${TEETH}${hs ? "M8 2.6a1 1 0 1 1 0 2 1 1 0 0 1 0-2z" : ""}`} />
  </Svg>
);

/** A death. */
export const DeathIcon = (p: IconProps) => (
  <Svg {...p} grid={16}><path d="M4 4l8 8M12 4l-8 8" strokeWidth="2" /></Svg>
);

// ---------------------------------------------------------------- win types (16 grid, stroke)

function star(cx: number, cy: number, ro: number, ri: number, n: number): string {
  const pts: string[] = [];
  for (let i = 0; i < n * 2; i++) {
    const a = (Math.PI * i) / n - Math.PI / 2;
    const r = i % 2 ? ri : ro;
    pts.push(`${(cx + r * Math.cos(a)).toFixed(2)} ${(cy + r * Math.sin(a)).toFixed(2)}`);
  }
  return `M${pts.join("L")}Z`;
}
const BURST = star(8, 8, 6.75, 3.1, 8);

/** Elimination: a filled crosshair diamond (filled so it holds at 12 px). */
export const ElimIcon = (p: IconProps) => (
  <Svg {...p} grid={16} solid>
    <path fillRule="evenodd" d="M8 1.5L14.5 8 8 14.5 1.5 8zM8 5.6L5.6 8 8 10.4 10.4 8z" />
    <path d="M7.4 0h1.2v3.4H7.4zM7.4 12.6h1.2V16H7.4zM0 7.4h3.4v1.2H0zM12.6 7.4H16v1.2h-3.4z" />
  </Svg>
);
export const BombIcon = (p: IconProps) => <Svg {...p} grid={16}><path d={BURST} /></Svg>;
export const DefuseIcon = (p: IconProps) => (
  <Svg {...p} grid={16}><path d="M5.75 1.5l1.6 5.1M10.25 1.5l-1.6 5.1" /><circle cx="8" cy="7.75" r="1.3" /><path d="M7.2 9l-2.6 5.5M8.8 9l2.6 5.5" /></Svg>
);
/** Time: a clock reading 1:55, the length of a CS2 round. */
export const TimeIcon = (p: IconProps) => (
  <Svg {...p} grid={16}><circle cx="8" cy="8" r="6.25" /><path d="M8 8l-2-3.45M8 8l2.35-1.5" /></Svg>
);
export const UnknownIcon = (p: IconProps) => (
  <Svg {...p} grid={16}><circle cx="8" cy="8" r="6" strokeDasharray="2 2" /></Svg>
);

export const WIN_LABEL: Record<RoundHow, string> = { elim: "Elimination", bomb: "Bomb exploded", defuse: "Bomb defused", time: "Time ran out" };

export function WinIcon({ how, ...p }: IconProps & { how: RoundHow | null }) {
  if (how === "elim") return <ElimIcon {...p} />;
  if (how === "bomb") return <BombIcon {...p} />;
  if (how === "defuse") return <DefuseIcon {...p} />;
  if (how === "time") return <TimeIcon {...p} />;
  return <UnknownIcon {...p} />;
}

// ---------------------------------------------------------------- buy types (16 grid, filled)
// Ascending bars, HLTV's classes: eco one, half buy two, full buy three. Pistol rounds show a pistol.
// main also drew CS Demo Manager's "force-buy" as three hollow bars; the engine has no such class
// (stats/economy.ts classifies HLTV's four), so that glyph is gone.

export const BUY_LABEL: Record<BuyClass, string> = { pistol: "Pistol", eco: "Eco", half: "Half buy", full: "Full buy" };

const BARS = ["M2.5 10h3v4h-3z", "M6.5 6.5h3V14h-3z", "M10.5 2.5h3V14h-3z"];

export function BuyIcon({ buy, ...p }: IconProps & { buy: BuyClass | null }) {
  if (buy === "pistol") return <Svg {...p} grid={16} solid><path d="M1.75 4.75h11.5v2.6h-1.1l-.9.9H8.7l-1.35 4.5H4.55l1.15-4.5H4.4l-.35-.9H1.75z" /></Svg>;
  const n = buy === "eco" ? 1 : buy === "half" ? 2 : buy === "full" ? 3 : 0;
  if (!n) return <UnknownIcon {...p} />;
  return (
    <Svg {...p} grid={16} solid>
      {BARS.map((d, i) => <path key={d} d={d} opacity={i < n ? 1 : 0.25} />)}
    </Svg>
  );
}

// ---------------------------------------------------------------- grenades (16 grid)

export type Nade = "he" | "flash" | "smoke" | "molotov" | "decoy";
export const NADE_LABEL: Record<Nade, string> = { he: "HE grenade", flash: "Flashbang", smoke: "Smoke", molotov: "Molotov", decoy: "Decoy" };

export function NadeIcon({ type, ...p }: IconProps & { type: Nade }) {
  switch (type) {
    case "he":
      return <Svg {...p} grid={16}><circle cx="7.5" cy="10" r="4.5" /><path d="M6 5.6V3.75h3V5.6M9 4.25h2.4l1.6 2.5" /></Svg>;
    case "flash":
      return <Svg {...p} grid={16}><rect x="4" y="4.5" width="5" height="10" rx="1.5" /><path d="M5.5 4.5V2.5h2v2M11.5 6l2.25-1.5M12 9.5h2.5M11.5 13l2.25 1.5" /></Svg>;
    case "smoke":
      return <Svg {...p} grid={16}><rect x="5" y="7" width="6" height="8" rx="1.25" /><path d="M5 10.5h6" /><path d="M4.75 5.25a1.6 1.6 0 0 1 1.9-2.15 1.9 1.9 0 0 1 3.3.3 1.5 1.5 0 0 1 1.3 1.85" /></Svg>;
    case "molotov":
      return <Svg {...p} grid={16}><path d="M7 5.5h2v2l1.5 1.75v5a1 1 0 0 1-1 1h-3a1 1 0 0 1-1-1v-5L7 7.5z" /><path d="M8 .9c1.1 1.1 1.2 2.1.1 3.1-1.1-1-1-2 0-3.1z" fill="currentColor" stroke="none" /></Svg>;
    case "decoy":
      return <Svg {...p} grid={16}><rect x="3" y="5" width="5" height="9" rx="1.5" /><path d="M4.5 5V3h2v2M10.5 7.5a2.5 2.5 0 0 1 0 4M12.5 5.75a5 5 0 0 1 0 7.5" /></Svg>;
  }
}

// ---------------------------------------------------------------- weapons (64×20 grid, filled)

const W = {
  rifle: "M2 7.2L13.5 6.2 15.5 5h24.5l1 1.5h14.5v-1h2v1h4.5v2H41l-1 1.5h-6.8l-2 7-4-.5 1.4-6.5h-6l-1.6 5h-3.5l1.5-5h-4.5L3 13.2 2 12.2z",
  sniper: "M2 8.4L12 7.2l2 .8h26v1h22v1.6H40l-2 1.5H24.5l-2.2 4h-3.6l1-4h-5.4L4 14 2 13zM19.5 3.4h3.2v1h11.8v-1h3.2v4h-3.2v-1H22.7v1h-3.2zM24 7.4h2v.8h-2zM31 7.4h2v.8h-2z",
  smg: "M3.5 7h4.5v1.6H3.5zM8 6h26v1h10v2H34l-1 2h-6l-1 6h-4l1-6h-7l-2 4h-3l1.5-4H8z",
  pistol: "M18 6h26v3.5h-4l-2 1.5H29l-2.4 6.5h-5.2l2.2-6.5L21.8 9.5H18z",
  shotgun: "M2 8.2L13 7.2l2-.7h21v.5h24v2H36l-1 1.5H22l-1.5 4H17l1-4h-4L3 13 2 12zM39.5 9.5h12.5V12H39.5z",
  mg: "M2 8.2L12 7.2 14 5h26v1.5h20v2H40l-1 2.5h-9v5h-7v-5h-3l-1.5 4h-3l1-4H14L3 13 2 12zM47.5 8.5h1.4l-2.6 7.5h-1.4zM50.5 8.5h1.4l2.6 7.5h-1.4z",
  knife: "M6 9.2L20 8.4l2-1.2 2 .9v3.4l-2 1-2-1.1L6 10.8zM24 8.2h25l9 1.3-9 2H24z",
  zeus: "M18 6.5h20v3h-3l-1 1.5h-6l-2 6h-5l2-6-2-1.5h-3zM40 5.5l4-2-1.5 3.5 4.5-.5-6 5 1.5-3.5z",
  c4: "M18 5h28v11H18zM21 7.5h10v3H21zM34 7.5h2v2h-2zM38 7.5h2v2h-2zM42 7.5h2v2h-2zM34 11h2v2h-2zM38 11h2v2h-2zM42 11h2v2h-2z",
  world: "M30 3h4v9h4.5L32 18l-6.5-6H30z",
} as const;
type Silhouette = keyof typeof W;

const SHOTGUNS = new Set(["nova", "xm1014", "sawedoff", "mag7"]);
const NADE_OF: Record<string, Nade> = { hegrenade: "he", flashbang: "flash", smokegrenade: "smoke", molotov: "molotov", incgrenade: "molotov", inferno: "molotov", decoy: "decoy" };

function silhouetteOf(name: string): Silhouette | null {
  if (name === "taser") return "zeus";
  if (name === "planted_c4" || name === "c4") return "c4";
  if (name === "world" || name === "trigger_hurt" || name === "") return "world";
  const c = weaponClass(name);
  if (c === "heavy") return SHOTGUNS.has(name) ? "shotgun" : "mg";
  if (c === "rifle" || c === "sniper" || c === "smg" || c === "pistol" || c === "knife") return c;
  return null;
}

/** A weapon as a silhouette (grenades as their 16-unit glyph). Height sets the size. */
export function WeaponIcon({ name, size = 14, ...p }: IconProps & { name: string }) {
  const nade = NADE_OF[name];
  if (nade) return <NadeIcon {...p} type={nade} size={size} label={p.label ?? weaponLabel(name)} />;
  const s = silhouetteOf(name) ?? "rifle";
  return (
    <Svg {...p} size={size} grid={[64, 20]} solid label={p.label ?? weaponLabel(name)}>
      <path d={W[s]} fillRule="evenodd" />
    </Svg>
  );
}

/** Class silhouettes for tables grouped by weapon class. */
export function WeaponClassIcon({ cls, ...p }: IconProps & { cls: string }) {
  const name = { rifle: "ak47", sniper: "awp", smg: "mp9", heavy: "nova", pistol: "glock", knife: "knife", grenade: "hegrenade", other: "taser" }[cls] ?? "ak47";
  return <WeaponIcon name={name} label={undefined} {...p} />;
}

// ---------------------------------------------------------------- killfeed flags (16 grid)
// The kill's flags as the engine's KillFact carries them.

export const HeadshotIcon = (p: IconProps) => (
  <Svg {...p} grid={16}><circle cx="8" cy="6.5" r="4" /><path d="M3.5 15c.6-2.6 2.3-3.9 4.5-3.9s3.9 1.3 4.5 3.9" /><circle cx="8" cy="6.5" r="1.1" fill="currentColor" stroke="none" /></Svg>
);
export const WallbangIcon = (p: IconProps) => (
  <Svg {...p} grid={16}><path d="M6.5 2v12M9.5 2v12" /><path d="M1 8h14" strokeDasharray="2 1.5" /><path d="M12.5 5.5L15 8l-2.5 2.5" /></Svg>
);
export const SmokeKillIcon = (p: IconProps) => (
  <Svg {...p} grid={16}><path d="M4.5 12.5a3 3 0 0 1-.4-6 4 4 0 0 1 7.6-.9A3.2 3.2 0 0 1 11.8 12.5z" /></Svg>
);
export const NoscopeIcon = (p: IconProps) => (
  <Svg {...p} grid={16}><circle cx="8" cy="8" r="5.5" /><path d="M8 2.5v3M8 10.5v3M2.5 8h3M10.5 8h3" /><path d="M2.5 13.5l11-11" /></Svg>
);

/** The killer was flashed: an eye with a slash. Fallback for the icon pack's "blind". */
export const BlindIcon = (p: IconProps) => (
  <Svg {...p} grid={16}><path d="M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8s-2.4 4.5-6.5 4.5S1.5 8 1.5 8z" /><circle cx="8" cy="8" r="1.8" /><path d="M2.5 13.5l11-11" /></Svg>
);
/** The killer was in the air: a rising arc. Fallback for the icon pack's "inair". */
export const InAirIcon = (p: IconProps) => (
  <Svg {...p} grid={16}><path d="M2 13c2-6 6-9 12-9" /><path d="M10.5 3.5L14 4l-.6 3.4" /><path d="M2 14.5h4" /></Svg>
);

type Flag = "headshot" | "wallbang" | "smoke" | "noscope" | "killerBlind" | "killerInAir";
export const KILL_FLAGS: { flag: Flag; label: string; Icon: (p: IconProps) => JSX.Element }[] = [
  { flag: "headshot", label: "Headshot", Icon: HeadshotIcon },
  { flag: "wallbang", label: "Wallbang", Icon: WallbangIcon },
  { flag: "smoke", label: "Through smoke", Icon: SmokeKillIcon },
  { flag: "noscope", label: "No-scope", Icon: NoscopeIcon },
  { flag: "killerBlind", label: "Killer was blind", Icon: BlindIcon },
  { flag: "killerInAir", label: "Airborne", Icon: InAirIcon },
];

/** The flags set on a kill, as icons. killerBlind and killerInAir are null when the source did not record them, which shows nothing. */
export function KillFlags({ kill, size = 13 }: { kill: Pick<KillFact, Flag>; size?: number }) {
  const on = KILL_FLAGS.filter((f) => kill[f.flag] === true);
  if (!on.length) return null;
  return <span className="kflags">{on.map(({ flag, label, Icon }) => <Icon key={flag} size={size} label={label} />)}</span>;
}

/** First kill of the round (a drop) or first death (a hollow drop). */
export const FirstKillIcon = ({ death, ...p }: IconProps & { death?: boolean }) => (
  <Svg {...p} grid={16} solid={!death}>
    <path d="M8 2.2c2.3 2.9 3.6 5 3.6 6.9a3.6 3.6 0 0 1-7.2 0c0-1.9 1.3-4 3.6-6.9z" />
  </Svg>
);

