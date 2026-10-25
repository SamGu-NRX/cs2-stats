// Navigation and control icons, 24-unit stroke grid.
import { Svg, type IconProps } from "./Icon";

export const HomeIcon = (p: IconProps) => (
  <Svg {...p}><path d="M3.5 10.5L12 3.5l8.5 7" /><path d="M5.5 9v11.5h13V9" /><path d="M10 20.5v-6h4v6" /></Svg>
);
export const MatchesIcon = (p: IconProps) => (
  <Svg {...p}><rect x="3.5" y="4" width="17" height="16" rx="2" /><path d="M3.5 9.5h17M3.5 15h17M9 4v16" /></Svg>
);
export const ProfileIcon = (p: IconProps) => (
  <Svg {...p}><circle cx="12" cy="8" r="4" /><path d="M4 21c.8-4.4 4-6.5 8-6.5s7.2 2.1 8 6.5" /></Svg>
);
export const AimIcon = (p: IconProps) => (
  <Svg {...p}><circle cx="12" cy="12" r="7.5" /><path d="M12 2.5v5M12 16.5v5M2.5 12h5M16.5 12h5" /><circle cx="12" cy="12" r="1" fill="currentColor" stroke="none" /></Svg>
);
export const SettingsIcon = (p: IconProps) => (
  <Svg {...p}><path d="M4 6.5h16M4 12h16M4 17.5h16" /><circle cx="9" cy="6.5" r="2" fill="var(--bg-side, #1a1817)" /><circle cx="15.5" cy="12" r="2" fill="var(--bg-side, #1a1817)" /><circle cx="7.5" cy="17.5" r="2" fill="var(--bg-side, #1a1817)" /></Svg>
);

export const ChevronIcon = (p: IconProps) => <Svg {...p}><path d="M6 9.5l6 6 6-6" /></Svg>;
export const ChevronRightIcon = (p: IconProps) => <Svg {...p}><path d="M9.5 6l6 6-6 6" /></Svg>;
export const ChevronLeftIcon = (p: IconProps) => <Svg {...p}><path d="M14.5 6l-6 6 6 6" /></Svg>;
export const CloseIcon = (p: IconProps) => <Svg {...p}><path d="M6 6l12 12M18 6L6 18" /></Svg>;
export const SearchIcon = (p: IconProps) => <Svg {...p}><circle cx="10.5" cy="10.5" r="6" /><path d="M15 15l5.5 5.5" /></Svg>;
export const FolderIcon = (p: IconProps) => <Svg {...p}><path d="M3.5 7V18.5a1.5 1.5 0 0 0 1.5 1.5h14a1.5 1.5 0 0 0 1.5-1.5v-9A1.5 1.5 0 0 0 19 8h-7.5l-2-3H5A1.5 1.5 0 0 0 3.5 6.5" /></Svg>;
export const UploadIcon = (p: IconProps) => <Svg {...p}><path d="M12 15.5V4M7.5 8.5L12 4l4.5 4.5" /><path d="M4 15v4.5h16V15" /></Svg>;
export const RefreshIcon = (p: IconProps) => <Svg {...p}><path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3" /><path d="M19.5 4.5v4h-4" /></Svg>;
export const KeyboardIcon = (p: IconProps) => <Svg {...p}><rect x="2.5" y="6" width="19" height="12" rx="2" /><path d="M6 10h1M9.5 10h1M13 10h1M16.5 10h1M7.5 14h9" /></Svg>;
export const CopyIcon = (p: IconProps) => <Svg {...p}><rect x="8.5" y="8.5" width="11" height="11" rx="1.5" /><path d="M15.5 8.5V6A1.5 1.5 0 0 0 14 4.5H6A1.5 1.5 0 0 0 4.5 6v8A1.5 1.5 0 0 0 6 15.5h2.5" /></Svg>;
export const CheckIcon = (p: IconProps) => <Svg {...p}><path d="M5 12.5l4.5 4.5L19 7.5" /></Svg>;
export const InfoIcon = (p: IconProps) => <Svg {...p}><circle cx="12" cy="12" r="8.5" /><path d="M12 11v5.5" /><circle cx="12" cy="7.75" r=".6" fill="currentColor" /></Svg>;
export const TrendUpIcon = (p: IconProps) => <Svg {...p}><path d="M4 16.5l5.5-5.5 4 4L20 8.5" /><path d="M15 8.5h5v5" /></Svg>;

/** Sort glyph for table headers: both carets, the active one filled by the header's state. */
export const SortIcon = ({ dir, ...p }: IconProps & { dir: "asc" | "desc" | null }) => (
  <Svg {...p} grid={16} solid>
    <path d="M8 2.5L11.5 6.5h-7z" opacity={dir === "asc" ? 1 : 0.32} />
    <path d="M8 13.5L4.5 9.5h7z" opacity={dir === "desc" ? 1 : 0.32} />
  </Svg>
);

/** Spray control: a recoil pattern climbing from the crosshair. */
export const SprayIcon = (p: IconProps) => (
  <Svg {...p}><circle cx="12" cy="20" r="1.4" fill="currentColor" stroke="none" /><circle cx="12.4" cy="15.5" r="1.4" fill="currentColor" stroke="none" /><circle cx="11.6" cy="11" r="1.4" fill="currentColor" stroke="none" /><circle cx="13.5" cy="7" r="1.4" fill="currentColor" stroke="none" /><circle cx="17" cy="5" r="1.4" fill="currentColor" stroke="none" /><circle cx="7.5" cy="5.5" r="1.4" fill="currentColor" stroke="none" /><path d="M12 20l.4-4.5-.8-4.5 1.9-4 3.5-2M13.5 7L7.5 5.5" strokeDasharray="1.5 2" /></Svg>
);
/** Counter-strafing: A and D opposed, stopping at the centre. */
export const StrafeIcon = (p: IconProps) => (
  <Svg {...p}><path d="M3 12h6M6 9l-3 3 3 3M21 12h-6M18 9l3 3-3 3" /><path d="M12 6v12" strokeDasharray="2 2" /></Svg>
);
/** A head with a hit marker: headshots and head accuracy. */
export const HeadHitIcon = (p: IconProps) => (
  <Svg {...p}><circle cx="12" cy="9" r="5.5" /><path d="M5 21c1-3.6 3.6-5.5 7-5.5s6 1.9 7 5.5" /><path d="M12 6.5v5M9.5 9h5" /></Svg>
);
