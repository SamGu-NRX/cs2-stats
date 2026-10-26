export interface RoleSplitRow {
  steamid: string;
  team_clan_name: string;
}

export function assertUniqueSteamids(rows: readonly RoleSplitRow[]): void {
  for (const row of rows) {
    if (!row.steamid?.trim()) throw new Error("role validation requires a nonempty steamid");
    if (!row.team_clan_name?.trim()) throw new Error(`Missing team for steamid ${row.steamid}`);
  }
  if (rows.length !== new Set(rows.map((row) => row.steamid)).size) throw new Error("role validation requires one row per steamid");
}

function rng(seed: number) {
  return () => {
    seed |= 0;
    seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

function shuffle<T>(items: readonly T[], seed: number): T[] {
  const out = [...items], random = rng(seed);
  for (let i = out.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [out[i], out[j]] = [out[j], out[i]]; }
  return out;
}

export function seededStratifiedSplit<T extends RoleSplitRow>(data: readonly T[], labelOf: (row: T) => string | null, seed: number): { train: T[]; holdout: T[] } {
  assertUniqueSteamids(data);
  const groups = new Map<string, T[]>();
  for (const row of data) { const label = labelOf(row); if (label) (groups.get(label) ?? groups.set(label, []).get(label)!).push(row); }
  const holdout: T[] = [];
  let offset = 0;
  for (const group of groups.values()) {
    const shuffled = shuffle(group, seed + offset++ * 101);
    const n = shuffled.length > 1 ? Math.max(1, Math.floor(shuffled.length * 0.2)) : 0;
    holdout.push(...shuffled.slice(0, n));
  }
  const holdIds = new Set(holdout.map((row) => row.steamid));
  return { train: data.filter((row) => !holdIds.has(row.steamid)), holdout: data.filter((row) => holdIds.has(row.steamid)) };
}

export function teamGroupedSplit<T extends RoleSplitRow>(data: readonly T[], labelOf: (row: T) => string | null, seed: number): { train: T[]; holdout: T[] } {
  assertUniqueSteamids(data);
  const teams = new Map<string, T[]>();
  for (const row of data) (teams.get(row.team_clan_name) ?? teams.set(row.team_clan_name, []).get(row.team_clan_name)!).push(row);
  const ordered = shuffle([...teams.entries()], seed);
  const holdoutTeams = new Set<string>();
  let held = 0;
  for (const [team, teamRows] of ordered) if (held < data.length * 0.2) { holdoutTeams.add(team); held += teamRows.length; }
  const labels = [...new Set(data.map(labelOf).filter((label): label is string => label !== null))];
  const hasAllTrainLabels = () => labels.every((label) => data.some((row) => !holdoutTeams.has(row.team_clan_name) && labelOf(row) === label));
  for (const team of [...holdoutTeams]) if (!hasAllTrainLabels()) holdoutTeams.delete(team);
  return { train: data.filter((row) => !holdoutTeams.has(row.team_clan_name)), holdout: data.filter((row) => holdoutTeams.has(row.team_clan_name)) };
}
