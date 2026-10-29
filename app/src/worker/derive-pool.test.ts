// What the derive pool does with files its workers cannot take (derive-pool.ts PoolOptions.here).
import { afterEach, expect, it, vi } from "vitest";
import type { Cached } from "./derive-file";
import { derivePool, type Deriver } from "./derive-pool";

type Mode = "never-loads" | "loads-then-crashes";

/** Derive workers as the pool reaches them: never loading (as one started from a worker in the desktop app's WebView2), or loading and then crashing on their first file. */
const derivers = (mode: Mode) => (): Deriver => {
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
};

/**
 * The same workers as Worker objects. A pool that starts its workers itself (the one before the page
 * started them) gets these, so this test fails there for what it does with the files, not for how the
 * pool is called.
 */
function stubWorkers(mode: Mode) {
  vi.stubGlobal("Worker", class {
    onmessage: ((ev: MessageEvent) => void) | null = null;
    onerror: ((ev: ErrorEvent) => void) | null = null;
    postMessage(m: object) {
      if ("init" in m) setTimeout(() => (mode === "never-loads" ? this.onerror?.({ message: "failed to load", preventDefault() {} } as ErrorEvent) : this.onmessage?.({ data: { ready: true } } as MessageEvent)), 0);
      if ("job" in m) setTimeout(() => this.onerror?.({ message: "boom", preventDefault() {} } as ErrorEvent), 0);
    }
    terminate() {}
  });
}

afterEach(() => vi.unstubAllGlobals());

const fact = (file: string) => ({ facts: {}, origin: file }) as unknown as Cached;

it("derives the files its workers cannot take in this thread, one at a time, in order", async () => {
  // fails if derive workers that never load turn every file into a file error (the desktop app then
  // showed no matches and no error, as Sam's install did), or if those files are derived side by side
  // while Data & settings says one at a time
  stubWorkers("never-loads");
  let active = 0, most = 0;
  const started: string[] = [];
  const here = async (file: string) => {
    active++;
    most = Math.max(most, active);
    started.push(file);
    await new Promise((r) => setTimeout(r, 5));
    active--;
    return fact(file);
  };
  const fellBack = vi.fn();
  const pool = derivePool(2, null, async () => new ArrayBuffer(0), { deriver: derivers("never-loads"), here, fellBack });
  const settled: string[] = [];
  const all = ["a", "b", "c", "d"].map((f) => pool.derive(f, undefined).then((c) => { settled.push(f); return c.origin; }));
  expect(await Promise.all(all)).toEqual(["a", "b", "c", "d"]);
  expect([started, settled, most, fellBack.mock.calls.length]).toEqual([["a", "b", "c", "d"], ["a", "b", "c", "d"], 1, 4]);
  pool.close();
  // no workers at all: the same
  const none = derivePool(0, null, async () => new ArrayBuffer(0), { deriver: derivers("never-loads"), here, fellBack });
  await expect(none.derive("e", undefined)).resolves.toMatchObject({ origin: "e" });
});

it("keeps the error of a file whose worker had started", async () => {
  // fails if a crash on a file is retried in this thread, hiding the file's own failure
  stubWorkers("loads-then-crashes");
  const here = vi.fn(async (file: string) => fact(file));
  const pool = derivePool(1, null, async () => new ArrayBuffer(0), { deriver: derivers("loads-then-crashes"), here, fellBack() {} });
  await new Promise((r) => setTimeout(r, 5));
  await expect(pool.derive("a", undefined)).rejects.toThrow("a derive worker stopped: boom");
  expect(here).not.toHaveBeenCalled();
  pool.close();
});
