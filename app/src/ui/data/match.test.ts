import { describe, expect, it } from "vitest";
import { placeName, placesNamed } from "./match";

describe("place names", () => {
  it("reads the game's callouts in plain words", () => {
    // fails if raw engine identifiers ("TopofMid", "BombsiteB") reach the screen
    expect(["TopofMid", "BombsiteB", "CTSpawn", "TSpawn", "MidDoors", "ExtendedA", "Ramp"].map(placeName))
      .toEqual(["Top of mid", "B site", "CT spawn", "T spawn", "Mid doors", "Extended A", "Ramp"]);
  });
  it("adds up seconds for callouts that read the same", () => {
    // fails if two raw names for one place show as two rows, or one of them is dropped
    expect(placesNamed({ TopofMid: 3, TopOfMid: 2, BombsiteB: 4 })).toEqual({ "Top of mid": 5, "B site": 4 });
  });
});
