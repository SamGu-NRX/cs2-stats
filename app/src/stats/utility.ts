// Utility usage: grenades thrown, flashes, grenade damage, and grenades a player died holding.
// Flash definitions are Leetify's (research-data-sources.md): an enemy counts as flashed at more than
// 1.1 s of blind, and a flash-to-kill is a flashed enemy dying to the team while still blind.
import { enemyHit, hitDamage, type Ctx } from "./derive";
import { classFromDisplay, isUtility, PRICE } from "./weapons";

/** Leetify: blind longer than this counts as flashed. */
export const FLASHED_MIN_S = 1.1;

const THROWN: Record<string, "smokes" | "flashes" | "hes" | "molotovs" | "decoys"> = {
  smokegrenade: "smokes", flashbang: "flashes", hegrenade: "hes", molotov: "molotovs", incgrenade: "molotovs", decoy: "decoys",
};
const FIRE = new Set(["inferno", "molotov", "incgrenade"]);

export function utility(c: Ctx): void {
  const g = c.t.grenade_throws;
  const b = c.t.blinds;
  const d = c.t.damages;
  const inv = c.t.player_rounds;
  const held = new Map<number, string[]>();
  for (let i = 0; i < inv.n; i++) held.set((inv.round[i] - 1) * 1024 + c.pi.get(inv.steamid[i])!, inv.inventory[i].map(classFromDisplay).filter((x) => x in THROWN));

  for (let ri = 0; ri < c.nRounds; ri++) {
    const rows = c.pr[ri];
    const row = (id: string | null) => { const p = c.idOf(id); return p === null ? null : rows[p]; };
    const throws: [number, number, string][] = []; // [player, tick, class]
    if (g) for (const i of c.byRound("grenade_throws")[ri]) {
      const p = row(g.steamid[i]);
      const kind = THROWN[g.weapon[i]];
      if (!p || !kind) continue;
      p.m[kind]++;
      throws.push([p.pi, g.tick[i], g.weapon[i]]);
    }

    const effective = new Set<string>();
    for (const i of c.byRound("blinds")[ri]) {
      const p = row(b.attacker_steamid[i]);
      if (!p || b.duration[i] <= FLASHED_MIN_S) continue;
      const v = c.pi.get(b.victim_steamid[i])!;
      if (b.is_self[i]) { p.m.selfFlashed++; continue; }
      if (b.is_team_flash[i]) { p.m.teamFlashed++; p.m.teamBlindSecs += b.duration[i]; continue; }
      p.m.enemiesFlashed++;
      p.m.enemyBlindSecs += b.duration[i];
      effective.add(`${p.pi}:${b.flash_entity_id[i] ?? b.tick[i]}`);
      const until = b.tick[i] + b.duration[i] * c.tickRate;
      if (c.kills[ri].some((k) => k.enemy && k.victim === v && k.killerSide === p.side && k.tick >= b.tick[i] && k.tick <= until)) p.m.flashKills++;
    }
    for (const key of effective) rows[+key.split(":")[0]]!.m.effectiveFlashes++;

    const heHit = new Set<string>();
    for (const i of c.byRound("damages")[ri]) {
      const w = d.weapon[i] ?? "";
      if (!isUtility(w) || !enemyHit(c.t, i)) continue;
      const a = row(d.attacker_steamid[i]);
      const v = row(d.victim_steamid[i]);
      const x = hitDamage(c.t, i);
      if (v) v.m.utilDmgTaken += x;
      if (!a) continue;
      a.m.utilDmg += x;
      if (w === "hegrenade") { a.m.heDmg += x; heHit.add(`${a.pi}:${d.grenade_entity_id[i] ?? d.tick[i]}:${d.victim_steamid[i]}`); }
      if (FIRE.has(w)) a.m.fireDmg += x;
    }
    for (const key of heHit) rows[+key.split(":")[0]]!.m.heHits++;

    for (const k of c.kills[ri]) if (k.enemy && isUtility(k.weapon)) rows[k.killer!]!.m.utilKills++;

    // grenades held: the freeze-end inventory, less those thrown before death
    for (const p of rows) {
      if (!p) continue;
      const items = held.get(ri * 1024 + p.pi) ?? [];
      p.m.utilBought += items.reduce((s, x) => s + PRICE[x], 0);
      const death = c.kills[ri].find((k) => k.victim === p.pi);
      if (!death) continue;
      const left = [...items];
      for (const [pl, tick, cls] of throws) {
        if (pl !== p.pi || tick > death.tick) continue;
        const j = left.indexOf(cls);
        if (j >= 0) left.splice(j, 1);
      }
      p.m.utilUnused += left.reduce((s, x) => s + PRICE[x], 0);
    }
  }
}
