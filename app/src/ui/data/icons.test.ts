import { describe, expect, it } from "vitest";
import { percentilePhrase } from "../components/Percentile";
import { parseIconManifest } from "./icons";

describe("icon pack manifest", () => {
  it("reads the extractor's format", () => {
    const m = parseIconManifest(JSON.stringify({ version: 1, source: "CS2 build 1", icons: { ak47: "weapons/ak47.svg", headshot: "killfeed/headshot.svg" } }));
    expect(m.icons.ak47).toBe("weapons/ak47.svg");
  });
  it("refuses a path that leaves the icons folder", () => {
    expect(() => parseIconManifest(JSON.stringify({ version: 1, icons: { ak47: "../pros.json" } }))).toThrow(/icons\.ak47/);
    expect(() => parseIconManifest(JSON.stringify({ version: 1, icons: { ak47: "C:/Windows/x.svg" } }))).toThrow(/icons\.ak47/);
  });
});

describe("percentile phrase", () => {
  it("never reads Top 0% or Bottom 0%", () => {
    expect(percentilePhrase(99.7, "performance")).toBe("Top 1%");
    expect(percentilePhrase(0.2, "performance")).toBe("Bottom 1%");
    expect(percentilePhrase(70, "performance")).toBe("Top 30%");
    expect(percentilePhrase(63.4, "style")).toBe("63/100");
  });
});
