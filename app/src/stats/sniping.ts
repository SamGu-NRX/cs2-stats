// Sniping: kills with sniper rifles, and rounds the player carried one. HLTV's Sniping attribute shows
// rounds with a sniper, sniper kills %, rounds with an AWP and AWP kills %; "carried" is read from the
// freeze-end inventory, or a sniper kill that round (a rifle picked up later).
import type { Ctx } from "./derive";
import { isSniper } from "./weapons";

const SNIPER_DISPLAY = new Set(["AWP", "SSG 08", "SCAR-20", "G3SG1"]);

export function sniping(c: Ctx): void {
  const inv = c.t.player_rounds;
  const carried = new Map<number, string[]>();
  for (let i = 0; i < inv.n; i++) carried.set((inv.round[i] - 1) * 1024 + c.pi.get(inv.steamid[i])!, inv.inventory[i]);
  for (let ri = 0; ri < c.nRounds; ri++) {
    for (const p of c.pr[ri]) {
      if (!p) continue;
      const m = p.m;
      const items = carried.get(ri * 1024 + p.pi) ?? [];
      let sniper = 0;
      let awp = false;
      for (const k of c.kills[ri]) {
        if (k.enemy && k.killer === p.pi && isSniper(k.weapon)) {
          sniper++;
          if (k.weapon === "awp") { m.awpKills++; awp = true; }
          if (k.opening) m.sniperOpeningKills++;
        }
        // an AWP duel: a kill with the AWP, or a death with the AWP in hand
        if (k.enemy && k.killer === p.pi && k.weapon === "awp") { m.awpDuels++; m.awpDuelWins++; }
        if (k.enemy && k.victim === p.pi && k.victimWeapon === "AWP") m.awpDuels++;
      }
      m.sniperKills += sniper;
      if (sniper > 0) m.sniperKillRounds = 1;
      if (sniper > 1) m.sniperMultiRounds = 1;
      if (sniper > 0 || items.some((x) => SNIPER_DISPLAY.has(x))) m.roundsWithSniper = 1;
      if (awp || items.includes("AWP")) m.roundsWithAwp = 1;
    }
  }
}
