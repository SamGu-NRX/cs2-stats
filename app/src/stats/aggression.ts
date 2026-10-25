// Aggression: how early a player meets the enemy, how far forward they go, and whether they buy when
// their team saves. Distance from teammates is positioning.ts's (ADNT). All identity metrics. Breakdowns by side
// and round type come from rollup's filters (side, ownBuy, oppBuy), so every fact is per player-round.
import type { Ctx } from "./derive";
import { ECO_BELOW_PER_PLAYER } from "./economy";
import type { Metric } from "./metrics";
import { engagementRows, exposures, openingEnd, PEEK_MIN_SPEED, tracks } from "./movement";

export interface AggroFact {
  ri: number;
  pi: number;
  /** visibility was measured this round (v1 map, visibility_status ok, freeze end known) */
  vis: boolean;
  /** seconds from freeze end to the player's first contact; null when there was none or vis is false */
  contactS: number | null;
  /** 1 + teammates whose first contact came strictly earlier */
  contactRank: number | null;
  /** the team's first contact (rank 1), as the attacker, made while moving at PEEK_MIN_SPEED or more */
  entry: boolean;
  /** furthest progress toward the enemy spawn in the opening phase: 0 at own spawn, 1 at the enemy's */
  push: number | null;
  /** the team's buy class is eco or half */
  lowBuy: boolean;
  /** the player spent ECO_BELOW_PER_PLAYER or more by freeze end; null when the spend is unknown */
  bought: boolean | null;
  /** the player's enemy kills this round (scoreboard.ts), for kills on low-buy rounds */
  kills: number;
}

export interface AggroAgg {
  visRounds: number; contactRounds: number; contactSecs: number; rankSum: number; entries: number;
  pushRounds: number; pushSum: number; lowBuyRounds: number; lowBuyBuys: number;
  /**
   * Rounds where your team was on an eco or half buy: all of them and your kills in them; those with
   * visibility measured, and of those the rounds where you made contact (took a fight).
   */
  lowPlayed: number; lowKills: number; lowVis: number; lowFights: number;
}

export const emptyAggro = (): AggroAgg => ({
  visRounds: 0, contactRounds: 0, contactSecs: 0, rankSum: 0, entries: 0, pushRounds: 0, pushSum: 0, lowBuyRounds: 0, lowBuyBuys: 0,
  lowPlayed: 0, lowKills: 0, lowVis: 0, lowFights: 0,
});

export function foldAggro(a: AggroAgg, f: AggroFact): void {
  if (f.vis) a.visRounds++;
  if (f.contactS !== null) { a.contactRounds++; a.contactSecs += f.contactS; a.rankSum += f.contactRank!; }
  if (f.entry) a.entries++;
  if (f.push !== null) { a.pushRounds++; a.pushSum += f.push; }
  if (f.lowBuy && f.bought !== null) { a.lowBuyRounds++; if (f.bought) a.lowBuyBuys++; }
  if (f.lowBuy) {
    a.lowPlayed++; a.lowKills += f.kills;
    if (f.vis) { a.lowVis++; if (f.contactS !== null) a.lowFights++; }
  }
}

/**
 * Each player's first contact per round: the earliest engagement tick, as attacker or victim, with
 * mesh line of sight not blocked by smoke, or with the attacker's first hit. Key ri * 1024 + pi;
 * the value is the tick, the player's 2D speed then (null when unknown), and whether they were the
 * engagement's attacker.
 */
type Contact = { tick: number; speed: number | null; attacker: boolean };
function firstContacts(c: Ctx): Map<number, Contact> {
  const out = new Map<number, Contact>();
  const G = c.t.engagements, E = c.t.engagement_ticks;
  if (!G || !E) return out;
  const spans = engagementRows(c);
  const note = (ri: number, pi: number | undefined, tick: number, vx: number | null, vy: number | null, attacker: boolean) => {
    if (pi === undefined) return;
    const key = ri * 1024 + pi;
    const cur = out.get(key);
    if (!cur || tick < cur.tick) out.set(key, { tick, speed: vx === null || vy === null ? null : Math.hypot(vx, vy), attacker });
  };
  for (let g = 0; g < G.n; g++) {
    const span = spans.get(G.engagement_id[g]);
    if (!span) continue;
    const seen = exposures(c, span[0], span[1])[0]?.on ?? Infinity;
    const hit = G.first_damage_tick[g];
    let row = seen;
    if (hit !== null && (row === Infinity || hit < E.tick[row])) {
      row = span[0];
      while (row + 1 < span[1] && E.tick[row] < hit) row++;
    }
    if (row === Infinity) continue;
    const ri = c.riOf(G.round[g]);
    if (ri === undefined) continue;
    note(ri, c.pi.get(G.attacker_steamid[g]), E.tick[row], E.a_vel_x[row], E.a_vel_y[row], true);
    note(ri, c.pi.get(G.victim_steamid[g]), E.tick[row], E.v_vel_x[row], E.v_vel_y[row], false);
  }
  return out;
}

export function deriveAggro(c: Ctx): AggroFact[] {
  const visOk = c.t.engagements !== null && c.t.engagement_ticks !== null && c.t.match.visibility_status[0] === "ok";
  const contact = visOk ? firstContacts(c) : new Map<number, Contact>();
  const P = c.t.positions;
  const tr = tracks(c);

  const out: AggroFact[] = [];
  for (let ri = 0; ri < c.nRounds; ri++) {
    const fe = c.rounds[ri].freezeEndTick;
    const rows = c.pr[ri];

    // each side's spawn: the mean position of its players at their first living sample from freeze end
    const spawn: Record<string, [number, number] | null> = { CT: null, T: null };
    if (P && fe !== null) for (const side of ["CT", "T"] as const) {
      let sx = 0, sy = 0, n = 0;
      for (const p of rows) {
        if (p?.side !== side) continue;
        const i = tr.get(ri * 1024 + p.pi)?.find((r) => P.tick[r] >= fe && P.is_alive[r]);
        if (i === undefined) continue;
        sx += P.x[i]; sy += P.y[i]; n++;
      }
      if (n) spawn[side] = [sx / n, sy / n];
    }

    for (const p of rows) {
      if (!p) continue;
      const vis = visOk && fe !== null;
      const own = contact.get(ri * 1024 + p.pi);
      let contactS: number | null = null, contactRank: number | null = null, entry = false;
      if (vis && own) {
        contactS = (own.tick - fe!) / c.tickRate;
        contactRank = 1 + rows.filter((q) => q && q.side === p.side && q.pi !== p.pi && (contact.get(ri * 1024 + q.pi)?.tick ?? Infinity) < own.tick).length;
        entry = contactRank === 1 && own.attacker && own.speed !== null && own.speed >= PEEK_MIN_SPEED;
      }

      let push: number | null = null;
      const from = spawn[p.side], to = spawn[p.side === "CT" ? "T" : "CT"];
      const track = tr.get(ri * 1024 + p.pi);
      const dx = to && from ? to[0] - from[0] : 0, dy = to && from ? to[1] - from[1] : 0, d2 = dx * dx + dy * dy;
      // with both spawn means on one point there is no direction to push along
      if (P && fe !== null && from && to && track && d2 > 0) {
        const end = openingEnd(c, ri, p.pi);
        for (const i of track) {
          if (!P.is_alive[i] || P.tick[i] < fe || P.tick[i] > end) continue;
          const prog = ((P.x[i] - from[0]) * dx + (P.y[i] - from[1]) * dy) / d2;
          push = push === null ? prog : Math.max(push, prog);
        }
      }

      const lowBuy = p.ownBuy === "eco" || p.ownBuy === "half";
      out.push({ ri, pi: p.pi, vis, contactS, contactRank, entry, push, lowBuy, bought: p.spent === null ? null : p.spent >= ECO_BELOW_PER_PLAYER, kills: p.m.kills });
    }
  }
  return out;
}

const per = (a: number, b: number) => (b > 0 ? a / b : null);
const pct = (a: number, b: number) => (b > 0 ? (100 * a) / b : null);
const CONTACT = "Contact is the first engagement tick with mesh line of sight not blocked by smoke between you and an enemy, or a hit between you, from engagement_ticks (v1 maps with visibility).";

export const AGGRESSION_METRICS: Metric[] = [
  { id: "firstContactTime", label: "First contact time", kind: "identity", group: "aggression", unit: "secs", status: "approx",
    def: `Mean seconds from freeze end to your first contact with an enemy, over rounds with contact. ${CONTACT}`,
    value: (s) => per(s.aggression.contactSecs, s.aggression.contactRounds) },
  { id: "firstContactRank", label: "First contact rank in team", kind: "identity", group: "aggression", unit: "rank", status: "approx",
    def: `Your place (1 = first) among teammates in making first contact, averaged over rounds where you made contact. Teammates who never made contact are not ranked. ${CONTACT}`,
    value: (s) => per(s.aggression.rankSum, s.aggression.contactRounds) },
  { id: "entryAttempts", label: "Entry attempts", kind: "identity", group: "aggression", unit: "pct", status: "approx",
    def: `Rounds where you made your team's first contact as the attacker, moving at ${PEEK_MIN_SPEED} u/s or more, whether or not it produced the opening kill. ${CONTACT}`,
    value: (s) => pct(s.aggression.entries, s.aggression.visRounds) },
  { id: "pushDepth", label: "Push depth", kind: "identity", group: "aggression", unit: "pct", status: "approx",
    def: "Your furthest point toward the enemy spawn before the round's first kill or your death, as a share of the straight line between the two spawns (0% your spawn, 100% theirs). Each spawn is the mean position of that side's players at freeze end; 4 Hz positions.",
    value: (s) => pct(s.aggression.pushSum, s.aggression.pushRounds) },
  { id: "lowBuyBuys", label: "Buys on team saves", kind: "identity", group: "aggression", unit: "pct", status: "exact",
    def: `Rounds where your team was on an eco or half buy (economy.ts) and you had spent $${ECO_BELOW_PER_PLAYER.toLocaleString("en-US")} or more by freeze end, as a share of your team's eco and half-buy rounds where your spend is known.`,
    value: (s) => pct(s.aggression.lowBuyBuys, s.aggression.lowBuyRounds) },
];
