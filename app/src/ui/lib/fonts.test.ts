import { expect, it } from "vitest";
import { hasFont } from "./fonts";

/** A canvas context whose widths come from a table of font strings. */
const ctxOf = (widths: Record<string, number>) => ({ font: "", measureText(this: { font: string }) { return { width: widths[this.font] } as TextMetrics; } });

it("finds a font only when it changes the measured width against the monospace fallback", () => {
  // fails if the check compares the wrong strings, or reads an equal width as an installed font
  expect(hasFont("Bahnschrift", ctxOf({ "30px monospace": 300, '30px "Bahnschrift", monospace': 255 }))).toBe(true);
  expect(hasFont("Bahnschrift", ctxOf({ "30px monospace": 300, '30px "Bahnschrift", monospace': 300 }))).toBe(false);
});

it("assumes the font without a canvas to measure", () => {
  expect(hasFont("Bahnschrift", null)).toBe(true);
});
