import { describe, expect, it } from "vitest";
import { RECOIL, type RecoilRef } from "../../stats/recoil-ref";
import { landingSource, meanPath, sprayFinding, sprayFrame, sprayStay, type Landing, type PlayerPath } from "./SprayPath";

const ak = RECOIL.ak47;
// A path built from the pro median itself, n sprays per bullet, with an optional pitch offset from bullet `from` on.
const path = (bullets: number, n: number[], offset = 0, from = 99): PlayerPath => {
  const out: PlayerPath = { n: [], dp: [], dy: [] };
  for (let b = 2; b <= bullets; b++) { const [p, y] = ak.path[b - 1]; const k = n[b - 2]; out.n.push(k); out.dp.push((p + (b >= from ? offset : 0)) * k); out.dy.push(y * k); }
  return out;
};

describe("spray finding", () => {
  it("names the first bullet that leaves the pros' middle half, and how", () => {
    expect(sprayFinding(ak, meanPath(path(9, Array(8).fill(10), -2, 5)))).toEqual({ kind: "leaves", bullet: 5, how: "less pull" });
  });
  it("ignores bullets too few sprays reached", () => {
    expect(sprayFinding(ak, meanPath(path(9, [10, 10, 10, 10, 2, 1, 1, 1], -2, 6)))).toEqual({ kind: "inside", bullets: 5 });
  });
});

/** Landing sums from mean points: each bullet's [pitch, yaw] times its spray count. */
const landing = (pts: [number, number][], n: number[], measured = 4, pattern = 0): Landing =>
  ({ n, dp: pts.map(([p], j) => p * n[j]), dy: pts.map(([, y], j) => y * n[j]), measured, pattern });

describe("how far the bullets stayed from bullet 1's point", () => {
  // a four-bullet pattern climbing 1° a bullet: with no pull bullets 2, 3, 4 sit 1°, 2° and 3° away
  const kick: RecoilRef["kick"] = [[0, 0], [-1, 0], [-2, 0], [-3, 0]];
  // bullets 2 to 5 land 0.5°, 1°, 1° and 5° from bullet 1 (3-4-5 triangles)
  const pts: [number, number][] = [[0.3, 0.4], [0, 1], [0.6, 0.8], [3, 4]];

  it("averages the mean points' distances over the bullets the pattern covers, and the pattern over the same bullets", () => {
    // fails if bullet 5 (past the pattern) counts, if the mean is weighted, or if noPull uses other bullets
    const s = sprayStay(landing(pts, [4, 4, 4, 4], 3, 1), kick)!;
    expect(s.mean).toBeCloseTo((0.5 + 1 + 1) / 3, 12);
    expect(s.noPull).toBeCloseTo((1 + 2 + 3) / 3, 12);
    expect([s.to, s.sprays]).toEqual([4, 4]);
  });
  it("leaves out bullets fewer than three sprays reached, from both means", () => {
    const s = sprayStay(landing(pts, [4, 2, 4, 4]), kick)!;
    expect(s.mean).toBeCloseTo((0.5 + 1) / 2, 12);
    expect(s.noPull).toBeCloseTo((1 + 3) / 2, 12);
  });
  it("counts every bullet without a pattern, and has no no-pull figure", () => {
    const s = sprayStay(landing(pts, [4, 4, 4, 4]), null)!;
    expect(s.mean).toBeCloseTo((0.5 + 1 + 1 + 5) / 4, 12);
    expect([s.noPull, s.to]).toEqual([null, 5]);
  });
  it("says nothing when no bullet counts", () => {
    expect(sprayStay(landing(pts, [2, 2, 2, 2]), kick)).toBeNull();
  });
});

describe("landing source", () => {
  it("is measured, estimated or mixed by the sprays of each kind", () => {
    const l = (measured: number, pattern: number) => landing([[0, 0]], [3], measured, pattern);
    expect([landingSource(l(3, 0)), landingSource(l(0, 3)), landingSource(l(2, 1))]).toEqual(["measured", "estimated", "mixed"]);
  });
});

describe("spray frame", () => {
  const inside = (f: ReturnType<typeof sprayFrame>, p: { pitch: number; yaw: number }) => {
    const x = f.x0 - p.yaw * f.s, y = f.y0 + p.pitch * f.s;
    return x >= 0 && x <= 360 && y >= 0 && y <= 360;
  };
  it("fits a pattern and its mirror in a square of whole degrees, bullet 1 in the middle", () => {
    // pitch -10 to 10 and 1.5° of margin each side: 23°, wider than the yaw's 2 × (2 + 1.5)
    const pts = [{ pitch: -10, yaw: 2 }, { pitch: 10, yaw: -2 }];
    const f = sprayFrame(pts);
    expect([f.side, f.s, f.x0, f.y0]).toEqual([23, 360 / 23, 180, 180]);
    expect(pts.every((p) => inside(f, p))).toBe(true);
  });
  it("centres a one-sided path on its own range, never below 8°", () => {
    // a pull from 0 to 4° down: side 8, the range's middle (2°) at the well's middle
    const f = sprayFrame([{ pitch: 4, yaw: 0 }]);
    expect([f.side, f.y0]).toEqual([8, 180 - 2 * (360 / 8)]);
  });
  it("stops at 30° and keeps bullet 1 the margin inside the edge", () => {
    const f = sprayFrame([{ pitch: 50, yaw: 0 }]);
    expect([f.side, f.y0]).toEqual([30, 1.5 * 12]);
  });
});
