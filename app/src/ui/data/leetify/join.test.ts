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
/** The sample as another local match: a different file, start, length, map or score. */
function local(file: string, over: { startedAt?: string | null; durationS?: number | null; map?: string; us?: number; them?: number } = {}): MatchEntry {
  return {
    ...base, file,
    match: { ...base.match, startedAt: over.startedAt === undefined ? "2026-10-20T19:20:00.000Z" : over.startedAt, durationS: over.durationS === undefined ? 2400 : over.durationS, map: over.map ?? "de_mirage" },
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
    const j = joinMatches([l, leetify({ id: "b", sourceId: code(3900000000000000043n), map: "de_inferno" })], [e]);
    expect(j.byFile.get(VALVE)).toEqual({ match: l, rule: "match-id" });
    expect(j.only.map((x) => x.id)).toEqual(["b"]);
  });

  it("joins by end time, map and score when there is no id to compare", () => {
    // the local match ends 19:20 + 40 min = 20:00; Leetify's ends 20:01
    const j = joinMatches([leetify({})], [local("2026/a.json.gz")]);
    expect(j.byFile.get("2026/a.json.gz")?.rule).toBe("time");
    expect(j.only).toEqual([]);
  });

  it("refuses a time join that is loose or ambiguous", () => {
    // fails if one match's numbers can land beside another's
    const l = leetify({});
    const cases: [string, MatchEntry[], LeetifyMatch[]][] = [
      ["ended 11 minutes apart", [local("2026/a.json.gz", { durationS: 2400 - 660 + 60 })], [l]],
      ["another map", [local("2026/a.json.gz", { map: "de_dust2" })], [l]],
      ["another score", [local("2026/a.json.gz", { us: 9, them: 13 })], [l]],
      ["a date but no clock time", [local("2026/a.json.gz", { startedAt: null })], [l]],
      ["two local candidates", [local("2026/a.json.gz"), local("2026/b.json.gz", { startedAt: "2026-10-20T19:22:00.000Z", durationS: 2300 })], [l]],
      ["two Leetify matches want one local match", [local("2026/a.json.gz")], [l, leetify({ id: "l2", finished: "2026-10-20T19:59:00.000Z" })]],
      ["a pro demo", [local("dev/pro-demo")], [l]],
    ];
    for (const [what, entries, ls] of cases) {
      const j = joinMatches(ls, entries);
      expect(j.byFile.size, what).toBe(0);
      expect(j.only.length, what).toBe(ls.length);
    }
  });

  it("without a duration, joins a local match that started up to 3 hours before Leetify's end", () => {
    expect(joinMatches([leetify({})], [local("2026/a.json.gz", { durationS: null })]).byFile.size).toBe(1);
    expect(joinMatches([leetify({})], [local("2026/a.json.gz", { durationS: null, startedAt: "2026-10-20T16:59:00.000Z" })]).byFile.size).toBe(0);
    expect(joinMatches([leetify({})], [local("2026/a.json.gz", { durationS: null, startedAt: "2026-10-20T20:02:00.000Z" })]).byFile.size).toBe(0);
  });

  it("joins the dev build's synthetic history to the bundled sample it was written for", () => {
    // fails if the sample or the synthetic data drift apart, which would empty the screenshots' match card
    const data = parsePayload(syntheticPayload(0, SYNTHETIC_MATCHES));
    const j = joinMatches(data.matches, [base]);
    expect(j.byFile.get(base.file)?.match.id).toBe(SYNTHETIC_MATCHES[0].id);
    expect(j.only).toHaveLength(SYNTHETIC_MATCHES.length - 1);
    expect(base.match.pov).toBe(SYNTHETIC_STEAM64);
  });
});
