// Weapon classes and CS2 store prices, keyed by the player_death weapon name (no "weapon_" prefix).

export type WeaponClass = "pistol" | "smg" | "heavy" | "rifle" | "sniper" | "grenade" | "knife" | "other";

const CLASS: Record<string, WeaponClass> = {};
const add = (cls: WeaponClass, names: string[]) => names.forEach((n) => (CLASS[n] = cls));
add("pistol", ["glock", "hkp2000", "usp_silencer", "p250", "elite", "fiveseven", "tec9", "cz75a", "deagle", "revolver"]);
add("smg", ["mac10", "mp9", "mp7", "mp5sd", "ump45", "p90", "bizon"]);
add("heavy", ["nova", "xm1014", "sawedoff", "mag7", "m249", "negev"]);
add("rifle", ["galilar", "famas", "ak47", "m4a1", "m4a1_silencer", "sg556", "aug"]);
add("sniper", ["awp", "ssg08", "g3sg1", "scar20"]);
add("grenade", ["hegrenade", "flashbang", "smokegrenade", "molotov", "incgrenade", "inferno", "decoy"]);

export function weaponClass(name: string): WeaponClass {
  if (name.startsWith("knife") || name === "bayonet") return "knife";
  return CLASS[name] ?? "other";
}

/** AWP, SSG 08 and the two autosnipers, as in CS Demo Manager's sniper weapon type. */
export const isSniper = (name: string) => CLASS[name] === "sniper";

/**
 * Damage from these weapons is utility damage. CS Demo Manager counts damage whose weapon type is
 * "grenade" (HE, molotov/incendiary fire, flashbang, smoke, decoy impacts).
 */
export const isUtility = (name: string) => CLASS[name] === "grenade";

/** CS2 store prices in dollars, used only to reconstruct equipment values for legacy logs. */
export const PRICE: Record<string, number> = {
  glock: 200, hkp2000: 200, usp_silencer: 200, p250: 300, elite: 300, fiveseven: 500, tec9: 500, cz75a: 500,
  deagle: 700, revolver: 600,
  mac10: 1050, mp9: 1250, mp7: 1500, mp5sd: 1500, ump45: 1200, p90: 2350, bizon: 1400,
  nova: 1050, xm1014: 2000, sawedoff: 1100, mag7: 1300, m249: 5200, negev: 1700,
  galilar: 1800, famas: 2050, ak47: 2700, m4a1: 3100, m4a1_silencer: 2900, sg556: 3000, aug: 3300,
  awp: 4750, ssg08: 1700, g3sg1: 5000, scar20: 5000,
  hegrenade: 300, flashbang: 200, smokegrenade: 300, molotov: 400, incgrenade: 500, decoy: 50, taser: 200,
  kevlar: 650, assaultsuit: 1000, defuser: 400,
};

const LABEL: Record<string, string> = {
  glock: "Glock-18", hkp2000: "P2000", usp_silencer: "USP-S", p250: "P250", elite: "Dual Berettas",
  fiveseven: "Five-SeveN", tec9: "Tec-9", cz75a: "CZ75-Auto", deagle: "Desert Eagle", revolver: "R8 Revolver",
  mac10: "MAC-10", mp9: "MP9", mp7: "MP7", mp5sd: "MP5-SD", ump45: "UMP-45", p90: "P90", bizon: "PP-Bizon",
  nova: "Nova", xm1014: "XM1014", sawedoff: "Sawed-Off", mag7: "MAG-7", m249: "M249", negev: "Negev",
  galilar: "Galil AR", famas: "FAMAS", ak47: "AK-47", m4a1: "M4A4", m4a1_silencer: "M4A1-S", sg556: "SG 553",
  aug: "AUG", awp: "AWP", ssg08: "SSG 08", g3sg1: "G3SG1", scar20: "SCAR-20", hegrenade: "HE grenade",
  flashbang: "Flashbang", smokegrenade: "Smoke", molotov: "Molotov", incgrenade: "Incendiary", inferno: "Fire",
  decoy: "Decoy", taser: "Zeus x27", planted_c4: "Bomb", world: "World",
};

export function weaponLabel(name: string): string {
  if (name.startsWith("knife") || name === "bayonet") return "Knife";
  return LABEL[name] ?? name;
}
