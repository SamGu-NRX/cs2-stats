// What the derive pool does when its workers cannot start, and what the stats worker does then
// (derive-pool.ts PoolUnavailable, throughPool).
import { expect, it, vi } from "vitest";
import type { Cached } from "./derive-file";
import { derivePool, PoolUnavailable, throughPool, type DerivePool, type Deriver } from "./derive-pool";

/** Derive workers that never load (as one started from a worker in the desktop app's WebView2), or that load and crash on their first file. */
function derivers(n: number, mode: "never-loads" | "loads-then-crashes"): Deriver[] {
  return Array.from({ length: n }, () => {
    const d: Deriver = {
      onmessage: null,
      onfail: null,
      post(m) {
        if ("init" in m) setTimeout(() => (mode === "never-loads" ? d.onfail?.("failed to load") : d.onmessage?.({ ready: true })), 0);
        if ("job" in m) setTimeout(() => d.onfail?.("boom"), 0);
      },
      close() {},
    };
    return d;
  });
}

it("hands every file back when its workers never start, and fails a file only for a worker that started", async () => {
  // fails if derive workers that could not load make every file a file error: the desktop app then
  // showed no matches and no error, as Sam's install did
  const pool = derivePool(derivers(2, "never-loads"), null, async () => new ArrayBuffer(0));
  const results = await Promise.allSettled(["a", "b", "c"].map((f) => pool.derive(f, undefined)));
  expect(results.map((r) => r.status === "rejected" && r.reason instanceof PoolUnavailable)).toEqual([true, true, true]);
  pool.close();
  // no workers at all (the page could start none): every file comes back too
  const none = derivePool([], null, async () => new ArrayBuffer(0));
  await expect(none.derive("a", undefined)).rejects.toBeInstanceOf(PoolUnavailable);
  // a worker that started and then crashed on a file: that file's error, as before
  const started = derivePool(derivers(1, "loads-then-crashes"), null, async () => new ArrayBuffer(0));
  await new Promise((r) => setTimeout(r, 5));
  const [first] = await Promise.allSettled([started.derive("a", undefined)]);
  expect(first.status === "rejected" && !(first.reason instanceof PoolUnavailable) && String(first.reason)).toContain("a derive worker stopped");
  started.close();
});

it("derives a file the pool hands back in the stats worker, says it did, and keeps a file's own error", async () => {
  // fails if the stats worker passes the pool's PoolUnavailable on as the file's error instead of
  // deriving the file itself, or if it hides a real derive error behind a second try
  const cached = { facts: {}, origin: "here" } as unknown as Cached;
  const here = vi.fn(async () => cached);
  const fellBack = vi.fn();
  const pool = (e: Error): DerivePool => ({ derive: () => Promise.reject(e), close() {} });
  await expect(throughPool(pool(new PoolUnavailable("did not start")), here, fellBack)("a", undefined)).resolves.toBe(cached);
  expect([here.mock.calls, fellBack.mock.calls.length]).toEqual([[["a"]], 1]);
  await expect(throughPool(pool(new Error("never had a side")), here, fellBack)("b", undefined)).rejects.toThrow("never had a side");
  expect([here.mock.calls.length, fellBack.mock.calls.length]).toEqual([1, 1]);
});
