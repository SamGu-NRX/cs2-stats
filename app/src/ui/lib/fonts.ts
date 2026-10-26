// Whether a system font is installed. document.fonts.check cannot answer this: it returns true for any
// family the page did not load itself, installed or not. So measure: a string set in the family with a
// monospace fallback is a different width from the same string in monospace alone only when the
// family exists.

const PROBE = "0123456789.%mwWil";

export function hasFont(family: string, ctx: Pick<CanvasRenderingContext2D, "font" | "measureText"> | null = document.createElement("canvas").getContext("2d")): boolean {
  // without a canvas there is nothing to measure; assume the font, which keeps the designed look
  if (!ctx) return true;
  ctx.font = "30px monospace";
  const base = ctx.measureText(PROBE).width;
  ctx.font = `30px "${family}", monospace`;
  return ctx.measureText(PROBE).width !== base;
}
