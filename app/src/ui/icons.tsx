// Small line icons drawn for this app (12-16 px).
import type { RoundHow } from "../stats/schema";

type P = { size?: number };
const svg = (size: number, children: React.ReactNode) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    {children}
  </svg>
);

/** Round end icons: elimination, bomb exploded, bomb defused, time ran out. */
export function HowIcon({ how, size = 12 }: { how: RoundHow; size?: number }) {
  switch (how) {
    case "elim":
      return svg(size, <><path d="M4 4l8 8M12 4l-8 8" /></>);
    case "bomb":
      return svg(size, <><circle cx="8" cy="9" r="4.2" /><path d="M10.6 5.6l1.6-1.6M12.6 3.2l.6-.6" /></>);
    case "defuse":
      return svg(size, <><path d="M3.5 8.5l3 3 6-7" /></>);
    case "time":
      return svg(size, <><circle cx="8" cy="8" r="5.2" /><path d="M8 5v3.2l2 1.3" /></>);
  }
}

export const HOW_TEXT: Record<RoundHow, string> = {
  elim: "elimination", bomb: "bomb exploded", defuse: "bomb defused", time: "time ran out",
};

export const Chevron = ({ size = 12 }: P) => svg(size, <path d="M6 3.5L10.5 8 6 12.5" />);
export const Back = ({ size = 14 }: P) => svg(size, <path d="M10 3.5L5.5 8l4.5 4.5" />);
export const Minus = ({ size = 12 }: P) => svg(size, <path d="M4 8h8" />);
export const Square = ({ size = 12 }: P) => svg(size, <rect x="4" y="4" width="8" height="8" rx="1.5" />);
export const Close = ({ size = 12 }: P) => svg(size, <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" />);
export const Refresh = ({ size = 14 }: P) => svg(size, <><path d="M13 8a5 5 0 1 1-1.6-3.7" /><path d="M13 3v3h-3" /></>);
export const Mark = () => (
  <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden>
    <path d="M3 12V7M6.5 12V4M10 12V8.5M13.5 12V5.5" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" />
  </svg>
);
