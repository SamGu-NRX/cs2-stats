// Clip ids (ids.ts): the host recomputes them from a request's demo, player and round
// (src-tauri/src/clips/job.rs clip_id_for), so both sides must give the same id for the same inputs.
import { expect, it } from "vitest";
import { clipId, matchKey } from "./ids";

it("names a Valve match by its demo folder, so re-extraction keeps the id, and matches the host's id", () => {
  // fails if the id moves with the extractor's version folder, or drifts from job.rs's test vector
  expect(matchKey("valve/match730_0001/v-3.1.0-0123abcd")).toBe("valve/match730_0001");
  expect(clipId("valve/match730_0001/v-3.1.0-0123abcd", "76561190000000001", 3)).toBe("c-e3fad9374b01f517-r3");
  expect(clipId("valve/match730_0001/v-3.2.0-89abcdef", "76561190000000001", 3)).toBe("c-e3fad9374b01f517-r3");
  expect(() => clipId("valve/x/v", "1", 0)).toThrow(/round number/);
});
