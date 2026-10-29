// The page starting derive workers for the stats worker (derive-spawn.ts).
import { expect, it, vi } from "vitest";
import { spawnDerivers } from "./derive-spawn";

it("gives each worker its port, reports a worker that fails or cannot start by index, and stops them all", async () => {
  // fails if a derive worker is started without the port the stats worker reaches it through, or if one
  // that failed to load goes unreported (the stats worker would wait on it instead of deriving itself)
  const made: { posted: unknown[]; onerror: ((e: ErrorEvent) => void) | null; terminate: ReturnType<typeof vi.fn> }[] = [];
  let n = 0;
  const start = () => {
    if (n++ === 2) throw new Error("blocked");
    const w = { posted: [] as unknown[], onerror: null as ((e: ErrorEvent) => void) | null, terminate: vi.fn(), postMessage(m: unknown, t: unknown[]) { this.posted.push([m, t]); } };
    made.push(w);
    return w as unknown as Worker;
  };
  const failed: [number, string][] = [];
  const team = spawnDerivers(3, start, (i, why) => failed.push([i, why]));
  expect(team.ports).toHaveLength(3);
  for (const w of made) {
    const [[m, t]] = w.posted as [[{ port: MessagePort }, MessagePort[]]];
    expect(m.port).toBeInstanceOf(MessagePort);
    expect(t).toEqual([m.port]);
  }
  made[1].onerror?.({ message: "failed to load", preventDefault() {} } as ErrorEvent);
  await new Promise((r) => setTimeout(r, 5));
  expect(failed).toEqual([[1, "failed to load"], [2, "blocked"]]);
  team.stop();
  expect(made.map((w) => w.terminate.mock.calls.length)).toEqual([1, 1]);
  for (const p of team.ports) p.close();
});
