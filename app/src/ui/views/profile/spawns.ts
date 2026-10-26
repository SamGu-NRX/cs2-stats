// Role by spawn's rows. The engine lists one row per spawn point (rolesBySpawn), and many spawn points
// share a side, a place and a position, so the raw list repeats "front right, TSpawn" with a few rounds
// each. The card reads one row per side, place and position instead.
import type { RoleBlend } from "../../../stats/identity";
import type { SpawnRow } from "../../../worker/protocol";

/** The card lists at most this many groups, most rounds first. */
export const SPAWN_TOP = 6;
/** A group with fewer rounds than this goes into the "and N more" line, however few groups there are. */
export const SPAWN_MIN_ROUNDS = 3;

export interface SpawnGroup {
  side: "T" | "CT";
  /** "front right, TSpawn"; the spawn id when the engine named neither position nor place */
  label: string;
  rounds: number;
  /** the role with the largest share of the rounds-weighted blend; null when no row had a blend */
  role: string | null;
  /** that role's share, 0 to 1 */
  fit: number | null;
}

export interface SpawnSummary {
  shown: SpawnGroup[];
  /** the groups left out (past SPAWN_TOP, or under SPAWN_MIN_ROUNDS) and their rounds */
  more: { groups: number; rounds: number };
}

const labelOf = (r: SpawnRow) => [r.position, r.place].filter(Boolean).join(", ") || r.spawn;

/**
 * Groups spawn rows by side, place and position and sums their rounds. A group's role comes from its
 * rows' blends, each weighted by its rounds; a row without a blend adds rounds but no weight. Groups
 * sort by rounds, then T before CT, then label.
 */
export function groupSpawns(rows: (SpawnRow & { blend: RoleBlend })[]): SpawnSummary {
  const groups = new Map<string, { side: "T" | "CT"; label: string; rounds: number; weight: number; mix: Map<string, number> }>();
  for (const r of rows) {
    const label = labelOf(r);
    const key = `${r.side}|${label}`;
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { side: r.side, label, rounds: 0, weight: 0, mix: new Map() }));
    g.rounds += r.rounds;
    if (!r.blend.blend) continue;
    g.weight += r.rounds;
    // an unknown share (roles-v2's AWPer without a recorded loadout) is null: it adds no weight to its role
    for (const [role, share] of Object.entries(r.blend.blend)) if (share !== null) g.mix.set(role, (g.mix.get(role) ?? 0) + r.rounds * share);
  }
  const all: SpawnGroup[] = [...groups.values()].map((g) => {
    const top = g.weight > 0 ? [...g.mix].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0] : undefined;
    return { side: g.side, label: g.label, rounds: g.rounds, role: top ? top[0] : null, fit: top ? top[1] / g.weight : null };
  });
  all.sort((a, b) => b.rounds - a.rounds || (a.side === b.side ? 0 : a.side === "T" ? -1 : 1) || a.label.localeCompare(b.label));
  const shown = all.filter((g) => g.rounds >= SPAWN_MIN_ROUNDS).slice(0, SPAWN_TOP);
  const rest = all.filter((g) => !shown.includes(g));
  return { shown, more: { groups: rest.length, rounds: rest.reduce((t, g) => t + g.rounds, 0) } };
}
