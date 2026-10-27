import { describe, expect, it } from "vitest";
import { mapLimit } from "./map-limit";

/** Resolves when `release(i)` is called, so a test decides the order calls finish in. */
function gates(n: number) {
  const open: (() => void)[] = [];
  const wait = Array.from({ length: n }, (_, i) => new Promise<void>((r) => { open[i] = r; }));
  return { wait, release: (i: number) => open[i]() };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

describe("mapLimit", () => {
  it("returns results in the items' order when calls finish in reverse", async () => {
    const g = gates(5);
    const p = mapLimit([0, 1, 2, 3, 4], 5, async (x) => { await g.wait[x]; return x * 10; });
    for (const i of [4, 3, 2, 1, 0]) { g.release(i); await tick(); }
    expect(await p).toEqual([0, 10, 20, 30, 40]);
  });

  it("never has more than `limit` calls in flight, and starts the next as one ends", async () => {
    const g = gates(6);
    let live = 0, most = 0;
    const started: number[] = [];
    const p = mapLimit([0, 1, 2, 3, 4, 5], 2, async (x) => {
      started.push(x);
      most = Math.max(most, ++live);
      await g.wait[x];
      live--;
      return x;
    });
    await tick();
    expect(started).toEqual([0, 1]);
    g.release(1);
    await tick();
    expect(started).toEqual([0, 1, 2]);
    for (const i of [0, 2, 3, 4, 5]) { g.release(i); await tick(); }
    expect(await p).toEqual([0, 1, 2, 3, 4, 5]);
    expect(most).toBe(2);
  });

  it("with a limit of 1 runs one call after another", async () => {
    const order: string[] = [];
    await mapLimit(["a", "b", "c"], 1, async (x) => { order.push(`start ${x}`); await tick(); order.push(`end ${x}`); });
    expect(order).toEqual(["start a", "end a", "start b", "end b", "start c", "end c"]);
  });

  it("refuses a limit that is not a whole number of at least 1", async () => {
    await expect(mapLimit([1], 0, async (x) => x)).rejects.toThrow(/at least 1, not 0/);
  });
});
