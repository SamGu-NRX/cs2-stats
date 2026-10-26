import { describe, expect, it } from "vitest";
import type { RoundTimeline } from "../../../../stats/replay";
import { Playback, type FrameClock } from "./playback";

/** A frame clock the test advances by hand: run() fires the queued frame at the given time. */
function fakeClock() {
  let next = 1;
  const queued = new Map<number, (now: number) => void>();
  const clock: FrameClock = {
    request(cb) { const id = next++; queued.set(id, cb); return id; },
    cancel(id) { queued.delete(id); },
  };
  return {
    clock,
    get queued() { return queued.size; },
    run(now: number) {
      const [id, cb] = [...queued][0] ?? [];
      if (!cb) throw new Error("no frame queued");
      queued.delete(id!);
      cb(now);
    },
  };
}

const round = (n: number, duration = 10): RoundTimeline => ({
  round: n, tickRate: 64, zeroTick: 0, duration, endT: duration, winner: null, reason: null,
  players: [], frames: [], kills: [], hits: [], throws: [], effects: [], bomb: [],
});

function setup() {
  const c = fakeClock();
  const log: string[] = [];
  const pb = new Playback(c.clock, () => log.push("clear"), (on) => log.push(on ? "playing" : "paused"));
  pb.paint = () => log.push(`paint ${pb.tl?.round ?? "-"} ${pb.t.toFixed(2)}`);
  return { c, pb, log };
}

describe("Playback", () => {
  it("advances the clock by elapsed time times speed, one frame queued at a time", () => {
    const { c, pb } = setup();
    pb.load(round(1));
    c.run(0);
    pb.play(true);
    pb.speed = 2;
    c.run(1000); // the first frame of a play only stamps the time
    c.run(1100);
    expect(pb.t).toBeCloseTo(0.2, 9);
    expect(c.queued).toBe(1);
  });

  it("stops at the round's end", () => {
    const { c, pb, log } = setup();
    pb.load(round(1, 0.1));
    c.run(0);
    pb.play(true);
    c.run(1000);
    c.run(1200);
    expect(pb.t).toBe(0.1);
    expect(pb.playing).toBe(false);
    expect(log.at(-2)).toBe("paused");
    expect(c.queued).toBe(0);
  });

  it("on a round change while playing: pauses, cancels the queued frame, clears, and resumes on load", () => {
    const { c, pb, log } = setup();
    pb.load(round(1));
    pb.play(true);
    c.run(1000);
    expect(c.queued).toBe(1);
    log.length = 0;
    pb.unload();
    expect(pb.playing).toBe(false);
    expect(pb.tl).toBe(null);
    expect(c.queued).toBe(0);
    expect(log).toEqual(["paused", "clear"]);
    // nothing plays or seeks while no round is loaded
    pb.play(true);
    pb.seek(5);
    expect(pb.playing).toBe(false);
    expect(c.queued).toBe(0);
    pb.load(round(2));
    expect(pb.playing).toBe(true);
    expect(pb.t).toBe(0);
    c.run(2000);
    expect(log.at(-1)).toBe("paint 2 0.00");
  });

  it("does not start playing on load when it was paused at the round change", () => {
    const { pb } = setup();
    pb.load(round(1));
    pb.unload();
    pb.load(round(2));
    expect(pb.playing).toBe(false);
  });

  it("stays stopped when the next round fails to load", () => {
    const { c, pb } = setup();
    pb.load(round(1));
    pb.play(true);
    c.run(1000);
    pb.unload();
    pb.fail();
    expect(c.queued).toBe(0);
    pb.load(round(3));
    expect(pb.playing).toBe(false);
  });

  it("restarts a finished round on play", () => {
    const { c, pb } = setup();
    pb.load(round(1, 1));
    pb.seek(1);
    c.run(0);
    pb.play(true);
    expect(pb.t).toBe(0);
  });

  it("queues nothing and draws nothing after dispose", () => {
    const { c, pb, log } = setup();
    pb.load(round(1));
    pb.play(true);
    pb.dispose();
    expect(c.queued).toBe(0);
    log.length = 0;
    pb.invalidate();
    c.run(5000);
    expect(log).toEqual([]);
  });
});
