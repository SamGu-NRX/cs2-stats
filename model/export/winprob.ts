/**
 * CS2 round win probability for the CT side, evaluated from model.json with no dependencies.
 *
 * `state` is the round state at one moment (for round swing: just before and just after a
 * kill). Every field is required:
 *
 *   ctAlive                living CT players, integer 0-5
 *   tAlive                 living T players, integer 0-5
 *   ctHp                   summed health of the living CTs, 0-100 per player (0 to 100 * ctAlive)
 *   tHp                    summed health of the living Ts (0 to 100 * tAlive)
 *   ctEquip                CT team equipment value at freeze end, in dollars, summed over all five
 *                          players and fixed for the whole round (the value after buying, not the
 *                          value carried in from the previous round, and not reduced by deaths)
 *   tEquip                 the same for T
 *   planted                1 if the bomb is planted, else 0
 *   secondsSincePlant      seconds since the plant when planted = 1; null when planted = 0
 *   secondsSinceFreezeEnd  seconds since freeze time ended (ticks / 64 on a 64-tick server)
 *
 * `map` is the map name as the game reports it, e.g. "de_dust2". The model knows the seven
 * maps in model.json `maps`; on any other map it uses the average map effect.
 *
 * Decided states are answered by the game rules, not the model: 0 when no CT is alive or the
 * bomb has been planted for 40 s, 1 when no T is alive before a plant or 115 s have passed
 * without one. Invalid input throws a RangeError or TypeError naming the field.
 *
 * Needs `resolveJsonModule` (or a bundler that imports JSON) in the importing project.
 */
import rawModel from "./model.json";

export interface RoundState {
  ctAlive: number;
  tAlive: number;
  ctHp: number;
  tHp: number;
  ctEquip: number;
  tEquip: number;
  planted: 0 | 1;
  secondsSincePlant: number | null;
  secondsSinceFreezeEnd: number;
}

type VarName =
  | "ctAlive"
  | "tAlive"
  | "planted"
  | "ctHpLost"
  | "tHpLost"
  | "ctEquipLog"
  | "tEquipLog"
  | "elapsed"
  | "sincePlant";
type Vars = Record<VarName, number>;

type Factor =
  | { kind: "map"; map: string }
  | { kind: "value"; name: VarName }
  | { kind: "eq"; name: VarName; k: number }
  | { kind: "hinge"; name: VarName; k: number };

interface CompiledModel {
  maps: ReadonlySet<string>;
  mapShare: Readonly<Record<string, number>>;
  bombSeconds: number;
  roundSeconds: number;
  terms: ReadonlyArray<{ w: number; factors: Factor[] }>;
}

const VAR_NAMES: ReadonlySet<string> = new Set<VarName>([
  "ctAlive", "tAlive", "planted", "ctHpLost", "tHpLost", "ctEquipLog", "tEquipLog", "elapsed", "sincePlant",
]);
const FACTOR_RE = /^(map)=(de_[a-z0-9_]+)$|^([A-Za-z]+)(?:([=>])(-?\d+(?:\.\d+)?))?$/;

function parseFactor(s: string): Factor {
  const m = FACTOR_RE.exec(s);
  if (!m) throw new Error(`model.json: malformed factor "${s}"`);
  if (m[1]) return { kind: "map", map: m[2] };
  const name = m[3];
  if (!VAR_NAMES.has(name)) throw new Error(`model.json: unknown variable "${name}" in factor "${s}"`);
  const v = name as VarName;
  if (m[4] === "=") return { kind: "eq", name: v, k: Number(m[5]) };
  if (m[4] === ">") return { kind: "hinge", name: v, k: Number(m[5]) };
  return { kind: "value", name: v };
}

function compile(raw: unknown): CompiledModel {
  const r = raw as {
    format?: unknown; version?: unknown; maps?: unknown; mapShare?: unknown;
    terminal?: { bombSeconds?: unknown; roundSeconds?: unknown }; terms?: unknown;
  };
  if (r.format !== "cs2-winprob-logit-terms" || r.version !== 1) {
    throw new Error(`model.json: expected format cs2-winprob-logit-terms version 1, got ${String(r.format)} ${String(r.version)}`);
  }
  if (!Array.isArray(r.maps) || !r.maps.every((m) => typeof m === "string")) throw new Error("model.json: maps must be strings");
  const mapShare = r.mapShare as Record<string, number>;
  for (const m of r.maps as string[]) {
    if (typeof mapShare?.[m] !== "number") throw new Error(`model.json: mapShare missing ${m}`);
  }
  const bombSeconds = r.terminal?.bombSeconds;
  const roundSeconds = r.terminal?.roundSeconds;
  if (typeof bombSeconds !== "number" || typeof roundSeconds !== "number") throw new Error("model.json: terminal times missing");
  if (!Array.isArray(r.terms) || r.terms.length === 0) throw new Error("model.json: no terms");
  const terms = r.terms.map((t: { w?: unknown; f?: unknown }, i: number) => {
    if (typeof t.w !== "number" || !Number.isFinite(t.w) || !Array.isArray(t.f)) {
      throw new Error(`model.json: term ${i} needs a finite w and a factor list f`);
    }
    const factors = (t.f as unknown[]).map((s) => {
      if (typeof s !== "string") throw new Error(`model.json: term ${i} has a non-string factor`);
      const f = parseFactor(s);
      if (f.kind === "map" && !(r.maps as string[]).includes(f.map)) throw new Error(`model.json: term ${i} uses unlisted map ${f.map}`);
      return f;
    });
    return { w: t.w, factors };
  });
  return { maps: new Set(r.maps as string[]), mapShare, bombSeconds, roundSeconds, terms };
}

const MODEL = compile(rawModel);

function check(cond: boolean, field: string, msg: string, value: unknown): void {
  if (!cond) throw new RangeError(`winProbabilityCT: ${field} ${msg}, got ${JSON.stringify(value)}`);
}

function validate(s: RoundState, map: string): void {
  if (typeof map !== "string" || map.length === 0) throw new TypeError(`winProbabilityCT: map must be a non-empty string, got ${JSON.stringify(map)}`);
  for (const [field, n] of [["ctAlive", s.ctAlive], ["tAlive", s.tAlive]] as const) {
    check(Number.isInteger(n) && n >= 0 && n <= 5, field, "must be an integer 0-5", n);
  }
  check(Number.isFinite(s.ctHp) && s.ctHp >= 0 && s.ctHp <= 100 * s.ctAlive, "ctHp", `must be 0-${100 * s.ctAlive} for ${s.ctAlive} living CTs`, s.ctHp);
  check(Number.isFinite(s.tHp) && s.tHp >= 0 && s.tHp <= 100 * s.tAlive, "tHp", `must be 0-${100 * s.tAlive} for ${s.tAlive} living Ts`, s.tHp);
  check(Number.isFinite(s.ctEquip) && s.ctEquip >= 0, "ctEquip", "must be a finite dollar amount >= 0", s.ctEquip);
  check(Number.isFinite(s.tEquip) && s.tEquip >= 0, "tEquip", "must be a finite dollar amount >= 0", s.tEquip);
  check(s.planted === 0 || s.planted === 1, "planted", "must be 0 or 1", s.planted);
  if (s.planted === 1) {
    check(typeof s.secondsSincePlant === "number" && Number.isFinite(s.secondsSincePlant) && s.secondsSincePlant >= 0,
      "secondsSincePlant", "must be seconds >= 0 when planted = 1", s.secondsSincePlant);
  } else {
    check(s.secondsSincePlant === null, "secondsSincePlant", "must be null when planted = 0", s.secondsSincePlant);
  }
  check(Number.isFinite(s.secondsSinceFreezeEnd) && s.secondsSinceFreezeEnd >= 0, "secondsSinceFreezeEnd", "must be seconds >= 0", s.secondsSinceFreezeEnd);
}

/** Probability (0-1) that CT wins the round from `state` on `map`. See the header for units. */
export function winProbabilityCT(state: RoundState, map: string): number {
  validate(state, map);
  const { ctAlive, tAlive, planted, secondsSinceFreezeEnd: elapsed } = state;
  const since = planted === 1 ? (state.secondsSincePlant as number) : 0;
  if (ctAlive === 0) return 0;
  if (tAlive === 0 && planted === 0) return 1;
  if (planted === 1 && since >= MODEL.bombSeconds) return 0;
  if (planted === 0 && elapsed >= MODEL.roundSeconds) return 1;

  const v: Vars = {
    ctAlive,
    tAlive,
    planted,
    ctHpLost: ctAlive - state.ctHp / 100,
    tHpLost: tAlive - state.tHp / 100,
    ctEquipLog: Math.log1p(state.ctEquip / 1000),
    tEquipLog: Math.log1p(state.tEquip / 1000),
    elapsed,
    sincePlant: since,
  };
  const known = MODEL.maps.has(map);
  let z = 0;
  for (const t of MODEL.terms) {
    let val = t.w;
    for (const f of t.factors) {
      switch (f.kind) {
        case "map":
          val *= known ? (map === f.map ? 1 : 0) : MODEL.mapShare[f.map];
          break;
        case "eq":
          val *= v[f.name] === f.k ? 1 : 0;
          break;
        case "hinge":
          val *= Math.max(v[f.name] - f.k, 0);
          break;
        case "value":
          val *= v[f.name];
          break;
      }
    }
    z += val;
  }
  return 1 / (1 + Math.exp(-z));
}

/** True when `map` has its own effects in the model; other maps use the average map effect. */
export function isModelledMap(map: string): boolean {
  return MODEL.maps.has(map);
}
