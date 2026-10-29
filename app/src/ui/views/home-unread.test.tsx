// Home's empty state when match files were found and none of the user's could be read (Home.tsx unread).
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { derive } from "../../stats/derive";
import { CS2RB } from "../../stats/model-params";
import { pluginToTables } from "../../stats/plugin/adapter";
import { decodeMatch } from "../../stats/plugin/decode";
import { entryOf } from "../../worker/views";
import { unread } from "./Home";

const SAMPLES = path.resolve(import.meta.dirname, "../../../public/samples");

it("says match files could not be read only when some failed and none of the user's was read", async () => {
  // fails if Home tells a user whose every match file failed to "play a match", as the desktop app did
  // when its derive workers could not start, or reports failures while some of their matches show
  const logs = await Promise.all(readdirSync(SAMPLES).filter((f) => f.endsWith(".json.gz")).map((f) => decodeMatch(readFileSync(path.join(SAMPLES, f)), f)));
  const m = logs.find((x) => { const f = derive(pluginToTables(x), CS2RB).match; return f.nRounds >= f.roundsPlayed / 2; })!;
  const facts = derive(pluginToTables(m), CS2RB);
  const own = entryOf("2026/own.json.gz", "", facts);
  const pro = entryOf("pro/faze-vs-sangal/m2-nuke", "", { ...facts, match: { ...facts.match, pov: null } });
  expect(unread([], 15)).toBe("15 match files could not be read. Data & settings lists them with the reason.");
  expect(unread([pro], 1)).toBe("1 match file could not be read. Data & settings lists them with the reason.");
  expect(unread([own], 1)).toBeNull();
  expect(unread([], 0)).toBeNull();
});
