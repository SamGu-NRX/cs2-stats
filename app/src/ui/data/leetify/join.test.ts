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

  it("joins by end time, map and score when there is no id to compare", () => {
    // the local match ends 19:20 + 40 min = 20:00; Leetify's ends 20:01
    const j = joinMatches([leetify({})], [local("2026/a.json.gz")], ME);
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
      const j = joinMatches(ls, entries, ME);
      expect(j.byFile.size, what).toBe(0);
      expect(j.only.length, what).toBe(ls.length);
    }
  });

  it("joins by time only on a known end on both sides, within 10 minutes", () => {
    // fails if a match with no recorded length joins on its start, or ends 121 minutes apart still join (review of #52)
    const at = (start: string, durationS: number | null) => joinMatches([leetify({})], [local("2026/a.json.gz", { startedAt: start, durationS })], ME).byFile.size;
    // Leetify's match ended 20:01
    expect(at("2026-10-20T19:20:00.000Z", 2400), "ended 20:00").toBe(1);
    expect(at("2026-10-20T19:20:00.000Z", null), "a start with no length: its end is unknown").toBe(0);
    expect(at("2026-10-20T18:00:00.000Z", null), "121 minutes before Leetify's end, no length").toBe(0);
    expect(at("2026-10-20T17:20:00.000Z", 2400), "ended 18:00, 121 minutes earlier").toBe(0);
    expect(at("2026-10-20T19:31:00.000Z", 2400), "ended 20:11, 10 minutes later").toBe(1);
    expect(at("2026-10-20T19:32:00.000Z", 2400), "ended 20:12, 11 minutes later").toBe(0);
  });

  it("never joins by time a pair whose Valve match ids are both known and differ", () => {
    // fails if the time rule overrides an id that says these are two matches (review of #52)
    const e = local(VALVE, { startedAt: "2026-10-20T19:20:00.000Z", durationS: 2400 });
    expect(joinMatches([leetify({ sourceId: code(3900000000000000077n) })], [e], ME).byFile.size).toBe(0);
    // with no id on Leetify's side, the time rule may still join it
    expect(joinMatches([leetify({ sourceId: null })], [e], ME).byFile.get(VALVE)?.rule).toBe("time");
  });

  it("joins only demos the profile's own player recorded, by either rule", () => {
    // fails if another account's recording sits beside these numbers (review of #52)
    const other = "76561197960265729";
    const byId = local(VALVE, { pov: other });
    expect(joinMatches([leetify({ sourceId: code(3900000000000000042n) })], [byId], ME).byFile.size).toBe(0);
    expect(joinMatches([leetify({})], [local("2026/a.json.gz", { pov: other })], ME).byFile.size).toBe(0);
    expect(joinMatches([leetify({})], [local("2026/a.json.gz", { pov: other })], other).byFile.size).toBe(1);
  });

  it("joins the dev build's synthetic history to the bundled sample it was written for", () => {
    // fails if the sample or the synthetic data drift apart, which would empty the screenshots' match card
    const data = parsePayload(syntheticPayload(0, SYNTHETIC_MATCHES));
    const j = joinMatches(data.matches, [base], ME);
    expect(j.byFile.get(base.file)?.match.id).toBe(SYNTHETIC_MATCHES[0].id);
    expect(j.only).toHaveLength(SYNTHETIC_MATCHES.length - 1);
    expect(base.match.pov).toBe(SYNTHETIC_STEAM64);
  });
});
