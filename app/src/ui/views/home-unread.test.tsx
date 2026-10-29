// What Home and the sidebar say when match files were found and none of the user's could be read
// (engine.ts unreadOwnFiles, unreadText).
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { derive } from "../../stats/derive";
import { CS2RB } from "../../stats/model-params";
import { pluginToTables } from "../../stats/plugin/adapter";
import { decodeMatch } from "../../stats/plugin/decode";
import { entryOf } from "../../worker/views";
import { careerEntries, isOwn, unreadOwnFiles, unreadText } from "../data/engine";

const SAMPLES = path.resolve(import.meta.dirname, "../../../public/samples");

it("counts the user's unread match files only when none of their own matches was read, and never a pro map", async () => {
  // fails if a user with only pro demos read, or with an own match that is left out of career views,
  // is told their files could not be read; or if a user whose every own file failed is told to play a match
  const logs = await Promise.all(readdirSync(SAMPLES).filter((f) => f.endsWith(".json.gz")).map((f) => decodeMatch(readFileSync(path.join(SAMPLES, f)), f)));
  const m = logs.find((x) => { const f = derive(pluginToTables(x), CS2RB).match; return f.nRounds >= f.roundsPlayed / 2; })!;
  const facts = derive(pluginToTables(m), CS2RB);
  const career = entryOf("2026/own.json.gz", "", facts);
  // an own Valve match that career views leave out (unfinished)
  const outside = entryOf("valve/2026/unfinished", "", derive(pluginToTables({ ...m, status: "abandoned" }), CS2RB));
  const pro = entryOf("pro/faze-vs-sangal/m2-nuke", "", { ...facts, match: { ...facts.match, pov: null } });
  expect([isOwn(outside), careerEntries([outside], null).length]).toEqual([true, 0]);
  const failed = (...files: string[]) => files.map((file) => ({ file }));

  expect(unreadOwnFiles([career], failed("2026/bad.json.gz"))).toBe(0);
  expect(unreadOwnFiles([outside], failed("2026/bad.json.gz"))).toBe(0);
  expect(unreadOwnFiles([pro], failed("pro/s-1/m1-dust2"))).toBe(0);
  // a dev match folder is a pro demo too (sources.ts isProFile), in the dev server's runtime
  expect(unreadOwnFiles([pro], failed("dev/faze-vs-sangal-m2"))).toBe(0);
  expect(unreadOwnFiles([], failed("dev/faze-vs-sangal-m2", "pro/s-1/m1-dust2"))).toBe(0);
  expect(unreadOwnFiles([pro], failed("pro/s-1/m1-dust2", "2026/bad.json.gz"))).toBe(1);
  expect(unreadOwnFiles([], failed("2026/a.json.gz", "2026/b.json.gz"))).toBe(2);
  expect(unreadOwnFiles([], [])).toBe(0);
  expect([unreadText(1), unreadText(15)]).toEqual(["1 match file could not be read", "15 match files could not be read"]);
});
