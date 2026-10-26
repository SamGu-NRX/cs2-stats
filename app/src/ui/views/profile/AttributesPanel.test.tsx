// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
import { Attribute, type PanelAttribute } from "./AttributesPanel";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it("follows a new ?attr= request and otherwise keeps the user's toggle", () => {
  // fails if the row's open state is read only once (a later ?attr= is ignored) or a re-render resets a toggle
  const a = (open: boolean, score = 50): PanelAttribute => ({ id: "trading", label: "Trading", score, metrics: [], open });
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  const chev = () => host.querySelector<HTMLButtonElement>(".apa__chev")!;
  act(() => root.render(<Attribute a={a(false)} />));
  expect(chev().getAttribute("aria-expanded")).toBe("false");
  act(() => root.render(<Attribute a={a(true)} />));
  expect(chev().getAttribute("aria-expanded")).toBe("true");
  act(() => chev().dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 0 })));
  expect(chev().getAttribute("aria-expanded")).toBe("false");
  act(() => root.render(<Attribute a={a(true, 60)} />));
  expect(chev().getAttribute("aria-expanded")).toBe("false");
});
