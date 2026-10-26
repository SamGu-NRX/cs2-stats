// Small marks shared by the match tabs. Game objects (weapons, grenades, round ends, kill flags) are
// icons/game.tsx's, drawn by the CS2 icon pack.
export { TradingIcon as TradingGlyph, UtilityIcon as UtilityGlyph, SnipingIcon as AimGlyph } from "../../icons/attributes";

/** The "?" after a panel title: the panel's explanation, one short sentence, on hover and focus. */
export function Hint({ tip }: { tip: string }) {
  return <span className="hint" data-tip={tip} tabIndex={0} role="note" aria-label={tip}>?</span>;
}
