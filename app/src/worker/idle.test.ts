// Work the stats worker defers until it is idle (idle.ts).
import { expect, it, vi } from "vitest";
import { idle, readWhenIdle } from "./idle";

it("runs queued work once, only after the quiet time with no call running", () => {
  // fails if the background table read can start while a view is waiting on an answer, or runs twice
  vi.useFakeTimers();
  try {
    const q = idle(150);
    const work = vi.fn();
    q.begin();
    q.then(work);
    vi.advanceTimersByTime(1000);
    expect(work).not.toHaveBeenCalled();
    q.end();
    vi.advanceTimersByTime(100);
    // a call within the quiet time puts it off again
    q.begin();
    vi.advanceTimersByTime(500);
    q.end();
    vi.advanceTimersByTime(149);
    expect(work).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(work).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(1000);
    expect(work).toHaveBeenCalledOnce();
    // a later match replaces work not yet started
    const first = vi.fn(), second = vi.fn();
    q.then(first);
    q.then(second);
    vi.advanceTimersByTime(150);
    expect([first.mock.calls.length, second.mock.calls.length]).toEqual([0, 1]);
  } finally {
    vi.useRealTimers();
  }
});

it("reads only the match opened last, and nothing for a plugin file opened after an extracted one", () => {
  // fails if a read queued for extracted match A still runs after plugin match B opened (it would load
  // A's tables as the open match, and B's first tool call would read B's again), after another match
  // opened, or after a sync changed A's facts key
  vi.useFakeTimers();
  try {
    const keys: Record<string, string> = { A: "kA", B: "kB", C: "kC" };
    const read = vi.fn();
    const open = readWhenIdle(idle(150), (f) => keys[f], read);
    open("A", true);
    open("B", false);
    vi.advanceTimersByTime(1000);
    expect(read).not.toHaveBeenCalled();
    open("A", true);
    open("C", true);
    vi.advanceTimersByTime(150);
    expect(read.mock.calls).toEqual([["C"]]);
    open("A", true);
    keys.A = "kA2";
    vi.advanceTimersByTime(150);
    expect(read.mock.calls).toEqual([["C"]]);
    // picking a player opens the same match again: one read
    open("A", true);
    open("A", true);
    vi.advanceTimersByTime(150);
    expect(read.mock.calls).toEqual([["C"], ["A"]]);
  } finally {
    vi.useRealTimers();
  }
});
