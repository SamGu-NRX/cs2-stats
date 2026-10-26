// The blinds table as every module reads it: each blind row linked to the flashbang detonation that
// caused it, then repeated rows of one blind deduplicated. The utility measures (utility.ts), swing's
// flash share (swing.ts), head to head (matchviews.ts) and the flash tool (flashes.ts) all count these
// windows, so a duplicated row cannot count once in one view and twice in another, and two flashbangs
// that share an entity id are never taken for one.
import type { MatchTables } from "./tables";

/** One flashbang detonation (grenade_events flash_detonate); `key` names it among the match's. */
export interface Detonation { key: string; round: number; tick: number; by: string | null; entity: number | null; x: number | null; y: number | null }

/** One blind: from `tick` for `secs` seconds. */
export interface BlindWindow {
  round: number;
  tick: number;
  secs: number;
  attacker: string | null;
  victim: string;
  /** the flashbang's entity id (blinds.flash_entity_id); null when the row names none */
  entity: number | null;
  /** the detonation this blind is linked to (Detonation.key); null when none links */
  det: string | null;
  self: boolean;
  team: boolean;
  /** two flashes detonated on the tick and the nearer was credited (any joined row said so) */
  ambiguous: boolean;
}

const DETONATE = "flash_detonate";
const detCache = new WeakMap<MatchTables, Detonation[]>();
const cache = new WeakMap<MatchTables, Map<number, BlindWindow[]>>();

/**
 * Every flashbang detonation of the match, every player's, in row order. A row repeating one (same
 * round, thrower, entity id and tick) is the same detonation recorded twice and is left out; the same
 * entity id at another tick is another flashbang, as the game reuses entity ids.
 */
export function flashDetonations(t: MatchTables): Detonation[] {
  const hit = detCache.get(t);
  if (hit) return hit;
  const ev = t.grenade_events;
  const out: Detonation[] = [];
  const seen = new Set<string>();
  if (ev) for (let i = 0; i < ev.n; i++) {
    if (ev.event[i] !== DETONATE) continue;
    const key = `${ev.round[i]}|${ev.steamid[i]}|${ev.entity_id[i]}|${ev.tick[i]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ key, round: ev.round[i], tick: ev.tick[i], by: ev.steamid[i], entity: ev.entity_id[i], x: ev.x[i], y: ev.y[i] });
  }
  detCache.set(t, out);
  return out;
}

/**
 * The match's blinds by round number, in tick order. Each row is first linked to a detonation its
 * flash_entity_id names in the same round: its recorded attacker's latest one at or before the row,
 * or with no attacker recorded, the latest by anyone. Rows linked to the same detonation and victim
 * are one blind, from the earliest start to the latest end (the blind recorded twice, or in two
 * parts). A row that links to nothing joins only an exact duplicate (same round, attacker, victim,
 * entity id, tick and duration): with no detonation to say which flashbang it was, overlapping rows
 * may be two.
 */
export function blindWindows(t: MatchTables): Map<number, BlindWindow[]> {
  const hit = cache.get(t);
  if (hit) return hit;
  const B = t.blinds;
  const tr = t.match.tick_rate[0];
  const byEntity = new Map<string, Detonation[]>();
  for (const d of flashDetonations(t)) {
    if (d.entity === null) continue;
    const k = `${d.round}|${d.entity}`;
    const l = byEntity.get(k);
    if (l) l.push(d); else byEntity.set(k, [d]);
  }
  const link = (round: number, entity: number | null, tick: number, by: string | null): Detonation | null => {
    if (entity === null) return null;
    let best: Detonation | null = null;
    for (const d of byEntity.get(`${round}|${entity}`) ?? []) if (d.tick <= tick && (by === null || d.by === by) && (!best || d.tick > best.tick)) best = d;
    return best;
  };

  const joined = new Map<string, BlindWindow>();
  for (let i = 0; i < B.n; i++) {
    const w: BlindWindow = {
      round: B.round[i], tick: B.tick[i], secs: B.duration[i], attacker: B.attacker_steamid[i], victim: B.victim_steamid[i],
      entity: B.flash_entity_id[i], det: null, self: B.is_self[i], team: B.is_team_flash[i], ambiguous: B.ambiguous[i],
    };
    w.det = link(w.round, w.entity, w.tick, w.attacker)?.key ?? null;
    const key = w.det !== null ? `det|${w.det}|${w.victim}` : `row|${w.round}|${w.attacker}|${w.victim}|${w.entity}|${w.tick}|${w.secs}`;
    const cur = joined.get(key);
    if (!cur) { joined.set(key, w); continue; }
    const from = Math.min(cur.tick, w.tick);
    const until = Math.max(cur.tick + cur.secs * tr, w.tick + w.secs * tr);
    joined.set(key, { ...cur, tick: from, secs: (until - from) / tr, ambiguous: cur.ambiguous || w.ambiguous });
  }
  const out = new Map<number, BlindWindow[]>();
  for (const w of joined.values()) {
    const l = out.get(w.round);
    if (l) l.push(w); else out.set(w.round, [w]);
  }
  for (const l of out.values()) l.sort((a, b) => a.tick - b.tick);
  cache.set(t, out);
  return out;
}
