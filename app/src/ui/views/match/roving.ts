// One tab stop for a row of items (the rounds of a chart, a strip of openings): Tab enters at the last
// item focused, the arrows step and wrap, Home and End jump (controls.tsx rovingIndex). Handled keys
// stop here, so the Rounds tab's own arrow keys, which step the open round, do not fire as well.
import { useRef, useState, type KeyboardEvent } from "react";
import { rovingIndex } from "../../components/controls";

export function useRoving(n: number) {
  const [at, setAt] = useState(0);
  const els = useRef<(HTMLElement | SVGElement | null)[]>([]);
  const cur = Math.max(0, Math.min(at, n - 1));
  return {
    onKeyDown(e: KeyboardEvent) {
      const to = rovingIndex(e.key, cur, n, false);
      if (to === null) return;
      e.preventDefault();
      e.stopPropagation();
      setAt(to);
      els.current[to]?.focus();
    },
    /** props for item i: its ref, its tab stop, and focus moving the stop to it */
    item: (i: number) => ({
      ref: (el: HTMLElement | SVGElement | null) => { els.current[i] = el; },
      tabIndex: i === cur ? 0 : -1,
      onFocus: () => setAt(i),
    }),
  };
}
