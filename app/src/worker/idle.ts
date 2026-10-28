// Work the stats worker does only when it has nothing else to do: no call running, and none for
// `quietMs`. A call that starts first postpones it, so it never delays an answer a view is waiting on.

export interface Idle {
  /** a call started */
  begin(): void;
  /** a call ended */
  end(): void;
  /** runs `work` once the worker is idle; a later `then` replaces work not yet started */
  then(work: () => void): void;
  /** drops work not yet started */
  cancel(): void;
}

/**
 * One macrotask turn: a call posted to the worker in the meantime runs before this resolves. A
 * MessageChannel message, since setTimeout clamps nested calls to 4 ms.
 */
export function macrotask(): Promise<void> {
  return new Promise((resolve) => {
    const c = new MessageChannel();
    c.port1.onmessage = () => { c.port1.close(); resolve(); };
    c.port2.postMessage(null);
  });
}

export function idle(quietMs: number, timers: { set: (f: () => void, ms: number) => unknown; clear: (t: unknown) => void } = { set: (f, ms) => setTimeout(f, ms), clear: (t) => clearTimeout(t as number) }): Idle {
  let running = 0;
  let next: (() => void) | null = null;
  let timer: unknown = null;
  const arm = () => {
    if (timer !== null) { timers.clear(timer); timer = null; }
    if (running || !next) return;
    timer = timers.set(() => {
      timer = null;
      const work = next;
      next = null;
      work?.();
    }, quietMs);
  };
  return {
    begin() { running++; if (timer !== null) { timers.clear(timer); timer = null; } },
    end() { running = Math.max(0, running - 1); arm(); },
    then(work) { next = work; arm(); },
    cancel() { next = null; arm(); },
  };
}

/**
 * Reads an opened match's tool tables once the worker is idle. Every open replaces what an earlier one
 * queued, a plugin file's included (its tables are quick to build when a tab asks, so it queues
 * nothing), and the read runs only if no other match was opened since and the file's facts key is the
 * one it had when opened: a read queued for match A must not land after match B opened, or B's first
 * tool call would read B's tables again.
 */
export function readWhenIdle(q: Idle, keyOf: (file: string) => string | undefined, read: (file: string) => void): (file: string, folder: boolean) => void {
  let opened = 0;
  return (file, folder) => {
    const mine = ++opened;
    if (!folder) return q.cancel();
    const key = keyOf(file);
    q.then(() => { if (mine === opened && key !== undefined && keyOf(file) === key) read(file); });
  };
}
