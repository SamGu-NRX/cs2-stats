// The map art ids the app asks the icon pack for, against the ids scripts/extract-icon-pack.cjs writes.
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { emblemIcon, knownMaps, radarIcon } from "./maps";
import { hasLevels, levelRadarIcon } from "./radar-levels";

const { wantedIcons } = createRequire(import.meta.url)("../../../../scripts/extract-icon-pack.cjs") as {
  wantedIcons: (listing: Map<string, string>) => { category: string; id: string; src: string | null }[];
};

describe("map art in the icon pack", () => {
  it("is exactly what the extractor writes under maps/", () => {
    // fails if a map gains a transform, or a floor, that the extractor never extracts (or the reverse)
    const extracted = wantedIcons(new Map()).filter((w) => w.category === "maps").map((w) => w.id).sort();
    const asked = knownMaps().flatMap((m) => [radarIcon(m), emblemIcon(m), ...(hasLevels(m) ? [levelRadarIcon(m, "lower")] : [])]);
    expect(asked).not.toContain(null);
    expect([...(asked as string[])].sort()).toEqual(extracted);
  });
});
