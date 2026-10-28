// The worker's shaping of MatchFacts must agree with the engine it reads: the round grid holds every
// kill and death the scoreboard counts, a side's line covers that side's rounds, the running score
// ends at the match score, a thinly covered match shows no rating on any side, and each bundled file
// is labelled with its source.
import { CS2RB } from "../../stats/model-params";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { derive } from "../../stats/derive";
import { pluginToTables } from "../../stats/plugin/adapter";
import { decodeMatch } from "../../stats/plugin/decode";
import { entryOf, matchBundle } from "../../worker/views";
import { aimEntries, botPopulation, careerEntries, coverEntry, entryLine, filterEntries, opponentIds, recordEntries, teamsOf, type OwnEntry } from "./engine";
import { opponentsIn } from "../../stats/opponents";
import { FREEZE_END, oneRound } from "../../stats/testing/match";
import { byNewest, matchModel, roundMatrix, sideOf, teamLabel, type MatchEntry, type ViewedMatch } from "./match";
import { sourceOf } from "./sources";

const SAMPLES = path.resolve(import.meta.dirname, "../../../public/samples");
const FILES = readdirSync(SAMPLES).filter((f) => f.endsWith(".json.gz"));

async function load(file: string): Promise<ViewedMatch> {
  const m = await decodeMatch(readFileSync(path.join(SAMPLES, file)), file);
  const facts = derive(pluginToTables(m), CS2RB);
  const entry = entryOf(`samples/${file}`, m.env.plugin ?? "", facts);
  const v = matchModel(entry, matchBundle(entry, facts, null));
  if (v.human === null) throw new Error(`${file} has a recording player`);
  return { ...v, human: v.human };
}

describe("match model", async () => {
  const models = await Promise.all(FILES.map(load));

  it("puts every kill and death the scoreboard counts into the round grid", () => {
    for (const v of models) {
      const grid = roundMatrix(v);
      v.players.forEach((p) => {
        const m = v.b.lines.both[p.pi].m;
        expect(grid[p.pi].reduce((a, c) => a + c.kills.length, 0), `${v.file} ${p.name} kills`).toBe(m.kills);
        expect(grid[p.pi].filter((c) => c.died).length, `${v.file} ${p.name} deaths`).toBe(m.deaths);
      });
    }
  });

  it("rolls a side's line up over the rounds the player spent on that side", () => {
    for (const v of models) {
      const onT = v.rounds.filter((r) => r.pr[v.human] && sideOf(v, r, v.human) === "T").length;
      expect(v.b.lines.t[v.human].m.rounds, v.file).toBe(onT);
      expect(v.b.lines.ct[v.human].m.rounds, v.file).toBe(v.rounds.filter((r) => r.pr[v.human]).length - onT);
    }
  });

  it("counts every round of a file with throws, logged or rebuilt from detonations, toward the thrown-per-round rates", () => {
    // fails if the plugin's rebuilt throws (older files) drop out of the rates as the Valve imports do
    const sources = new Set<string | null>();
    for (const v of models) {
      const m = v.b.lines.both[v.human].m;
      sources.add(v.facts.match.inputs.throws);
      expect(m.throwRounds, v.file).toBe(v.facts.match.inputs.throws === null ? 0 : m.rounds);
    }
    expect(sources.has("rebuilt")).toBe(true);
  });

  it("ends the running score at the match score, or has none when early rounds are missing", () => {
    for (const v of models) {
      const last = v.rounds[v.rounds.length - 1];
      if (v.rounds.every((r, ri) => r.number === ri + 1)) expect(last.scoreAfter, v.file).toEqual(v.entry.score);
      else expect(last.scoreAfter, v.file).toBeNull();
    }
  });

  it("shows no rating for a match whose kill log covers under half its rounds", () => {
    const thin = models.filter((v) => v.facts.match.nRounds < v.facts.match.roundsPlayed / 2);
    const full = models.filter((v) => v.facts.match.nRounds === v.facts.match.roundsPlayed);
    expect(thin.length).toBeGreaterThan(0);
    expect(full.length).toBeGreaterThan(0);
    for (const v of thin) {
      expect(entryLine(v.entry as OwnEntry).rating, v.file).toBeNull();
      expect(v.b.lines.both[v.human].rating, v.file).toBeNull();
    }
    for (const v of full) expect(entryLine(v.entry as OwnEntry).rating, v.file).not.toBeNull();
  });

  it("shows no T or CT rating either for a converted log with one logged round", () => {
    const one = models.filter((v) => v.facts.match.nRounds === 1);
    expect(one.length).toBeGreaterThan(0);
    for (const v of one) {
      // the logged round is on one side, so without the rule that side would be rated from one round
      expect(v.b.lines.t[v.human].m.rounds + v.b.lines.ct[v.human].m.rounds, v.file).toBe(1);
      expect(v.b.lines.t[v.human].rating, v.file).toBeNull();
      expect(v.b.lines.ct[v.human].rating, v.file).toBeNull();
    }
  });

  it("labels the bundled files by the source that wrote them", () => {
    for (const v of models) expect(sourceOf(v.entry).id, v.file).toBe(v.file.includes("synthetic-demo") ? "synthetic" : "converted");
  });
});

it("keeps unfinished matches, partial logs and pro demos out of career views but in the match list", async () => {
  // fails if an abandoned match, a log covering a few rounds or a pro demo shows in Form, Recent matches
  // or a career average (the sidebar, the Rating 3.0 tile and Form's pooled line must read one match set)
  // a bundled log that covers most of its rounds
  const logs = await Promise.all(FILES.map((f) => decodeMatch(readFileSync(path.join(SAMPLES, f)), f)));
  const m = logs.find((x) => { const f = derive(pluginToTables(x), CS2RB).match; return f.nRounds >= f.roundsPlayed / 2; })!;
  const facts = derive(pluginToTables(m), CS2RB);
  const done = entryOf("done", "", facts);
  const left = entryOf("left", "", derive(pluginToTables({ ...m, status: "abandoned" }), CS2RB));
  const partial = { ...done, file: "partial", match: { ...done.match, nRounds: 1, roundsPlayed: done.match.roundsPlayed } };
  // a map from the pro library, which nobody recorded: it opens from Matches but is never the user's career
  const pro = entryOf("pro/faze-vs-sangal/m2-nuke", "", { ...facts, match: { ...facts.match, pov: null } });
  expect(careerEntries([done, left, partial, pro], null).map((e) => e.file)).toEqual(["done"]);
  expect(filterEntries([done, left, partial, pro], null)).toHaveLength(4);
  // W-L counts the user's finished matches, a thin log included (its result is real); not the abandoned one or the pro demo
  expect(recordEntries([done, left, partial, pro]).map((e) => e.file)).toEqual(["done", "partial"]);
  expect(aimEntries([done, pro], null).map((e) => e.file)).toEqual(done.hasAim ? ["done"] : []);
  expect(opponentIds([pro])).toEqual([]);
  // the adapter keeps a thin log's counts but none of its per-round values, so no view shows its few rounds as the match
  const thin = coverEntry(partial);
  expect(thin.line!.m.kills).toBe(partial.line!.m.kills);
  expect(Object.values(thin.line!.v).every((v) => v === null)).toBe(true);
  expect(thin.line!.eco).toBeNull();
  expect(coverEntry(done)).toBe(done);
});

it("gives a pro map an entry with no recording player, and a recording without one none", async () => {
  // fails if a map from the pro library, which carries no recording player, gets no entry (it would
  // never list), or if one of the user's files without its player is listed as if it were a pro demo
  const file = FILES.find((x) => !x.includes("synthetic"))!;
  const f = derive(pluginToTables(await decodeMatch(readFileSync(path.join(SAMPLES, file)), file)), CS2RB);
  const noPov = { ...f, match: { ...f.match, pov: null } };
  const pro = entryOf("pro/vitality-vs-mouz-1/m1-mirage/v-1.16.0-0123abcd", "extracted, 1.16.0", noPov);
  expect([pro.you, pro.line, pro.shots, sourceOf(pro).id]).toEqual([null, null, 0, "pro"]);
  expect([pro.score.us, pro.score.them]).toEqual(noPov.match.score);
  expect(() => entryOf("2026/recorded.json.gz", "", noPov)).toThrow(/recording player/);
});

it("sees a pro demo through nobody until a player is picked, and the user's match through the user", async () => {
  // fails if a pro demo frames a player as yours before a pick, ignores the pick, or if a pick (?as=)
  // could make another player "you" on the user's own match
  const file = FILES.find((x) => !x.includes("synthetic"))!;
  const f = derive(pluginToTables(await decodeMatch(readFileSync(path.join(SAMPLES, file)), file)), CS2RB);
  const pro = entryOf("pro/a-vs-b-1/m1-dust2", "", { ...f, match: { ...f.match, pov: null } });
  const before = matchModel(pro, matchBundle(pro, f, null));
  expect([before.human, before.pro, before.players.some((p) => p.isHuman), before.b.yourRounds.length]).toEqual([null, true, false, 0]);
  expect([teamLabel(before, "us"), teamLabel(before, "them")]).toEqual(f.match.teams);
  const pick = f.players[3].id;
  const after = matchModel(pro, matchBundle(pro, f, pick), pick);
  expect([after.human, after.b.yourRounds.length]).toEqual([3, f.rounds.length]);
  const own = entryOf(`samples/${file}`, "", f);
  expect(matchModel(own, matchBundle(own, f, null), pick).human).toBe(own.you);
});

it("orders matches newest first by start time, not by day or file name", () => {
  // the Home hero and the Matches default sort read this order: an evening log from Oct 24 local time
  // must sit below a recording from the next afternoon, whatever their UTC dates and file names say
  const at = (file: string, date: string | null, startedAt: string | null) => ({ file, match: { date, startedAt } }) as unknown as MatchEntry;
  const list = [
    at("z-evening", "2026-10-25", "2026-10-25T02:06:00Z"),
    at("a-afternoon", "2026-10-25", "2026-10-25T19:40:00Z"),
    at("dayonly", "2026-10-13", null),
    at("unknown", null, null),
  ];
  expect([...list].sort(byNewest).map((e) => e.file)).toEqual(["a-afternoon", "z-evening", "dayonly", "unknown"]);
});

it("names the bot population with one count and the noun of what a sample is", () => {
  // the provisional chip, the panel and card asides once said "63 bot matches" and "62 bot careers" for one pool
  const c = { unit: "matches", botMatches: 63, qualified: 2, needed: 8, minRounds: 150, provisional: true, minPool: 8 } as const;
  expect(botPopulation(c).text).toBe("63 bot matches");
  expect(botPopulation(c, { n: 62, role: "rifler" }).text).toBe("62 rifler bot matches");
  expect(botPopulation({ ...c, unit: "careers", qualified: 9 }).text).toBe("9 bot careers");
});

describe("the match header's teams", () => {
  // fails if the header names teams the file does not hold: the old line said "5 bots" for every match
  const p = (name: string, team: 0 | 1 | null, bot: boolean) => ({ id: name, name, team, bot });
  it("counts a bot match's opponents from the file", async () => {
    const m = await decodeMatch(readFileSync(path.join(SAMPLES, "20261024T214921Z_de_dust2_b2a5666c.json.gz")), "x");
    const e = entryOf("x", m.env.plugin ?? "", derive(pluginToTables(m), CS2RB));
    expect(e.players.filter((x) => !x.bot)).toHaveLength(1);
    expect(teamsOf(e)).toEqual({ mates: 4, opponents: "5 bots" });
  });
  it("counts a pro match's opponents as players, since the file names no teams", () => {
    const pro = [p("a1", 0, false), p("a2", 0, false), p("a3", 0, false), p("a4", 0, false), p("a5", 0, false),
      p("b1", 1, false), p("b2", 1, false), p("b3", 1, false), p("b4", 1, false), p("b5", 1, false), p("caster", null, false)];
    expect(teamsOf({ players: pro, you: 0 })).toEqual({ mates: 4, opponents: "5 players" });
  });
  it("says a mixed team is mixed, and leaves out what the file does not hold", () => {
    const mixed = [p("You", 0, false), p("Rip", 0, true), p("Ana", 1, false), p("Sam", 1, false), p("Bot1", 1, true), p("Bot2", 1, true), p("Bot3", 1, true)];
    expect(teamsOf({ players: mixed, you: 0 })).toEqual({ mates: 1, opponents: "3 bots, 2 players" });
    expect(teamsOf({ players: [p("You", 0, false), p("Solo", 1, true)], you: 0 }).opponents).toBe("1 bot");
    expect(teamsOf({ players: [p("You", 0, false)], you: 0 })).toEqual({ mates: 0, opponents: null });
    expect(teamsOf({ players: [p("You", null, false), p("Bot", 1, true)], you: 0 })).toEqual({ mates: 0, opponents: null });
  });
});

describe("opponentIds", () => {
  it("lists the players faced who played a round, by the engine's own rule", () => {
    // fails if a teammate, a listed player who played no round, or a match the recording player sat out
    // adds an opponent: in m1 a faces c; in m2 c is a's teammate, d is an opponent and e, marked dead at
    // freeze end, never played; in m3 a is marked dead at freeze end, so its f is no one's opponent
    const kill = [{ tick: FREEZE_END + 320, killer: "a", victim: "c" }];
    const m1 = oneRound({ players: { a: "CT", c: "T" }, kills: kill });
    const m2 = oneRound({ players: { a: "CT", c: "CT", d: "T", e: "T" }, player_rounds: { e: { alive_at_start: false } } });
    const m3 = oneRound({ players: { a: "CT", f: "T" }, player_rounds: { a: { alive_at_start: false } } });
    const facts = [m1, m2, m3].map((f) => ({ ...f, match: { ...f.match, pov: "a" } }));
    const entries = facts.map((f, i) => entryOf(`m${i + 1}`, "test", f));
    expect(opponentIds(entries).sort()).toEqual(["c", "d"]);
    expect(opponentIds(entries).sort()).toEqual([...new Set(facts.flatMap((f) => opponentsIn(f, new Set(["a"]))))].sort());
  });
});
