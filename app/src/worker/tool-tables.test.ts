// The tables and columns the stats worker reads a match's tools from (tool-tables.ts toolLoad).
import { expect, it } from "vitest";
import { toolLoad } from "./tool-tables";

it("reads every table any tool reads, whole unless every tool reading it names its columns", () => {
  // fails if a tool's table or column is left out of the shared load, or a table read whole by one tool
  // is narrowed for another
  const one = toolLoad(["flashes", "places"]);
  expect([...one.optional].sort()).toEqual(["grenade_events", "grenade_throws", "leaves", "positions"]);
  expect([...one.columns.positions!].sort()).toEqual(["is_alive", "place", "round", "steamid", "tick", "x", "y"]);
  expect(Object.keys(one.columns)).toEqual(["positions"]);
  expect(toolLoad(["headToHead"])).toEqual({ optional: ["grenade_events", "leaves"], columns: {} });
  const all = toolLoad();
  expect([...all.optional].sort()).toEqual(["grenade_events", "grenade_throws", "leaves", "positions"]);
  expect(all.optional).not.toContain("engagement_ticks");
});
