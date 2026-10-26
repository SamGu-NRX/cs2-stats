import { describe, expect, it } from "vitest";
import { CS2RB } from "../../stats/model-params";
import { metaOf } from "../../worker/views";
import { calloutName } from "../lib/callouts";
import { metric, setMeta } from "./meta";
import { AIM_TIP, ATTR_TIP, PANEL_TIP, PROVISIONAL_TIP, TIP } from "./tips";

const words = (s: string) => s.trim().split(/\s+/).length;

describe("tooltips", () => {
  // fails if a tooltip grows past one plain sentence of 12 words, or brings back a middot or a semicolon
  // (the tell of a method or caveat appended to the sentence)
  const all = { ...TIP, ...ATTR_TIP, ...PANEL_TIP, ...AIM_TIP, provisional: PROVISIONAL_TIP };
  it.each(Object.entries(all))("%s is one sentence of 12 words or fewer", (_, tip) => {
    expect(words(tip)).toBeLessThanOrEqual(12);
    expect(tip).not.toMatch(/[·;]/);
    expect(tip).toMatch(/[.!?]$/);
    expect(tip).not.toMatch(/[.!?]\s/);
  });

  it("names only real engine metrics in the aim tooltips", () => {
    // fails if an aim tooltip is keyed by a metric id the engine does not have
    setMeta(metaOf(CS2RB));
    for (const id of Object.keys(AIM_TIP)) expect(() => metric(id), id).not.toThrow();
  });
});

describe("callout names", () => {
  it("reads navigation-mesh names the way the game shows them", () => {
    expect(calloutName("TopofMid")).toBe("Top of Mid");
    expect(calloutName("BombsiteB")).toBe("B Site");
    expect(calloutName("CTSpawn")).toBe("CT Spawn");
  });
  it("passes unknown names through unchanged", () => {
    expect(calloutName("Catwalk")).toBe("Catwalk");
    expect(calloutName("SomeNewPlace")).toBe("SomeNewPlace");
  });
});
