// The import's state outlives the page that started it, and only one import runs at a time.
import { expect, it } from "vitest";
import type { ValveImport, ValveProgress } from "./host";
import { importStore } from "./import-store";

const OK: ValveImport = { code: 0, summary: null, error: null };

/** A run the test finishes by hand, reporting progress through `step`. */
function manualRun() {
  let step: (p: ValveProgress) => void = () => {};
  let finish: (r: ValveImport) => void = () => {};
  const run = (onProgress: (p: ValveProgress) => void) => new Promise<ValveImport>((resolve) => { step = onProgress; finish = resolve; });
  return { run, step: (p: ValveProgress) => step(p), finish: (r: ValveImport) => finish(r) };
}

it("refuses a second import while one runs, and a page mounted later sees it run and end", async () => {
  // fails if a second press starts another importer, or Settings forgets a running import after navigating
  // away and back (review of #29)
  const m = manualRun();
  const store = importStore(m.run, async () => ({ running: false, at: null, last: null }));
  const first = store.subscribe(() => {});
  const started = store.start();
  m.step({ event: "start", i: 2, n: 6, demo: "b.dem" });
  await expect(store.start()).rejects.toThrow(/already running/);
  first(); // the Settings page that pressed the button is gone
  const seen: boolean[] = [];
  store.subscribe(() => seen.push(store.get().running)); // Settings mounted again
  expect(store.get()).toMatchObject({ running: true, at: { i: 2, n: 6 } });
  m.finish(OK);
  await started;
  expect(store.get()).toMatchObject({ running: false, last: OK });
  expect(seen.at(-1)).toBe(false);
});

it("drops a state answer sent before an import started, so it cannot report the import idle", async () => {
  // fails if a superseded idle answer clears a running import (review of #29)
  let answer: (q: Awaited<ReturnType<Parameters<typeof importStore>[1]>>) => void = () => {};
  const m = manualRun();
  const store = importStore(m.run, () => new Promise((r) => { answer = r; }));
  const following = store.sync(); // the page mounts and asks the backend
  const started = store.start(); // the user presses the button before the answer is in
  answer({ running: false, at: null, last: null }); // the answer, from before the import
  await following;
  expect(store.get().running).toBe(true);
  m.finish(OK);
  await started;
  expect(store.get()).toMatchObject({ running: false, last: OK });
});

it("tells the app an import ended even when no page is subscribed, so it can rescan", async () => {
  // fails if an import that ends while you are on another page leaves the match list stale (review of #29)
  const m = manualRun();
  const store = importStore(m.run, async () => ({ running: false, at: null, last: null }));
  let rescans = 0;
  store.onFinish(() => rescans++); // the app shell, not a page
  const page = store.subscribe(() => {});
  const started = store.start();
  page(); // Settings is left
  m.finish(OK);
  await started;
  expect(rescans).toBe(1);
});

it("follows an import the backend runs that this page did not start, to its end", async () => {
  // fails if a page opened during an import (a reload) shows the button as idle
  const states = [
    { running: true, at: { event: "start" as const, i: 1, n: 2, demo: "a.dem" }, last: null },
    { running: true, at: { event: "start" as const, i: 2, n: 2, demo: "b.dem" }, last: null },
    { running: false, at: { event: "done" as const, i: 2, n: 2, demo: "b.dem", ok: true }, last: OK },
  ];
  const store = importStore(async () => OK, async () => states.shift()!, 1);
  const following = store.sync();
  await new Promise((r) => setTimeout(r, 0)); // the first answer is in
  expect(store.get()).toMatchObject({ running: true, at: { i: 1 } });
  await expect(store.start()).rejects.toThrow(/already running/);
  await following;
  expect(store.get()).toMatchObject({ running: false, last: OK, at: { i: 2 } });
});
