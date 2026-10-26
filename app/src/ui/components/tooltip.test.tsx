// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
import { TooltipLayer } from "./overlay";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// not in jsdom; the layer only reads its pointerType
globalThis.PointerEvent ??= class extends MouseEvent {} as unknown as typeof PointerEvent;

it("renders the tooltip outside the app's layout, as one block of text", () => {
  // fails if the layer renders inside a grid or flex parent (whose rules can split it into columns),
  // or the text goes in as markup instead of one text node
  const host = document.body.appendChild(document.createElement("div"));
  host.style.display = "grid";
  const root = createRoot(host);
  act(() => root.render(<><button data-tip={"First line.\nSecond line."}>x</button><TooltipLayer /></>));
  const tip = document.getElementById("app-tip")!;
  expect(tip.parentElement).toBe(document.body);
  act(() => host.querySelector("button")!.focus());
  expect(tip.classList.contains("is-on")).toBe(true);
  expect(tip.childNodes).toHaveLength(1);
  expect(tip.firstChild!.nodeType).toBe(Node.TEXT_NODE);
  expect(tip.textContent).toBe("First line.\nSecond line.");
  act(() => root.unmount());
});
