import { expect, it } from "vitest";
import { CS2RB } from "../../../stats/model-params";
import { metaOf } from "../../../worker/views";
import { metric, setMeta } from "../../data/meta";
import { AIM_TIP } from "./tips";

it("keeps every aim tooltip to one sentence of twelve words or fewer, each on a real engine metric", () => {
  // fails if a tip grows past the text diet or names a metric id the engine does not have
  setMeta(metaOf(CS2RB));
  for (const [id, tip] of Object.entries(AIM_TIP)) {
    expect(() => metric(id), id).not.toThrow();
    expect(tip.split(/\s+/).length, id).toBeLessThanOrEqual(12);
    expect(tip.match(/[.!?](\s|$)/g)?.length ?? 0, id).toBeLessThanOrEqual(1);
  }
});
