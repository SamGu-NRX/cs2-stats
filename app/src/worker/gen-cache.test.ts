// Answers kept within one generation of the worker's match index (gen-cache.ts).
import { expect, it } from "vitest";
import { genCache } from "./gen-cache";

it("keeps an answer only while the generation it was asked in holds until it settles", async () => {
  // fails if an answer started before a sync changed the index is kept and handed to later questions,
  // or if an answer is worked out again within one generation
  let gen = 1;
  let runs = 0;
  const cache = genCache<string>(8, () => gen);
  const run = (v: string) => async () => { runs++; return v; };
  expect(await cache.get("q", run("a"))).toBe("a");
  expect(await cache.get("q", run("ignored"))).toBe("a");
  expect(runs).toBe(1);
  // a sync lands while the next answer is being worked out
  let finish!: (v: string) => void;
  gen = 2;
  const pending = cache.get("q2", () => new Promise((r) => { finish = r; }));
  gen = 3;
  finish("mixed");
  expect(await pending).toBe("mixed");
  await Promise.resolve();
  expect(await cache.get("q2", run("fresh"))).toBe("fresh");
  // a failed answer is not kept either
  await expect(cache.get("q3", async () => { throw new Error("no"); })).rejects.toThrow("no");
  await Promise.resolve();
  expect(await cache.get("q3", run("ok"))).toBe("ok");
});
