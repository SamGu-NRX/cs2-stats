import { readFileSync } from "node:fs";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { derive } from "../../../stats/derive";
import { CS2RB } from "../../../stats/model-params";
import { pluginToTables } from "../../../stats/plugin/adapter";
import { decodeMatch } from "../../../stats/plugin/decode";
import { entryOf } from "../../../worker/views";
import type { MatchEntry } from "../match";
import { parsePayload, type LeetifyMatch } from "./api";
import { joinMatches } from "./join";
import { encodeShareCode } from "./sharecode";
import { SYNTHETIC_MATCHES, syntheticMatch, syntheticPayload, SYNTHETIC_STEAM64, type SyntheticMatch } from "./synthetic";

const SAMPLE = "20261025T000642Z_de_dust2_9b00e592.json.gz";
async function sampleEntry(): Promise<MatchEntry> {
  const m = await decodeMatch(gunzipSync(readFileSync(path.resolve(import.meta.dirname, "../../../../public/samples", SAMPLE))), SAMPLE);
  return entryOf(`samples/${SAMPLE}`, m.env.plugin ?? "", derive(pluginToTables(m), CS2RB));
}
const base = await sampleEntry();
/** The Leetify profile's player, who recorded the sample. */
const ME = SYNTHETIC_STEAM64;
/** The sample as another local match: a different file, start, length, map or score. */
function local(file: string, over: { startedAt?: string | null; durationS?: number | null; map?: string; us?: number; them?: number; pov?: string } = {}): MatchEntry {
  return {
    ...base, file,
    match: { ...base.match, startedAt: over.startedAt === undefined ? "2026-10-20T19:20:00.000Z" : over.startedAt, durationS: over.durationS === undefined ? 2400 : over.durationS, map: over.map ?? "de_mirage", pov: over.pov ?? ME },
    score: { us: over.us ?? 13, them: over.them ?? 9 },
  };
}
const leetify = (over: Partial<SyntheticMatch>): LeetifyMatch =>
  parsePayload({ profile: syntheticPayload(0).profile, matches: [syntheticMatch({ id: "l1", finished: "2026-10-20T20:01:00.000Z", map: "de_mirage", sourceId: null, won: 13, lost: 9, kills: 20, deaths: 15, rating: 0.05, ...over })], fetchedAt: 0 }).matches[0];
const code = (id: bigint) => encodeShareCode({ matchId: id, reservationId: 1n, tvPort: 27015 });
const VALVE = "valve/match730_003900000000000000042_0000027042_100/v-1.13.0-0a1b2c3d";

describe("joining Leetify matches to local ones", () => {
  it("joins by Valve match id, whatever the time, map or score say", () => {
    // fails if the share code's id is not compared with the demo file's
    const e = local(VALVE, { startedAt: null, map: "de_nuke", us: 1, them: 13 });
    const l = leetify({ id: "a", sourceId: code(3900000000000000042n) });
    const j = joinMatches([l, leetify({ id: "b", sourceId: code(3900000000000000043n), map: "de_inferno" })], [e], ME);
    expect(j.byFile.get(VALVE)).toEqual({ match: l, rule: "match-id" });
    expect(j.only.map((x) => x.id)).toEqual(["b"]);
  });

  it("never joins on time, map and score, however well they fit", () => {
    // fails if a guess attaches a match that may be another one (review of #52): only a Valve match id joins
    for (const e of [local("2026/a.json.gz"), local(VALVE, { startedAt: "2026-10-20T19:20:00.000Z", durationS: 2400 })]) {
      const j = joinMatches([leetify({ sourceId: null })], [e], ME);
      expect(j.byFile.size, e.file).toBe(0);
      expect(j.only.map((x) => x.id), e.file).toEqual(["l1"]);
    }
    // a share code naming another match does not join either
    expect(joinMatches([leetify({ sourceId: code(3900000000000000077n) })], [local(VALVE)], ME).byFile.size).toBe(0);
  });

  it("joins only demos the profile's own player recorded", () => {
    // fails if another account's recording sits beside these numbers (review of #52)
    const other = "76561197960265729";
    const byId = local(VALVE, { pov: other });
    expect(joinMatches([leetify({ sourceId: code(3900000000000000042n) })], [byId], ME).byFile.size).toBe(0);
    expect(joinMatches([leetify({ sourceId: code(3900000000000000042n) })], [byId], other).byFile.get(VALVE)?.rule).toBe("match-id");
  });

  it("lists the dev build's synthetic history as Leetify-only beside the bundled samples, which are no Valve demos", () => {
    const data = parsePayload(syntheticPayload(0, SYNTHETIC_MATCHES));
    const j = joinMatches(data.matches, [base], ME);
    expect(j.byFile.size).toBe(0);
    expect(j.only).toHaveLength(SYNTHETIC_MATCHES.length);
    expect(base.match.pov).toBe(SYNTHETIC_STEAM64);
  });
});
