import { describe, expect, it } from "vitest";
import { contentBox, FULL, square, union } from "./radar-box";

/** A w × h RGBA scan with the given pixels opaque. */
function scanOf(w: number, h: number, drawn: [number, number][]): Uint8ClampedArray {
  const a = new Uint8ClampedArray(w * h * 4);
  for (const [x, y] of drawn) a[(y * w + x) * 4 + 3] = 255;
  return a;
}

describe("contentBox", () => {
  it("scales the drawn pixels up to radar pixels", () => {
    // a 4 × 4 scan: one scanned pixel is 256 radar pixels; pixel (1, 1) covers 256..512
    expect(contentBox(scanOf(4, 4, [[1, 1]]), 4, 4, 0)).toEqual({ x: 256, y: 256, side: 256 });
  });

  it("pads and centres the square", () => {
    expect(contentBox(scanOf(4, 4, [[1, 1]]), 4, 4, 24)).toEqual({ x: 232, y: 232, side: 304 });
  });

  it("ignores faint edge pixels", () => {
    const a = scanOf(4, 4, [[1, 1]]);
    a[(0 * 4 + 3) * 4 + 3] = 64; // pixel (3, 0) at the alpha threshold
    expect(contentBox(a, 4, 4, 0)).toEqual({ x: 256, y: 256, side: 256 });
  });

  it("is the whole radar when nothing is drawn", () => {
    expect(contentBox(scanOf(4, 4, []), 4, 4)).toEqual(FULL);
  });
});

describe("square", () => {
  it("takes the longer side and centres on the rectangle", () => {
    expect(square(100, 300, 500, 400, 0)).toEqual({ x: 100, y: 150, side: 400 });
  });

  it("moves a square that would leave the radar back inside it", () => {
    expect(square(0, 0, 100, 50, 24)).toEqual({ x: 0, y: 0, side: 148 });
    expect(square(900, 980, 1024, 1024, 0)).toEqual({ x: 900, y: 900, side: 124 });
  });

  it("never grows past the radar", () => {
    expect(square(0, 0, 1024, 1000, 24)).toEqual({ x: 0, y: 0, side: 1024 });
  });
});

describe("union", () => {
  it("covers both boxes", () => {
    expect(union({ x: 0, y: 0, side: 100 }, { x: 500, y: 500, side: 100 })).toEqual({ x: 0, y: 0, side: 600 });
  });
});
