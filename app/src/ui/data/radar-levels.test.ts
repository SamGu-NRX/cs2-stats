import { describe, expect, it } from "vitest";
import { mapInfo, toRadar } from "./maps";
import { hasLevels, levelOf, levelRadarUrl } from "./radar-levels";

// pos_x, pos_y and scale from each map's overview file (data/radar_info/<map>.txt in the mirror
// maps.ts names), read 2026-10-25. These are the known answers the radar transform must use.
const OVERVIEW: Record<string, [number, number, number]> = {
  de_dust2: [-2476, 3239, 4.4],
  de_mirage: [-3230, 1713, 5.0],
  de_inferno: [-2087, 3870, 4.9],
  de_nuke: [-3453, 2887, 7],
  de_overpass: [-4831, 1781, 5.2],
  de_ancient: [-2953, 2164, 5],
  de_anubis: [-2796, 3328, 5.22],
  de_vertigo: [-3168, 1762, 4.0],
  de_train: [-2308, 2078, 4.082077],
};

describe("radar transforms", () => {
  for (const [map, [x, y, scale]] of Object.entries(OVERVIEW)) {
    it(`${map}: the overview file's corners map to the radar's corners`, () => {
      const info = mapInfo(map)!;
      expect([info.posX, info.posY, info.scale, info.size]).toEqual([x, y, scale, 1024]);
      expect(toRadar(info, x, y)).toEqual([0, 0]);
      const [rx, ry] = toRadar(info, x + 1024 * scale, y - 1024 * scale);
      expect(rx).toBeCloseTo(1024, 9);
      expect(ry).toBeCloseTo(1024, 9);
    });
  }

  // Recorded bomb plants (bomb.x, bomb.y of the "planted" rows in the dev pro demos and the Valve
  // matches) must land on the overview file's bombA/bombB marks, which are fractions of the radar.
  // The marks are loading-screen icons placed by hand, so they get 0.07 of the radar's width.
  const PLANTS: [string, "A" | "B", number, number, number, number][] = [
    ["de_dust2", "A", 1103, 2509, 0.80, 0.16],
    ["de_dust2", "B", -1366, 2755, 0.21, 0.12],
    ["de_inferno", "A", 1949, 697, 0.81, 0.69],
    ["de_inferno", "B", 547, 2950, 0.49, 0.22],
    ["de_nuke", "A", 723, -613, 0.58, 0.48],
    ["de_nuke", "B", 567, -1231, 0.58, 0.58],
  ];
  for (const [map, site, x, y, mx, my] of PLANTS) {
    it(`${map}: a recorded ${site} plant lands on the ${site} mark`, () => {
      const [rx, ry] = toRadar(mapInfo(map)!, x, y);
      expect(Math.abs(rx / 1024 - mx)).toBeLessThan(0.07);
      expect(Math.abs(ry / 1024 - my)).toBeLessThan(0.07);
    });
  }
});

describe("radar levels", () => {
  it("splits at each overview file's lower-section boundary", () => {
    expect(levelOf("de_nuke", -495)).toBe("upper");
    expect(levelOf("de_nuke", -495.5)).toBe("lower");
    expect(levelOf("de_vertigo", 11700)).toBe("upper");
    expect(levelOf("de_vertigo", 11699)).toBe("lower");
    expect(levelOf("de_train", -50)).toBe("upper");
    expect(levelOf("de_train", -51)).toBe("lower");
  });

  it("puts Nuke's recorded plants on their floors: A upstairs, B below", () => {
    expect(levelOf("de_nuke", -400)).toBe("upper");
    expect(levelOf("de_nuke", -753)).toBe("lower");
  });

  it("keeps one-radar maps on one level", () => {
    expect(hasLevels("de_dust2")).toBe(false);
    expect(levelOf("de_dust2", -100000)).toBe("upper");
    expect(levelRadarUrl("de_dust2", "lower")).toBe(null);
  });

  it("names the lower radar image beside the upper one", () => {
    expect(levelRadarUrl("de_nuke", "upper")).toMatch(/\/radars\/de_nuke_radar_psd\.png$/);
    expect(levelRadarUrl("de_nuke", "lower")).toMatch(/\/radars\/de_nuke_lower_radar_psd\.png$/);
    expect(levelRadarUrl("de_unknown", "upper")).toBe(null);
  });
});
