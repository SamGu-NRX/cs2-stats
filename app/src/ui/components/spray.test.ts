import { describe, expect, it } from "vitest";
import { RECOIL } from "../../stats/aim-ref";
import { meanPath, sprayFinding, type PlayerPath } from "./SprayPath";

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
