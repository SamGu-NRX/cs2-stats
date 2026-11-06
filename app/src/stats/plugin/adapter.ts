// TRANSITIONAL: turns a capture-plugin match file (JSON, plugin/schema.ts) into schema v1 tables in
// memory, so the user's existing plugin recordings and converted logs reach the one derive path.
//
// Remove this folder (adapter.ts, schema.ts, decode.ts) and the samples it reads once local demo
// recording is proven (architecture.md, migration step 1: tv_autorecord on the local server, run
// through the extractor) and the user's matches arrive as demos. Nothing else reads plugin files.
//
// What the plugin files cannot provide stays null: inventories, health before a hit, smoke and fire
// lifetimes, engagements and radar spotting, and view angles in files before plugin 1.2.0 (1.2.0
// records each shot's pitch and yaw, which go to shots.pitch and shots.yaw). Rounds the file holds
// only as totals (converted logs before firstFullRound, and rounds the plugin marked partial) are left
// out, so every derived rate covers the rounds with a kill-by-kill log. The plugin's per-shot aim
// error, target and on-screen state go to the shots columns only plugin rows fill (tables.ts
// SOURCE_COLUMNS).
import { emptyTable, kindOf, SCHEMA, type MatchTables, type Side, type Table, type TableName } from "../tables";
import { bodyEntry, bodyLookup } from "./bodies";
import { roundResults, teamSides } from "./results";
import { KILL_FLAG as FLAG, type GrenadeType, type MatchFile, type Side as SideCode } from "./schema";

const SIDE: Record<number, Side> = { 2: "T", 3: "CT" };
const THROW_CLASS: Record<GrenadeType | "incgrenade", string> = {
  he: "hegrenade", flash: "flashbang", smoke: "smokegrenade", molotov: "molotov", incgrenade: "incgrenade", decoy: "decoy",
};
const DETONATE: Record<GrenadeType, string> = {
  he: "he_detonate", flash: "flash_detonate", smoke: "smoke_detonate", molotov: "inferno_start", decoy: "decoy_start",
};
const REASON = { elim: (w: Side) => (w === "CT" ? "t_killed" : "ct_killed"), defuse: () => "bomb_defused", bomb: () => "bomb_exploded", time: () => "time_ran_out" };

/** Appends a row; columns not given are null, and a non-nullable column not given is an error. */
function add<N extends TableName>(t: Table<N>, name: N, values: Record<string, unknown>): void {
  const cols = t as unknown as Record<string, unknown[]>;
  for (const c of Object.keys(SCHEMA[name])) {
    const v = values[c];
    if (v === undefined && !kindOf(name, c).endsWith("?") && kindOf(name, c) !== "ss") throw new Error(`plugin adapter: ${name}.${c} has no value`);
    cols[c].push(v === undefined ? (kindOf(name, c) === "ss" ? [] : null) : v);
  }
  t.n++;
}

/** Weapons whose damage comes from a thrown grenade or its fire, so the body that dealt it is the one that threw it. */
const GRENADE_DAMAGE = new Set(["hegrenade", "inferno", "molotov", "incgrenade", "smokegrenade", "flashbang", "decoy"]);

/** Source engine hit group numbers, named as the demo parser names them. */
const HITGROUP: Record<number, string> = { 1: "head", 2: "chest", 3: "stomach", 4: "left_arm", 5: "right_arm", 6: "left_leg", 7: "right_leg", 8: "neck" };

/** Rounds won over every round of the file, [team that started CT, team that started T]; the facts cover only some rounds. */
function finalScore(m: MatchFile, winSide: (SideCode | null)[]): [number, number] {
  const humanStart = SIDE[m.players.startSide[m.human] ?? -1];
  const out: [number, number] = [0, 0];
  winSide.forEach((w, ri) => {
    const win = SIDE[w ?? -1];
    // the human's team's side, through a teammate when he has none that round (results.ts teamSides)
    const human = SIDE[teamSides(m, [ri])?.[0] ?? -1];
    if (!win || !human) return;
    const humanWon = win === human;
    // index 0 is the team that started CT
    out[(humanStart === "CT") === humanWon ? 0 : 1]++;
  });
  return out;
}

/** Which record targetOnScreen reads: MatchInfo.inputs.onScreen, from match.extra "on_screen". */
function onScreenSource(m: MatchFile): "los" | "spotted" | "spotted-los-lost" {
  if (m.env.visSource === "mixed") return "spotted-los-lost";
  return m.env.visSource === "los" && m.aim.los?.ri.length ? "los" : "spotted";
}

/**
 * Whether each shot's target was on screen, by shots row. Line-of-sight files (env.visSource "los",
 * plugin 1.1.0) read aim.los: the target's state at a tick is that of its last transition at or before
 * the tick, hidden before any. Plugin PR #21 stamps the hidden transition for a death at the death tick
 * + 1, so a read at the kill tick sees the victim; older files stamp it at the death tick, so a hidden
 * row at the target's or the human's death tick is read from the next tick and both give one answer.
 * Other files read visTarget (the spotted mask); files before visTarget named only a visible enemy as
 * the target (SCHEMA.md, aim.shots). A "mixed" file lost line of sight partway (env.losError) and reads
 * the mask for the whole match: the file does not say exactly when the trace stopped answering, so no
 * cutoff is guessed. MatchInfo.inputs.onScreen records which was used (facts.ts ON_SCREEN_NOTE).
 */
function targetOnScreen(m: MatchFile): (i: number) => boolean {
  const s = m.aim.shots;
  const los = m.aim.los;
  const visTarget = s.visTarget;
  const mask = visTarget ? (i: number) => visTarget[i] === 1 : (i: number) => s.target[i] !== null;
  if (los && los.ri.length && m.env.visSource === "los") {
    const at = (ri: number, pi: number) => ri * 256 + pi;
    const death = new Map<number, number>();
    m.kills.ri.forEach((ri, k) => death.set(at(ri, m.kills.victim[k]), m.kills.tick[k]));
    const rows = new Map<number, [number, boolean][]>();
    los.ri.forEach((ri, r) => {
      const enemy = los.enemy[r];
      const t = los.tick[r];
      const tick = los.vis[r] === 0 && (death.get(at(ri, enemy)) === t || death.get(at(ri, m.human)) === t) ? t + 1 : t;
      const l = rows.get(at(ri, enemy));
      if (l) l.push([tick, los.vis[r] === 1]); else rows.set(at(ri, enemy), [[tick, los.vis[r] === 1]]);
    });
    for (const l of rows.values()) l.sort((a, b) => a[0] - b[0]);
    return (i) => {
      const target = s.target[i];
      if (target === null) return false;
      let vis = false;
      for (const [tick, v] of rows.get(at(s.ri[i], target)) ?? []) {
        if (tick > s.tick[i]) break;
        vis = v;
      }
      return vis;
    };
  }
  return mask;
}


/** An angle from the plugin, null when missing or not a number (files before plugin 1.2.0). */
const angle = (x: number | null | undefined) => (typeof x === "number" && Number.isFinite(x) ? x : null);

export function pluginToTables(m: MatchFile): MatchTables {
  const key = m.players.key;
  const human = key[m.human];
  const humanTeam = `Team ${m.players.name[m.human]}`;
  const sideOf = (ri: number, pi: number | null): Side | null => (pi === null ? null : SIDE[m.rounds.side[ri]?.[pi] ?? -1] ?? null);
  const humanStart = SIDE[m.players.startSide[m.human] ?? -1];
  // A player who never had a side is on no team. null is no side, not one two players share: compared as
  // a side it put such a player on the opponents' team beside a recording player who had one.
  const teamOf = (pi: number) => {
    const start = m.players.startSide[pi];
    if (start === null) return null;
    return start === m.players.startSide[m.human] ? humanTeam : "Opponents";
  };
  const partial = new Set(m.recon?.partial ?? []);
  const covered = (ri: number) => ri >= m.firstFullRound && !partial.has(ri) && ri < m.rounds.winSide.length;
  const weapon = (i: number) => m.weapons[i] ?? "unknown";
  const ticks = (ri: number) => {
    const fe = m.rounds.freezeTick[ri];
    const dur = m.rounds.durTicks[ri];
    return { fe, end: fe !== null && dur !== null ? fe + dur : null };
  };
  // winners the file leaves null (overtime, unknown result codes), rebuilt from the scores
  const results = roundResults(m);
  // Rows made in a bot's body (takeover) belong to the bot, as actor and as victim; bodies.ts says what
  // happens to a row whose player is in no known body (null below). A grenade's rows ask for its
  // thrower's body when it was thrown: grenades.throw links a detonation to its throw, damage.nade and
  // blinds.flash link a hit or a blind to the detonation. Against the game's round stats on 41 recorded
  // files, grenade damage credited by the throw tick agrees on 4701 of 4718 player-rounds and by the
  // hit tick on 4698 (pnpm takeover-check).
  const bodyAt = bodyLookup(m);
  /** `g` when it names a grenades row of round ri thrown by pi, else null: a bad link counts as none. */
  const grenadeOf = (g: number | null | undefined, ri: number, pi: number | null) =>
    g !== null && g !== undefined && Number.isInteger(g) && g >= 0 && g < m.grenades.ri.length && m.grenades.ri[g] === ri && m.grenades.thrower[g] === pi ? g : null;
  /** The throws row grenades row g came from, when its link is in range and names the same round and thrower. */
  const throwOf = (g: number) => {
    const j = m.grenades.throw?.[g];
    const th = m.throws;
    return th && j !== null && j !== undefined && Number.isInteger(j) && j >= 0 && j < th.ri.length && th.ri[j] === m.grenades.ri[g] && th.thrower[j] === m.grenades.thrower[g] ? j : null;
  };
  /**
   * The body a grenade's thrower was in when it was thrown. Without a valid throw link, the detonation
   * tick (or, with no valid grenade either, the row's own tick) stands in, and only a body the file has
   * observed by then counts. Files before plugin 1.0.0 have no throw log and land here.
   */
  const throwerBody = (pi: number, ri: number, g: number | null, tick: number) => {
    const j = g === null ? null : throwOf(g);
    return j !== null ? bodyAt(pi, ri, m.throws!.tick[j]) : bodyAt(pi, ri, g === null ? tick : m.grenades.tick[g], { observed: true });
  };
  /** The victim of a row: its body, else the player itself (bodies.ts). */
  const victimOf = (pi: number, ri: number, tick: number) => bodyAt(pi, ri, tick) ?? pi;
  // Shots exist only for the recording player; these rows become the shots table, in this order. Shots
  // he fired in a bot's body are left out: they are the bot's, and bots have no shot rows, so the bot's
  // aim would rest on a takeover's bullets alone.
  const shotRows = m.aim.shots.ri.flatMap((ri, i) => (covered(ri) && bodyAt(m.human, ri, m.aim.shots.tick[i]) === m.human ? [i] : []));

  const t: MatchTables = {
    match: emptyTable("match"), players: emptyTable("players"), rounds: emptyTable("rounds"), player_rounds: emptyTable("player_rounds"),
    kills: emptyTable("kills"), damages: emptyTable("damages"), blinds: emptyTable("blinds"), bomb: emptyTable("bomb"),
    grenade_throws: emptyTable("grenade_throws"), grenade_events: emptyTable("grenade_events"), smokes: emptyTable("smokes"),
    infernos: emptyTable("infernos"), shots: emptyTable("shots"), positions: emptyTable("positions"),
    spotted: null, engagements: null, engagement_ticks: null, purchases: null, leaves: null,
  };

  add(t.match, "match", {
    match_id: m.id, source: "local", map: m.map, tick_rate: m.env.tickrate || 64,
    team_ct_start: humanStart === "CT" ? humanTeam : "Opponents", team_t_start: humanStart === "T" ? humanTeam : "Opponents",
    schema_version: 1, extractor_version: `plugin ${m.env.plugin} via plugin/adapter.ts`,
    convars: JSON.stringify({ mp_maxrounds: m.env.maxrounds ?? 24 }),
    extra: JSON.stringify({
      date: m.startUtc.slice(0, 10), started_at: m.startUtc, duration_s: (Date.parse(m.endUtc) - Date.parse(m.startUtc)) / 1000,
      pov: human, rounds_played: m.rounds.winSide.length, status: m.status, final_score: finalScore(m, results.winSide),
      // files before plugin 1.0.0 have no throw log; throws are rebuilt from detonations (facts.ts SourceInputs.throws)
      ...(m.throws ? {} : { throws: "rebuilt" }),
      on_screen: onScreenSource(m),
      // rounds the file holds only as totals, left out of the tables (MatchInfo.totalsOnly)
      totals_only_rounds: m.rounds.winSide.flatMap((_, ri) => (covered(ri) ? [] : [ri + 1])),
      // their per-player totals from the game's round stats (MatchFacts.totalsRounds)
      totals_rounds: results.winSide.flatMap((w, ri) => {
        const basic = m.rounds.basic?.[ri];
        if (covered(ri) || !basic) return [];
        const players = key.flatMap((id, pi) => (basic[pi] ? [[id, ...basic[pi]!]] : []));
        return [{ round: ri + 1, winner: SIDE[w ?? -1] ?? null, players }];
      }),
    }), visibility_status: "no_mapdata",
  });
  key.forEach((id, pi) => add(t.players, "players", { steamid: id, name: m.players.name[pi], team: teamOf(pi), is_bot: m.players.isBot[pi] }));

  for (let ri = 0; ri < m.rounds.winSide.length; ri++) {
    if (!covered(ri)) continue;
    const { fe, end } = ticks(ri);
    if (fe === null || end === null) continue;
    const win = SIDE[results.winSide[ri] ?? -1] ?? null;
    const how = results.how[ri];
    const ctIsHuman = sideOf(ri, m.human) === "CT";
    const plantTick = m.rounds.plantTick[ri];
    const planterPi = m.rounds.planter[ri];
    const defuserPi = m.rounds.defuser[ri];
    const planter = planterPi === null || plantTick === null ? planterPi : bodyAt(planterPi, ri, plantTick);
    const defuser = defuserPi === null ? null : bodyAt(defuserPi, ri, end);
    add(t.rounds, "rounds", {
      round: ri + 1, start_tick: fe, freeze_end_tick: fe, end_tick: end, winner_side: win,
      reason: win && how ? REASON[how](win) : null, ct_team: ctIsHuman ? humanTeam : "Opponents", t_team: ctIsHuman ? "Opponents" : humanTeam,
      plant_tick: m.rounds.plantTick[ri], plant_site: m.rounds.bombSite[ri], planter_steamid: planter === null ? null : key[planter],
      defuse_tick: how === "defuse" ? end : null, defuser_steamid: defuser === null ? null : key[defuser],
      explode_tick: how === "bomb" ? end : null,
    });
    if (m.rounds.plantTick[ri] !== null) add(t.bomb, "bomb", { tick: m.rounds.plantTick[ri], round: ri + 1, event: "planted", steamid: planter === null ? null : key[planter], site: m.rounds.bombSite[ri] });
    if (how === "defuse") add(t.bomb, "bomb", { tick: end, round: ri + 1, event: "defused", steamid: defuser === null ? null : key[defuser] });
    if (how === "bomb") add(t.bomb, "bomb", { tick: end, round: ri + 1, event: "exploded" });
    key.forEach((id, pi) => {
      const side = sideOf(ri, pi);
      if (!side) return;
      const a0 = m.rounds.alive0?.[ri]?.[pi];
      add(t.player_rounds, "player_rounds", {
        round: ri + 1, steamid: id, side, money: m.rounds.money[ri][pi], equip_value_game: m.rounds.equip[ri][pi],
        alive_at_start: a0 === undefined || a0 === null ? null : a0 === 1,
      });
    });
  }

  const k = m.kills;
  for (let i = 0; i < k.ri.length; i++) {
    const ri = k.ri[i];
    if (!covered(ri) || k.flags[i] & FLAG.freeze) continue;
    // A kill or death in a bot's body (takeover) belongs to the bot, as in CS Demo Manager. kBody and
    // vBody record the body at the event and override the timeline; null in them means the player's
    // own body, and a kill whose killer the timeline puts in no body keeps its row with no attacker.
    // Where the optional column is absent or short, the timeline decides.
    const tick = k.tick[i];
    const named = k.killer[i];
    const kb = bodyEntry(k.kBody, i);
    const vb = bodyEntry(k.vBody, i);
    const killer = named === null ? null : kb === undefined ? bodyAt(named, ri, tick) : kb ?? (bodyAt(named, ri, tick) === null ? null : named);
    const victim = vb === undefined ? victimOf(k.victim[i], ri, tick) : vb ?? k.victim[i];
    // CS2 names one assister: the damage assister when there is one, else the flash assister. It stays
    // the controller the event names, the one exception to body credit: on 41 recorded files the game's
    // round stats agree with that on 4700 of 4718 player-rounds, against 4652 for the assister's body at
    // the kill and 4678 for its body at its last hit or flash on the victim (pnpm takeover-check).
    const assister = k.assister[i] ?? k.flashAssister[i];
    const kp = k.kpos[i];
    const vp = k.vpos[i];
    const ks = sideOf(ri, killer);
    const vs = sideOf(ri, victim);
    const suicide = (k.flags[i] & FLAG.suicide) !== 0 || killer === victim;
    add(t.kills, "kills", {
      tick, round: ri + 1, attacker_steamid: killer === null ? null : key[killer], victim_steamid: key[victim],
      assister_steamid: assister === null ? null : key[assister], assistedflash: k.assister[i] === null && k.flashAssister[i] !== null,
      weapon: weapon(k.weapon[i]), headshot: (k.flags[i] & FLAG.headshot) !== 0, penetrated: k.flags[i] & FLAG.wallbang ? 1 : 0,
      thrusmoke: (k.flags[i] & FLAG.smoke) !== 0, attackerblind: (k.flags[i] & FLAG.blind) !== 0, noscope: (k.flags[i] & FLAG.noscope) !== 0,
      attackerinair: (k.flags[i] & FLAG.air) !== 0, distance: kp && vp ? Math.hypot(kp[0] - vp[0], kp[1] - vp[1], kp[2] - vp[2]) : null,
      a_side: ks, a_x: kp?.[0] ?? null, a_y: kp?.[1] ?? null, a_z: kp?.[2] ?? null,
      a_equip_value_game: killer === null ? null : m.rounds.equip[ri][killer],
      v_side: vs, v_x: vp?.[0] ?? null, v_y: vp?.[1] ?? null, v_z: vp?.[2] ?? null, v_equip_value_game: m.rounds.equip[ri][victim],
      is_suicide: suicide, is_teamkill: !suicide && killer !== null && ks !== null && ks === vs,
    });
  }

  const d = m.damage;
  for (let i = 0; i < d.ri.length; i++) {
    const ri = d.ri[i];
    if (!covered(ri)) continue;
    const nade = d.nade?.[i] ?? null;
    const by = d.attacker[i];
    // grenade or fire damage with no link to its grenade still asks for the body that threw it
    const thrown = nade !== null || GRENADE_DAMAGE.has(weapon(d.weapon[i]));
    const a = by === null ? null : thrown ? throwerBody(by, ri, grenadeOf(nade, ri, by), d.tick[i]) : bodyAt(by, ri, d.tick[i]);
    if (a === null && by !== null) continue;
    const v = victimOf(d.victim[i], ri, d.tick[i]);
    add(t.damages, "damages", {
      tick: d.tick[i], round: ri + 1, attacker_steamid: a === null ? null : key[a], victim_steamid: key[v], weapon: weapon(d.weapon[i]),
      // the plugin stores each hit's damage already capped at the victim's health
      dmg_health: d.dmg[i], dmg_health_capped: d.dmg[i], dmg_armor: d.dmgArmor[i], hitgroup: d.hitgroup[i] === null ? null : HITGROUP[d.hitgroup[i]!] ?? "generic",
      a_side: sideOf(ri, a), v_side: sideOf(ri, v), is_team_damage: a !== null && a !== v && sideOf(ri, a) === sideOf(ri, v),
      is_self: a === v, grenade_entity_id: nade,
    });
  }

  const b = m.blinds;
  for (let i = 0; i < b.ri.length; i++) {
    const ri = b.ri[i];
    if (!covered(ri)) continue;
    const flash = b.flash?.[i] ?? null;
    const by = b.attacker[i];
    // every blind comes from a flash, linked or not
    const a = by === null ? null : throwerBody(by, ri, grenadeOf(flash, ri, by), b.tick[i]);
    if (a === null && by !== null) continue;
    const v = victimOf(b.victim[i], ri, b.tick[i]);
    add(t.blinds, "blinds", {
      tick: b.tick[i], round: ri + 1, attacker_steamid: a === null ? null : key[a], victim_steamid: key[v], duration: b.ms[i] / 1000,
      flash_entity_id: flash, is_self: a === v, is_team_flash: a !== null && a !== v && sideOf(ri, a) === sideOf(ri, v), ambiguous: false,
    });
  }

  const g = m.grenades;
  for (let i = 0; i < g.ri.length; i++) {
    const ri = g.ri[i];
    if (!covered(ri)) continue;
    // kept when the thrower is in no known body, with no thrower: the utility was there either way
    const by = g.thrower[i];
    const body = by === null ? null : throwerBody(by, ri, i, g.tick[i]);
    const thrower = body === null ? null : key[body];
    const p = g.pos[i];
    add(t.grenade_events!, "grenade_events", { tick: g.tick[i], round: ri + 1, event: DETONATE[g.type[i]], entity_id: i, steamid: thrower, x: p?.[0] ?? null, y: p?.[1] ?? null, z: p?.[2] ?? null });
    if (p && (g.type[i] === "smoke" || g.type[i] === "molotov")) {
      add(g.type[i] === "smoke" ? t.smokes! : t.infernos!, g.type[i] === "smoke" ? "smokes" : "infernos", { entity_id: i, steamid: thrower, round: ri + 1, start_tick: g.tick[i], x: p[0], y: p[1], z: p[2] });
    }
  }
  // Throws: the plugin's throw log when present (1.0.0), else one throw per detonation.
  const th = m.throws ?? m.grenades;
  for (let i = 0; i < th.ri.length; i++) {
    const ri = th.ri[i];
    if (!covered(ri)) continue;
    const p = th.pos[i];
    const by = th.thrower[i];
    const thrower = by === null ? null : bodyAt(by, ri, th.tick[i]);
    if (thrower === null && by !== null) continue;
    add(t.grenade_throws!, "grenade_throws", {
      tick: th.tick[i], round: ri + 1, steamid: thrower === null ? null : key[thrower], weapon: THROW_CLASS[th.type[i]],
      side: sideOf(ri, thrower), x: p?.[0] ?? null, y: p?.[1] ?? null, z: p?.[2] ?? null,
    });
  }

  const s = m.aim.shots;
  const onScreen = targetOnScreen(m);
  for (const i of shotRows) {
    const ri = s.ri[i];
    const e = s.aimErr[i];
    add(t.shots!, "shots", {
      tick: s.tick[i], round: ri + 1, steamid: human, weapon: weapon(s.weapon[i]), side: sideOf(ri, m.human), ducked: s.ducked[i], scoped: s.scoped[i], speed_2d: s.speed[i],
      // the plugin stores aimErr in hundredths of a degree; plugin 1.2.0 adds absolute view angles, which
      // give its sprays absolute paths that compare with the pros' (aim.ts spray); older files lack them
      pitch: angle(s.pitch?.[i]), yaw: angle(s.yaw?.[i]),
      aim_err_yaw: e ? e[0] / 100 : null, aim_err_pitch: e ? e[1] / 100 : null,
      target_steamid: s.target[i] === null ? null : key[s.target[i]!], target_on_screen: onScreen(i),
    });
  }

  // A player's row in another's body goes to that body only when the body has no row of its own within
  // one bot sample (a second, plugin BotPosDue): bots keep their own rows while taken over, so it would
  // otherwise repeat the body's row under the wrong player. In no known body, it is left out.
  const p = m.pos;
  const posTicks = new Map<string, number[]>();
  for (let i = 0; i < p.ri.length; i++) posTicks.set(`${p.ri[i]}:${p.pi[i]}`, [...(posTicks.get(`${p.ri[i]}:${p.pi[i]}`) ?? []), p.tick[i]]);
  const sample = m.env.tickrate || 64;
  for (let i = 0; i < p.ri.length; i++) {
    const ri = p.ri[i];
    if (!covered(ri)) continue;
    const body = bodyAt(p.pi[i], ri, p.tick[i]);
    if (body === null) continue;
    if (body !== p.pi[i] && (posTicks.get(`${ri}:${body}`) ?? []).some((x) => Math.abs(x - p.tick[i]) < sample)) continue;
    add(t.positions!, "positions", {
      tick: p.tick[i], round: ri + 1, steamid: key[body], side: sideOf(ri, body), x: p.x[i], y: p.y[i], z: p.z[i],
      is_alive: p.alive[i], place: p.place[i] === null ? null : m.places[p.place[i]!] ?? null,
    });
  }
  // disconnects (plugin "leaves"), for the alive counts a round passes through
  if (m.leaves) {
    t.leaves = emptyTable("leaves");
    const L = m.leaves;
    for (let i = 0; i < L.ri.length; i++) {
      if (!covered(L.ri[i])) continue;
      add(t.leaves, "leaves", { tick: L.tick[i], round: L.ri[i] + 1, steamid: key[L.pi[i]], alive: L.alive[i] === 1 || L.alive[i] === true });
    }
  }
  return t;
}
