import { describe, expect, it } from "vitest";
import { nextSort, sortRows } from "./sort";

describe("sortRows", () => {
  const rows = [
    { n: "b", v: 2 }, { n: "a", v: null }, { n: "c", v: 5 }, { n: "d", v: 2 }, { n: "e", v: Number.NaN },
  ];
  it("sorts numbers descending with missing values last", () => {
    expect(sortRows(rows, (r) => r.v, "desc").map((r) => r.n)).toEqual(["c", "b", "d", "a", "e"]);
  });
  it("keeps missing values last when ascending", () => {
    expect(sortRows(rows, (r) => r.v, "asc").map((r) => r.n)).toEqual(["b", "d", "c", "a", "e"]);
  });
  it("is stable for ties", () => {
    expect(sortRows(rows, (r) => r.v, "asc").slice(0, 2).map((r) => r.n)).toEqual(["b", "d"]);
  });
  it("sorts text naturally and case-insensitively", () => {
    const names = [{ s: "Player10" }, { s: "player2" }, { s: "Alpha" }];
    expect(sortRows(names, (r) => r.s, "asc").map((r) => r.s)).toEqual(["Alpha", "player2", "Player10"]);
  });
  it("does not mutate the input", () => {
    const copy = [...rows];
    sortRows(rows, (r) => r.v, "asc");
    expect(rows).toEqual(copy);
  });
});

describe("nextSort", () => {
  it("starts a new column in its natural direction and flips the current one", () => {
    expect(nextSort(null, "adr", "desc")).toEqual({ key: "adr", dir: "desc" });
    expect(nextSort({ key: "adr", dir: "desc" }, "adr", "desc")).toEqual({ key: "adr", dir: "asc" });
    expect(nextSort({ key: "adr", dir: "asc" }, "name", "asc")).toEqual({ key: "name", dir: "asc" });
  });
});
