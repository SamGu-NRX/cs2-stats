import { describe, expect, it } from "vitest";
import { mapInfo, toRadar } from "./maps";

describe("toRadar", () => {
  const d2 = mapInfo("de_dust2")!;
  it("maps the overview's upper-left corner to 0,0", () => {
    expect(toRadar(d2, -2476, 3239)).toEqual([0, 0]);
  });
  it("puts a recorded Dust II mid kill inside the radar", () => {
    const [x, y] = toRadar(d2, -138, 458);
    expect(x).toBeCloseTo(531.4, 1);
    expect(y).toBeCloseTo(632.0, 1);
  });
});
