// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import { AttrRadar } from "./charts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const labels = ["A", "B", "C", "D", "E", "F"];

function draw(other: number[], instant: boolean) {
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  act(() => root.render(<AttrRadar labels={labels} you={[50, 50, 50, 50, 50, 50]} other={other} size={260} instant={instant} />));
  const path = host.querySelector<SVGPathElement>(".radar__other")!;
  return { path, rerender: (o: number[], i: boolean) => act(() => root.render(<AttrRadar labels={labels} you={[50, 50, 50, 50, 50, 50]} other={o} size={260} instant={i} />)) };
}

describe("AttrRadar morph", () => {
  it("draws the other player's shape as one M and five L commands, so `d` can interpolate between picks", () => {
    // fails if the shape's command structure changes between picks (the transition would then jump)
    const { path, rerender } = draw([100, 0, 0, 0, 0, 0], false);
    const shape = (d: string) => d.replace(/[\d.-]+/g, "n");
    const first = path.getAttribute("d")!;
    rerender([10, 20, 30, 40, 50, 60], false);
    expect(shape(path.getAttribute("d")!)).toBe(shape(first));
    expect(shape(first)).toBe("Mn nLn nLn nLn nLn nLn nZ");
    // R = size / 2 - 62 = 68, so 100 on the first (top) axis sits 68 px above the centre
    expect(first.startsWith("M130.00 62.00")).toBe(true);
  });

  it("swaps the shape without the transition on a keyboard pick", () => {
    // fails if a keyboard selection animates
    const { path, rerender } = draw([50, 50, 50, 50, 50, 50], false);
    expect(path.classList.contains("is-instant")).toBe(false);
    rerender([60, 60, 60, 60, 60, 60], true);
    expect(path.classList.contains("is-instant")).toBe(true);
  });
});
