// The blinds table as every module reads it: repeated rows of one blind joined into one window. The
// utility measures (utility.ts), swing's flash share (swing.ts), head to head (matchviews.ts) and the
// flash tool (flashes.ts) all count these windows, so a duplicated or overlapping row cannot count once
// in one view and twice in another.
import type { MatchTables } from "./tables";

/** One blind: from `tick` for `secs` seconds. */
export interface BlindWindow {
  round: number;
  tick: number;
  secs: number;
  attacker: string | null;
  victim: string;
  /** the flashbang's entity id (blinds.flash_entity_id); null when the row names none */
  entity: number | null;
  self: boolean;
  team: boolean;
  /** two flashes detonated on the tick and the nearer was credited (any joined row said so) */
  ambiguous: boolean;
}

const cache = new WeakMap<MatchTables, Map<number, BlindWindow[]>>();

/**
 * The match's blinds by round number, in tick order. Rows with the same round, attacker, victim and
 * flash entity id whose windows overlap or touch are one blind, from the earliest start to the latest
 * end: the same flash recorded twice, or its blind recorded in two parts. The same entity id at a
 * later time with a gap between is another flashbang (the game reuses entity ids). A row with no
 * entity id joins only a row at the same tick, as nothing else says it is the same flash.
 */
export function blindWindows(t: MatchTables): Map<number, BlindWindow[]> {
  const hit = cache.get(t);
  if (hit) return hit;
  const B = t.blinds;
  const tr = t.match.tick_rate[0];
  const rows: BlindWindow[] = [];
  for (let i = 0; i < B.n; i++) {
    rows.push({
      round: B.round[i], tick: B.tick[i], secs: B.duration[i], attacker: B.attacker_steamid[i], victim: B.victim_steamid[i],
      entity: B.flash_entity_id[i], self: B.is_self[i], team: B.is_team_flash[i], ambiguous: B.ambiguous[i],
    });
  }
  const key = (w: BlindWindow) => `${w.round}|${w.attacker}|${w.victim}|${w.entity}`;
  rows.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : a.tick - b.tick));
  const out = new Map<number, BlindWindow[]>();
  let cur: BlindWindow | null = null;
  const flush = () => {
    if (!cur) return;
    const l = out.get(cur.round);
    if (l) l.push(cur); else out.set(cur.round, [cur]);
  };
  for (const w of rows) {
    const end = (x: BlindWindow) => x.tick + x.secs * tr;
    const joins = cur !== null && key(cur) === key(w) && (w.entity === null ? w.tick === cur.tick : w.tick <= end(cur));
    if (joins) {
      const until = Math.max(end(cur!), end(w));
      cur = { ...cur!, secs: (until - cur!.tick) / tr, ambiguous: cur!.ambiguous || w.ambiguous };
      continue;
    }
    flush();
    cur = { ...w };
  }
  flush();
  for (const l of out.values()) l.sort((a, b) => a.tick - b.tick);
  cache.set(t, out);
  return out;
}
