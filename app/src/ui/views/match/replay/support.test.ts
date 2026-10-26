import { describe, expect, it } from "vitest";
import { NO_MAP_REPLAY, NO_RECORDED_REPLAY, replayUnavailable } from "./support";

describe("replayUnavailable", () => {
  it("replays an extracted match on a calibrated map", () => {
    expect(replayUnavailable("dev/faze-vs-sangal-96360514__m2-nuke", "de_nuke")).toBe(null);
    expect(replayUnavailable("valve/match730_1/v-1.13.0-b4b91c24", "de_dust2")).toBe(null);
  });

  it("refuses a plugin recording", () => {
    expect(replayUnavailable("2026/20261025T000642Z_de_dust2_9b00e592.json.gz", "de_dust2")).toBe(NO_RECORDED_REPLAY);
  });

  it("refuses a map without a radar transform, never fitting one", () => {
    expect(replayUnavailable("dev/some-match__m1-cache", "de_cache")).toBe(NO_MAP_REPLAY);
  });
});
