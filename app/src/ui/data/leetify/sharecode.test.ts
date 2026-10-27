import { describe, expect, it } from "vitest";
import { decodeShareCode, encodeShareCode, valveMatchId } from "./sharecode";

describe("share codes", () => {
  it("decodes csgo-sharecode's published example to its published ids", () => {
    // fails if the byte order or the alphabet is wrong, which would join no match or the wrong one
    expect(decodeShareCode("CSGO-GADqf-jjyJ8-cSP2r-smZRo-TO2xK")).toEqual({ matchId: 3230642215713767580n, reservationId: 3230647599455273103n, tvPort: 55788 });
  });

  it("encodes back to the same code", () => {
    const ids = { matchId: 3900000000000000042n, reservationId: 3900000000000500042n, tvPort: 27042 };
    const code = encodeShareCode(ids);
    expect(code).toMatch(/^CSGO(-[A-Za-z0-9]{5}){5}$/);
    expect(decodeShareCode(code)).toEqual(ids);
    expect(encodeShareCode(decodeShareCode("CSGO-GADqf-jjyJ8-cSP2r-smZRo-TO2xK")!)).toBe("CSGO-GADqf-jjyJ8-cSP2r-smZRo-TO2xK");
  });

  it("reads nothing from text that is not a share code", () => {
    // FACEIT ids and empty values share the data_source_match_id field
    for (const s of ["", "1-0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d", "CSGO-GADqf-jjyJ8-cSP2r-smZRo", "CSGO-GADqf-jjyJ8-cSP2r-smZRo-TO2x0", "csgo-GADqf-jjyJ8-cSP2r-smZRo-TO2xK"]) {
      expect(decodeShareCode(s), s).toBeNull();
    }
  });

  it("reads the Valve match id from a Valve match's file path only", () => {
    expect(valveMatchId("valve/match730_003900000000000000042_0000027042_100/v-1.13.0-0a1b2c3d")).toBe(3900000000000000042n);
    for (const f of ["valve/sentinel-demo/v1", "2026/20261024T223834Z_de_dust2_abe5d91c.json.gz", "dev/match730_003900000000000000042_1_1/v1", "valve/match730_x_1_1/v1"]) {
      expect(valveMatchId(f), f).toBeNull();
    }
  });
});
