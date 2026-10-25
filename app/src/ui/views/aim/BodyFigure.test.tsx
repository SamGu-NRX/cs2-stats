// The hit figure: eight separate body regions, each shaded by its own share of hits.
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { BodyFigure } from "./BodyFigure";

it("draws head, neck, chest, stomach and both arms and legs as separate regions shaded by their share", () => {
  // fails if a region is merged into another or two regions with different shares get one shade
  const share = { head: 0.3, neck: 0.02, chest: 0.4, stomach: 0.1, leftArm: 0.05, rightArm: 0.08, leftLeg: 0, rightLeg: 0.05 };
  const html = renderToStaticMarkup(<BodyFigure share={share} />);
  const regions = [...html.matchAll(/<path d="[^"]+" fill="([^"]+)"[^>]*><title>([^<]+)<\/title>/g)].map(([, fill, title]) => [title.replace(/ \d+%$/, ""), fill]);
  expect(regions.map(([t]) => t).sort()).toEqual(["Chest", "Head", "Left arm", "Left leg", "Neck", "Right arm", "Right leg", "Stomach"]);
  const fill = Object.fromEntries(regions);
  expect(fill["Left leg"]).toBe("var(--bg2)"); // no hits: the panel colour
  expect(new Set([fill.Chest, fill.Head, fill.Stomach, fill["Right arm"], fill["Left arm"], fill.Neck]).size).toBe(6);
});
