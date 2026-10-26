// The replay's keyboard shortcuts: Space plays and pauses, the arrows change the round, L switches the
// floor, N shows every name. They apply when focus is inside the replay, or on nothing (the page's
// body). A focused button, link, radio, tab or checkbox keeps Space, however it got focus; a control
// that uses the arrows (a radio group, the tab list, the scrubber) keeps them.

export type KeyAction = "toggle" | "prev" | "next" | "floor" | "names";

interface KeyLike { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; defaultPrevented: boolean }

export function keyAction(e: KeyLike, target: Element | null, root: Element | null, levels: boolean): KeyAction | null {
  if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return null;
  const doc = target?.ownerDocument;
  const onNothing = !target || target === doc?.body || target === doc?.documentElement;
  if (!onNothing && !(root && root.contains(target))) return null;
  const el = onNothing ? null : target;
  if (el?.closest("input, textarea, select, [contenteditable='true']")) return null;
  switch (e.key) {
    case " ":
      return el?.closest("button, a[href], [role=radio], [role=tab], [role=checkbox]") ? null : "toggle";
    case "ArrowLeft":
    case "ArrowRight":
      if (el?.closest("[role=radiogroup], [role=tablist], [role=slider]")) return null;
      return e.key === "ArrowLeft" ? "prev" : "next";
    case "l":
    case "L":
      return levels ? "floor" : null;
    case "n":
    case "N":
      return "names";
    default:
      return null;
  }
}
