// The seven HLTV attributes, one metaphor each, on the 24-unit stroke grid.
import type { AttributeId } from "../data/proPack";
import { Svg, type IconProps } from "./Icon";

/** Firepower: three cartridges standing in a row, the middle one taller. */
export const FirepowerIcon = (p: IconProps) => (
  <Svg {...p}>
    {[[3.5, 6.5], [10, 2.5], [16.5, 6.5]].map(([x, top]) => (
      <g key={x}>
        <path d={`M${x} ${top + 6}C${x} ${top + 3} ${x + 1} ${top + 1.2} ${x + 2} ${top}C${x + 3} ${top + 1.2} ${x + 4} ${top + 3} ${x + 4} ${top + 6}V21H${x}Z`} />
        <path d={`M${x} ${top + 7.5}h4`} />
      </g>
    ))}
  </Svg>
);

/** Entrying: an arrow driving through a doorway, the door leaf swung open. */
export const EntryingIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M8 21V3.5h9V21" />
    <path d="M17 3.5l3.5 1.6v14.3L17 21" />
    <path d="M2 12.25h10.5" />
    <path d="M9.25 9l3.25 3.25-3.25 3.25" />
  </Svg>
);

/** Trading: two arrows passing each other. */
export const TradingIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3.5 8h15.5" />
    <path d="M15.5 4.5L19 8l-3.5 3.5" />
    <path d="M20.5 16H5" />
    <path d="M8.5 12.5L5 16l3.5 3.5" />
  </Svg>
);

/** Opening: a crosshair ring with one tick at 12 o'clock, the first contact (design/shell-and-motion.md). */
export const OpeningIcon = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="13" r="7.5" />
    <path d="M12 2.5v6" />
    <circle cx="12" cy="13" r="1.25" fill="currentColor" stroke="none" />
  </Svg>
);

/** Closing: a shield outline, holding the round to its end. */
export const ClosingIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 2.75l7.5 2.75v6c0 4.6-3.1 8.2-7.5 9.75-4.4-1.55-7.5-5.15-7.5-9.75v-6z" />
  </Svg>
);

/** Sniping: a scope reticle, a ring with four ticks and a centre dot. */
export const SnipingIcon = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="8.25" />
    <path d="M12 3.75v4M12 16.25v4M3.75 12h4M16.25 12h4" />
    <circle cx="12" cy="12" r="1.25" fill="currentColor" stroke="none" />
  </Svg>
);

/** Utility: a frag grenade with its lever and pin ring. */
export const UtilityIcon = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="11" cy="14.75" r="6.25" />
    <path d="M9 8.6V6h4v2.6" />
    <path d="M13 6.75h3.25l2.5 3.75" />
    <circle cx="7" cy="5.5" r="2" />
  </Svg>
);

export const ATTR_ICON: Record<AttributeId, (p: IconProps) => JSX.Element> = {
  firepower: FirepowerIcon, entrying: EntryingIcon, trading: TradingIcon, opening: OpeningIcon,
  closing: ClosingIcon, sniping: SnipingIcon, utility: UtilityIcon,
};

export function AttrIcon({ id, ...p }: IconProps & { id: AttributeId }) {
  const C = ATTR_ICON[id];
  return <C {...p} />;
}
