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
import { botPopulation, careerEntries, coverEntry, entryLine, filterEntries, recordEntries } from "./engine";
import { byNewest, matchModel, roundMatrix, sideOf, type MatchEntry, type MatchModel } from "./match";
import { sourceOf } from "./sources";

const SAMPLES = path.resolve(import.meta.dirname, "../../../public/samples");
const FILES = readdirSync(SAMPLES).filter((f) => f.endsWith(".json.gz"));

async function load(file: string): Promise<MatchModel> {
  const m = await decodeMatch(readFileSync(path.join(SAMPLES, file)), file);
  const facts = derive(pluginToTables(m), CS2RB);
  const entry = entryOf(`samples/${file}`, m.env.plugin ?? "", facts);
  return matchModel(entry, matchBundle(entry, facts));
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
      expect(entryLine(v.entry).rating, v.file).toBeNull();
      expect(v.b.lines.both[v.human].rating, v.file).toBeNull();
    }
    for (const v of full) expect(entryLine(v.entry).rating, v.file).not.toBeNull();
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

it("keeps unfinished matches and partial logs out of career views but in the match list", async () => {
  // fails if an abandoned match or a log covering a few rounds shows in Form, Recent matches or a
  // career average (the sidebar, the Rating 3.0 tile and Form's pooled line must read one match set)
  // a bundled log that covers most of its rounds
  const logs = await Promise.all(FILES.map((f) => decodeMatch(readFileSync(path.join(SAMPLES, f)), f)));
  const m = logs.find((x) => { const f = derive(pluginToTables(x), CS2RB).match; return f.nRounds >= f.roundsPlayed / 2; })!;
  const done = entryOf("done", "", derive(pluginToTables(m), CS2RB));
  const left = entryOf("left", "", derive(pluginToTables({ ...m, status: "abandoned" }), CS2RB));
  const partial = { ...done, file: "partial", match: { ...done.match, nRounds: 1, roundsPlayed: done.match.roundsPlayed } };
  // a pro demo (served from the dev folder) opens from Matches but is never the user's career
  const pro = { ...done, file: "dev/faze-vs-sangal" };
  expect(careerEntries([done, left, partial, pro], null).map((e) => e.file)).toEqual(["done"]);
  expect(filterEntries([done, left, partial, pro], null)).toHaveLength(4);
  // W-L counts the user's finished matches, a thin log included (its result is real); not the abandoned one or the pro demo
  expect(recordEntries([done, left, partial, pro]).map((e) => e.file)).toEqual(["done", "partial"]);
  // the adapter keeps a thin log's counts but none of its per-round values, so no view shows its few rounds as the match
  const thin = coverEntry(partial);
  expect(thin.line.m.kills).toBe(partial.line.m.kills);
  expect(Object.values(thin.line.v).every((v) => v === null)).toBe(true);
  expect(thin.line.eco).toBeNull();
  expect(coverEntry(done)).toBe(done);
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
