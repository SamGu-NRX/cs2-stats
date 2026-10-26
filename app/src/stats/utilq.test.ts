// Smoke crediting on a hand-built one-round match: CT player "a" (team A) and T player "b" (team B),
// whose mesh line of sight opens through smoke at tick 500 (by default in both directions).
import { CS2RB } from "./model-params";
import { expect, it } from "vitest";
import { buildCtx } from "./derive";
import { emptyTable, SCHEMA, type MatchTables, type Table, type TableName } from "./tables";
import { pushRow } from "./testing/tables";
import { deriveUtilQ } from "./utilq";
import { rosterTables } from "./roster";

/** A table from partial rows; columns the module does not read are null. */
function table<N extends TableName>(name: N, rows: Record<string, unknown>[]): Table<N> {
  const t = emptyTable(name);
  for (const r of rows) pushRow(t, { ...Object.fromEntries(Object.keys(SCHEMA[name]).map((c) => [c, null])), ...r } as Parameters<typeof pushRow<N>>[1]);
  return t;
}

// b's eye at (0, 0, 64), a's at (400, 0, -236): the segment's midpoint is (200, 0, -86).
const eyes = { a: [400, 0, -236], b: [0, 0, 64] } as const;
const smoke = (steamid: string, x: number, z: number) => ({ steamid, round: 1, start_tick: 100, end_tick: 2000, x, y: 0, z: z - 60 });

function facts(smokes: Record<string, unknown>[], dirs: ("ab" | "ba")[] = ["ba", "ab"], ticks = 1) {
  const eng = (id: number, att: "a" | "b", vic: "a" | "b") => ({ engagement_id: id, round: 1, attacker_steamid: att, victim_steamid: vic, start_tick: 436, end_tick: 564, first_visible_tick: 500 });
  const tick = (id: number, att: "a" | "b", vic: "a" | "b", k: number) => ({
    engagement_id: id, tick: 500 + k, mesh_visible: true, smoke_blocked: true,
    a_x: eyes[att][0], a_y: eyes[att][1], a_eye_z: eyes[att][2], v_x: eyes[vic][0], v_y: eyes[vic][1], v_eye_z: eyes[vic][2],
  });
  const t: MatchTables = {
    match: table("match", [{ tick_rate: 64, team_ct_start: "A", team_t_start: "B", visibility_status: "ok" }]),
    players: table("players", [{ steamid: "a", name: "a", team: "A", is_bot: false }, { steamid: "b", name: "b", team: "B", is_bot: false }]),
    rounds: table("rounds", [{ round: 1, start_tick: 0, freeze_end_tick: 0, end_tick: 10_000, ct_team: "A", t_team: "B" }]),
    player_rounds: table("player_rounds", [{ round: 1, steamid: "a", side: "CT", inventory: [] }, { round: 1, steamid: "b", side: "T", inventory: [] }]),
    kills: emptyTable("kills"), damages: emptyTable("damages"), blinds: emptyTable("blinds"), bomb: emptyTable("bomb"),
    grenade_throws: null, grenade_events: null, shots: null, positions: null, spotted: null, infernos: null,
    smokes: table("smokes", smokes),
    engagements: table("engagements", dirs.map((d, id) => eng(id, d[0] as "a" | "b", d[1] as "a" | "b"))),
    engagement_ticks: table("engagement_ticks", dirs.flatMap((d, id) => Array.from({ length: ticks }, (_, k) => tick(id, d[0] as "a" | "b", d[1] as "a" | "b", k)))), purchases: null, leaves: null,
  };
  return deriveUtilQ(buildCtx(rosterTables(t), CS2RB));
}
const sights = (smokes: Record<string, unknown>[], dirs?: ("ab" | "ba")[]) => facts(smokes, dirs).map((f) => f.sights);

it("credits a sightline through a smoke once, to the team the smoke hid", () => {
  // fails if both directions of the pair credit the thrower, or the credit goes to the attacker's team
  expect(sights([smoke("a", 200, -86)], ["ba"])).toEqual([1]);
  expect(sights([smoke("b", 200, -86)], ["ba"])).toEqual([0]);
  expect(sights([smoke("a", 200, -86)])).toEqual([1]);
});

it("splits a sightline among the smokes that blocked it, each team keeping only its own share", () => {
  // fails if shares are not split by the number of blocking smokes, or a smoke takes credit in both directions:
  // b->a is blocked by both smokes and a's half goes to a's smoke; a->b likewise gives b's smoke half
  expect(sights([smoke("a", 190, -80), smoke("b", 210, -92)])).toEqual([0.5, 0.5]);
});

it("does not credit a smoke past the end of the sightline", () => {
  // fails if the sphere test treats the sight segment as an infinite line: the second smoke sits on the line
  // 500 units beyond a's eye and would take half the credit
  expect(sights([smoke("a", 200, -86), smoke("a", 800, -536)])).toEqual([1, 0]);
});

it("counts every second an enemy line of sight ran through the smoke, not only the onset", () => {
  // fails if blocked time stops at the onset tick or credits the attacker's own team
  const [mine, theirs] = facts([smoke("a", 200, -86), smoke("b", 600, 0)], ["ba"], 64);
  expect(mine.blockedSecs).toBeCloseTo(1, 9);
  expect(theirs.blockedSecs).toBe(0);
  expect(mine.sights).toBe(1);
});
