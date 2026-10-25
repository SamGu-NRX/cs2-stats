// TRANSITIONAL (see adapter.ts): the capture plugin's match file format, as SCHEMA.md at the repo
// root describes it. Tables are columnar: each table is an object of equal-length arrays.

export type Side = 2 | 3; // 2 = T, 3 = CT

export type RoundHow = "elim" | "defuse" | "time" | "bomb";
export type GrenadeType = "he" | "flash" | "smoke" | "molotov" | "decoy";
export type Vec3 = [number, number, number];
/** [ctAlive, tAlive, ctHp, tHp, ctEquip, tEquip, planted(0/1), ticksSincePlant|null] */
export type KillState = [number, number, number, number, number | null, number | null, 0 | 1, number | null];

export interface Env {
  plugin: string | null;
  cssharp: string | null;
  game: string | null;
  tickrate: number;
  maxrounds: number | null;
  botDifficulty: number | null;
  /** set by the plugin once engagement visibility has been validated */
  visibilityValidated?: boolean;
  /** where equipment values came from over the match */
  equipSource?: "pawn" | "inventory" | "mixed";
  /** plugin 1.1.0: what decided visibility; null before any live round */
  visSource?: "los" | "mask" | "mixed" | null;
  /** plugin 1.1.0: why line of sight turned off */
  losError?: string;
  /** the human's player slot, controller entity index and pawn entity index (plugin 1.0.0), for aim.hitMask */
  humanSlot?: number | null;
  humanController?: number | null;
  humanPawn?: number | null;
}

/** Optional (plugin 1.0.0): the victim's raw spotted mask at each hit by the human. */
export interface HitMask {
  ri: number[];
  tick: number[];
  victim: number[];
  /** m_bSpottedByMask words, unsigned 32-bit */
  m0: number[];
  m1: number[];
  /** m_bSpotted */
  spotted: boolean[];
}

export interface Players {
  key: string[];
  name: string[];
  isBot: boolean[];
  startSide: Side[];
}

export interface Rounds {
  /** null when the plugin could not read the round result (recon.unknownResult) */
  winSide: (Side | null)[];
  how: (RoundHow | null)[];
  freezeTick: (number | null)[];
  durTicks: (number | null)[];
  bombSite: (string | null)[];
  plantTick: (number | null)[];
  planter: (number | null)[];
  defuser: (number | null)[];
  ctSetup: ([number, number, number, number, number] | null)[];
  score: [number, number][];
  side: (Side | null)[][];
  equip: (number | null)[][];
  money: (number | null)[][];
  // optional (plugin 1.0.0)
  /** equipment value at round end; 0 when dead */
  equipEnd?: (number | null)[][];
  /** 1 if alive at round end holding a primary */
  survPrimary?: (0 | 1 | null)[][];
  /** grenades bought [he, flash, smoke, molotov, incgrenade, decoy] */
  utilBought?: (UtilCounts | null)[][];
  /** money spent on those grenades */
  utilSpent?: (number | null)[][];
  // optional, read by this app; written by tools/convert-legacy.ts (see app/README.md)
  /** per player per round [kills, deaths, assists, damage, headshot kills] from the game's own round stats */
  basic?: (BasicCounts | null)[][];
  /** true for rounds with only totals (no kill-by-kill log); also implied by ri < firstFullRound */
  lite?: boolean[];
  /** players alive at round end, [CT, T], from the game */
  aliveEnd?: ([number, number] | null)[];
  /** 1 if alive at freeze end, 0 if dead: the round's starting population */
  alive0?: (0 | 1 | null)[][];
  /** source of the round's equipment values; null for rounds captured before freeze end */
  equipSrc?: ("pawn" | "inventory" | null)[];
}

/** [kills, deaths, assists, damage, headshot kills] for one player in one round. */
export type BasicCounts = [number, number, number, number, number];

/** Grenade counts in the order [he, flash, smoke, molotov, incgrenade, decoy]. */
export type UtilCounts = [number, number, number, number, number, number];

export interface Kills {
  ri: number[];
  tick: number[];
  killer: (number | null)[];
  victim: number[];
  assister: (number | null)[];
  flashAssister: (number | null)[];
  weapon: number[];
  flags: number[];
  kpos: (Vec3 | null)[];
  vpos: (Vec3 | null)[];
  state: (KillState | null)[];
  // optional (plugin 1.0.0)
  /** grenades row of the HE or molotov that did the killing blow */
  nade?: (number | null)[];
  /** grenades the victim still held, [he, flash, smoke, molotov, incgrenade, decoy] */
  vUtil?: (UtilCounts | null)[];
  /** pi of the bot whose body the killer / victim was controlling (takeover); credit stays with killer / victim */
  kBody?: (number | null)[];
  vBody?: (number | null)[];
}

export interface Damage {
  ri: number[];
  tick: number[];
  attacker: (number | null)[];
  victim: number[];
  dmg: number[];
  dmgArmor: number[];
  weapon: number[];
  hitgroup: (number | null)[];
  /** optional: grenades row of the HE or molotov that did this damage */
  nade?: (number | null)[];
}

export interface Blinds {
  ri: number[];
  tick: number[];
  attacker: (number | null)[];
  victim: number[];
  ms: number[];
  /** optional: grenades row of the flash that caused this blind */
  flash?: (number | null)[];
}

export interface Grenades {
  ri: number[];
  tick: number[];
  thrower: (number | null)[];
  type: GrenadeType[];
  pos: (Vec3 | null)[];
  /** optional: throws row this detonation came from */
  throw?: (number | null)[];
}

/** Optional (plugin 1.0.0): one row per grenade_thrown. */
export interface Throws {
  ri: number[];
  tick: number[];
  thrower: (number | null)[];
  type: (GrenadeType | "incgrenade")[];
  pos: (Vec3 | null)[];
}

/** Optional (plugin 1.0.0): the plugin's comparison of each round with the game's own per-round stats. */
export interface Recon {
  /** checkedPlayers / expectedPlayers per round; early plugin builds wrote a `checked` count instead */
  rounds?: {
    ri: number[]; checkedPlayers?: number[]; expectedPlayers?: number[]; checked?: (number | boolean)[];
    kOk?: unknown[]; dOk?: unknown[]; aOk?: unknown[]; dmgOk?: unknown[]; missing?: unknown[];
  };
  mismatch?: { ri: number[]; pi: number[]; field: string[]; ours: number[]; game: number[]; hits: (number | null)[] };
  partial?: number[];
  unknownResult?: number[];
}

export interface Pos {
  /** "delta": tick, x, y, z are differences from the previous row of the same pi (decoded on load) */
  enc?: "delta";
  ri: number[];
  tick: number[];
  pi: number[];
  x: number[];
  y: number[];
  z: number[];
  place: (number | null)[];
  alive: boolean[];
}

export interface Engagements {
  ri: number[];
  enemy: number[];
  tVis: number[];
  angVis: (number | null)[];
  angVisYaw: (number | null)[];
  angVisPitch: (number | null)[];
  dist: (number | null)[];
  tAimStart: (number | null)[];
  tFirstShot: (number | null)[];
  tFirstDmg: (number | null)[];
  tEnd: number[];
  outcome: ("kill" | "died" | "none")[];
}

export interface Shots {
  ri: number[];
  tick: number[];
  weapon: number[];
  burst: number[];
  idx: number[];
  speed: (number | null)[];
  maxSpeed: (number | null)[];
  scoped: boolean[];
  ducked: boolean[];
  target: (number | null)[];
  aimErr: ([number, number] | null)[];
  impact: ([number, number] | null)[];
  hit: (number | null)[];
  // optional per-shot fields announced for the plugin (read when present)
  /** the shot went through smoke */
  smoke?: (boolean | 0 | 1 | null)[];
  /** surfaces the bullet penetrated before its first hit; > 0 = wallbang */
  pen?: (number | null)[];
  /** 1/0: the target was visible by the engine's spotted mask; null without a target */
  visTarget?: (number | null)[];
  /** bullet_impact events in the shot's tick */
  impacts?: (number | null)[];
  /** weapon class from the item name; null for the taser */
  cls?: ("rifle" | "sniper" | "smg" | "pistol" | "shotgun" | "heavy" | null)[];
}

export interface MatchFile {
  v: 1;
  id: string;
  map: string;
  startUtc: string;
  endUtc: string;
  status: "complete" | "abandoned" | "restarted" | "inprogress";
  env: Env;
  firstFullRound: number;
  weapons: string[];
  places: string[];
  human: number;
  players: Players;
  rounds: Rounds;
  kills: Kills;
  damage: Damage;
  blinds: Blinds;
  grenades: Grenades;
  pos: Pos;
  /** los (plugin 1.1.0): an enemy entering (vis 1) or leaving (vis 0) the human's line of sight */
  aim: { engagements: Engagements; shots: Shots; hitMask?: HitMask; los?: { ri: number[]; tick: number[]; enemy: number[]; vis: (0 | 1)[] } };
  throws?: Throws;
  recon?: Recon;
  /** players who disconnected during a recorded round */
  leaves?: { ri: number[]; tick: number[]; pi: number[]; alive: (0 | 1 | boolean)[] };
}

export class SchemaError extends Error {
  constructor(where: string, message: string) {
    super(`Match file ${where}: ${message}`);
    this.name = "SchemaError";
  }
}

const TABLE_COLUMNS = {
  players: ["key", "name", "isBot", "startSide"],
  rounds: [
    "winSide", "how", "freezeTick", "durTicks", "bombSite", "plantTick", "planter", "defuser",
    "ctSetup", "score", "side", "equip", "money",
  ],
  kills: ["ri", "tick", "killer", "victim", "assister", "flashAssister", "weapon", "flags", "kpos", "vpos", "state"],
  damage: ["ri", "tick", "attacker", "victim", "dmg", "dmgArmor", "weapon", "hitgroup"],
  blinds: ["ri", "tick", "attacker", "victim", "ms"],
  grenades: ["ri", "tick", "thrower", "type", "pos"],
  pos: ["ri", "tick", "pi", "x", "y", "z", "place", "alive"],
  engagements: [
    "ri", "enemy", "tVis", "angVis", "angVisYaw", "angVisPitch", "dist", "tAimStart", "tFirstShot",
    "tFirstDmg", "tEnd", "outcome",
  ],
  shots: [
    "ri", "tick", "weapon", "burst", "idx", "speed", "maxSpeed", "scoped", "ducked", "target", "aimErr",
    "impact", "hit",
  ],
  throws: ["ri", "tick", "thrower", "type", "pos"],
  hitMask: ["ri", "tick", "victim", "m0", "m1", "spotted"],
} as const;

function checkTable(where: string, table: unknown, name: keyof typeof TABLE_COLUMNS): number {
  if (typeof table !== "object" || table === null) throw new SchemaError(where, `table "${name}" is missing`);
  const t = table as Record<string, unknown>;
  let len = -1;
  for (const col of TABLE_COLUMNS[name]) {
    const c = t[col];
    if (!Array.isArray(c)) throw new SchemaError(where, `column "${name}.${col}" is missing or not an array`);
    if (len === -1) len = c.length;
    else if (c.length !== len) {
      throw new SchemaError(where, `column "${name}.${col}" has ${c.length} rows, expected ${len}`);
    }
  }
  return len;
}

/** Validates the shape of a decoded match file. Throws SchemaError naming the first problem. */
export function validateMatch(raw: unknown, where = "(unnamed)"): MatchFile {
  if (typeof raw !== "object" || raw === null) throw new SchemaError(where, "top level is not an object");
  const m = raw as Record<string, unknown>;
  if (m.v !== 1) throw new SchemaError(where, `schema version is ${JSON.stringify(m.v)}, this app reads version 1`);
  for (const f of ["id", "map", "startUtc", "endUtc", "status"]) {
    if (typeof m[f] !== "string") throw new SchemaError(where, `field "${f}" must be a string`);
  }
  if (!Number.isInteger(m.firstFullRound)) throw new SchemaError(where, `field "firstFullRound" must be an integer`);
  if (!Number.isInteger(m.human)) throw new SchemaError(where, `field "human" must be an integer`);
  if (!Array.isArray(m.weapons)) throw new SchemaError(where, `field "weapons" must be an array`);
  if (!Array.isArray(m.places)) throw new SchemaError(where, `field "places" must be an array`);
  if (typeof m.env !== "object" || m.env === null) throw new SchemaError(where, `field "env" must be an object`);

  const nPlayers = checkTable(where, m.players, "players");
  const nRounds = checkTable(where, m.rounds, "rounds");
  for (const t of ["kills", "damage", "blinds", "grenades", "pos"] as const) checkTable(where, m[t], t);
  const aim = m.aim as Record<string, unknown> | undefined;
  if (typeof aim !== "object" || aim === null) throw new SchemaError(where, `field "aim" must be an object`);
  checkTable(where, aim.engagements, "engagements");
  checkTable(where, aim.shots, "shots");
  if (aim.hitMask !== undefined) checkTable(where, aim.hitMask, "hitMask");

  const human = m.human as number;
  if (human < 0 || human >= nPlayers) throw new SchemaError(where, `human index ${human} is outside players (0..${nPlayers - 1})`);
  const rounds = m.rounds as Rounds;
  for (let ri = 0; ri < nRounds; ri++) {
    for (const col of ["side", "equip", "money", "equipEnd", "survPrimary", "utilBought", "utilSpent", "basic", "alive0"] as const) {
      const table = rounds[col] as unknown[][] | undefined;
      if (!table) continue;
      // Rounds before capture began may carry null instead of a per-player row; read that as
      // "every player unknown" so the rest of the app has one shape to handle.
      if (table[ri] === null || table[ri] === undefined) table[ri] = new Array(nPlayers).fill(null);
      if (table[ri].length !== nPlayers) {
        throw new SchemaError(where, `rounds.${col}[${ri}] has ${table[ri].length} entries, expected ${nPlayers} (one per player)`);
      }
    }
  }
  if (m.throws !== undefined) checkTable(where, m.throws, "throws");
  decodePositions(m.pos as Pos);
  const ffr = m.firstFullRound as number;
  if (ffr < 0 || ffr > nRounds) throw new SchemaError(where, `firstFullRound ${ffr} is outside 0..${nRounds}`);
  return raw as MatchFile;
}

/**
 * Delta-encoded positions (pos.enc = "delta"): each player's first row is absolute and later rows
 * of the same pi hold differences in tick, x, y, z. Decoded in place to absolute values.
 */
export function decodePositions(p: Pos): void {
  if (p.enc !== "delta") return;
  const last = new Map<number, [number, number, number, number]>();
  for (let i = 0; i < p.ri.length; i++) {
    const prev = last.get(p.pi[i]);
    if (prev) {
      p.tick[i] += prev[0]; p.x[i] += prev[1]; p.y[i] += prev[2]; p.z[i] += prev[3];
    }
    last.set(p.pi[i], [p.tick[i], p.x[i], p.y[i], p.z[i]]);
  }
  delete p.enc;
}
