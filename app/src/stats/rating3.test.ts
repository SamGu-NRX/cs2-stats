// Rating 3.02 must reproduce the rating agent's reference implementation (model/rating3/golden.json:
// HLTV's own inputs for 30 player-maps, and the reference model's output for them).
import { expect, it } from "vitest";
import golden from "../../../model/rating3/golden.json";
import { rating3FromInputs } from "./rating3";

it("reproduces the reference rating for every golden player-map", () => {
  const off = golden
    .map((g) => {
      const q = { kpr_eco: g.inputs.kpr, adr_eco: g.inputs.adr, dpr_eco: g.inputs.dpr, kast_eco: g.inputs.kast, mk: g.inputs.mk, swing: g.inputs.swing };
      return { who: `${g.map} ${g.player}`, ours: rating3FromInputs(q), ref: g.reference };
    })
    .filter((x) => Math.abs(x.ours - x.ref) > 1e-9);
  expect(off).toEqual([]);
});
