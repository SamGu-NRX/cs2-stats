import { describe, expect, it } from "vitest";
import type { RoundTimeline } from "../stats/replay";
import { createReplayClient, type WorkerLike } from "./replay-client";
import type { ReplayFromWorker, ReplayToWorker } from "./replay-protocol";

/** A stand-in worker that records what it is sent and answers when told. */
class FakeWorker implements WorkerLike {
  sent: ReplayToWorker[] = [];
  terminated = false;
  onmessage: WorkerLike["onmessage"] = null;
  onerror: WorkerLike["onerror"] = null;
  onmessageerror: WorkerLike["onmessageerror"] = null;
  postMessage(m: ReplayToWorker) { this.sent.push(m); }
  terminate() { this.terminated = true; }
  reply(m: ReplayFromWorker) { this.onmessage!(new MessageEvent("message", { data: m })); }
}

const tl = (round: number) => ({ round }) as RoundTimeline;

function setup() {
  const workers: FakeWorker[] = [];
  const client = createReplayClient({ read: async () => new ArrayBuffer(0) }, () => { const w = new FakeWorker(); workers.push(w); return w; });
  return { client, workers };
}

describe("replay client", () => {
  it("starts no worker until a round is asked for, then one for every round", () => {
    const { client, workers } = setup();
    expect(workers).toHaveLength(0);
    void client.round("dev/a", 1);
    void client.round("dev/a", 2);
    expect(workers).toHaveLength(1);
    expect(workers[0].sent).toEqual([{ id: 1, file: "dev/a", round: 1 }, { id: 2, file: "dev/a", round: 2 }]);
  });

  it("keeps a built round, so asking again sends nothing", async () => {
    const { client, workers } = setup();
    const p = client.round("dev/a", 1);
    workers[0].reply({ id: 1, result: tl(1) });
    expect(await p).toEqual(tl(1));
    expect(await client.round("dev/a", 1)).toEqual(tl(1));
    expect(workers[0].sent).toHaveLength(1);
  });

  it("on dispose: rejects what is pending, terminates the worker and empties the cache", async () => {
    const { client, workers } = setup();
    const done = client.round("dev/a", 1);
    workers[0].reply({ id: 1, result: tl(1) });
    await done;
    const pending = client.round("dev/a", 2);
    client.dispose();
    await expect(pending).rejects.toThrow("The replay closed");
    expect(workers[0].terminated).toBe(true);
    // the next request starts a new worker and builds the round again
    void client.round("dev/a", 1);
    expect(workers).toHaveLength(2);
    expect(workers[1].sent).toEqual([{ id: 3, file: "dev/a", round: 1 }]);
  });

  it("does not answer a disposed worker's request for file bytes", async () => {
    let release!: (b: ArrayBuffer) => void;
    const workers: FakeWorker[] = [];
    const client = createReplayClient({ read: () => new Promise((r) => { release = r; }) }, () => { const w = new FakeWorker(); workers.push(w); return w; });
    client.round("dev/a", 1).catch(() => undefined);
    workers[0].reply({ rid: 1, need: "dev/a" });
    client.dispose();
    release(new ArrayBuffer(4));
    await new Promise((r) => setTimeout(r, 0));
    expect(workers[0].sent).toEqual([{ id: 1, file: "dev/a", round: 1 }]);
  });
});
