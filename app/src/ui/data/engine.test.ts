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
import { careerEntries, entryLine, filterEntries } from "./engine";
import { matchModel, roundMatrix, sideOf, type MatchModel } from "./match";
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
  expect(careerEntries([done, left, partial], null).map((e) => e.file)).toEqual(["done"]);
  expect(filterEntries([done, left, partial], null)).toHaveLength(3);
});
