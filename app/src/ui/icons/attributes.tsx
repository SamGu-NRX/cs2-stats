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

/** Opening: a crosshair with a drop of first blood at its centre. */
export const OpeningIcon = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="6.75" />
    <path d="M12 2v3.5M12 18.5V22M2 12h3.5M18.5 12H22" />
    <path d="M12 8.6c1.35 1.7 2.1 2.9 2.1 4a2.1 2.1 0 0 1-4.2 0c0-1.1.75-2.3 2.1-4z" fill="currentColor" stroke="none" />
  </Svg>
);

/** Closing: a padlock, the round locked shut. */
export const ClosingIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M7.5 10.5V7.75a4.5 4.5 0 0 1 9 0v2.75" />
    <rect x="4.5" y="10.5" width="15" height="10.5" rx="2" />
    <path d="M12 14.5v3" />
  </Svg>
);

/** Sniping: a scope reticle with thick outer posts and a fine centre. */
export const SnipingIcon = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="8.75" />
    <path d="M12 3.25v4.5M12 16.25v4.5M3.25 12h4.5M16.25 12h4.5" strokeWidth="2.25" />
    <path d="M12 9.5v1.25M12 13.25v1.25M9.5 12h1.25M13.25 12h1.25" strokeWidth="1" />
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
