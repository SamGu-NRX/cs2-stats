// UI glyphs (navigation and controls): Lucide's path data on its 24-unit stroke grid, drawn through
// the shared Svg frame (Icon.tsx). Game objects never draw here: they are the CS2 icon pack's
// (components/GameIcon.tsx).
//
// Path data from Lucide 1.61.0 (https://lucide.dev), lucide-static/icons/*.svg.
//   ISC License. Copyright (c) 2026 Lucide Icons and Contributors.
//   Permission to use, copy, modify, and/or distribute this software for any purpose with or without
//   fee is hereby granted, provided that the above copyright notice and this permission notice appear
//   in all copies.
//   THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH REGARD TO THIS
//   SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE
//   AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
//   WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT,
//   NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE
//   OF THIS SOFTWARE.
// check, chevron-down, chevron-left, chevron-right, crosshair, search and x derive from Feather:
//   The MIT License (MIT). Copyright (c) 2013-present Cole Bemis.
//   Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
//   associated documentation files (the "Software"), to deal in the Software without restriction,
//   including without limitation the rights to use, copy, modify, merge, publish, distribute,
//   sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is
//   furnished to do so, subject to the following conditions: The above copyright notice and this
//   permission notice shall be included in all copies or substantial portions of the Software.
//   THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT
//   NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
//   NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
//   DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
//   OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
import { Svg, type IconProps } from "./Icon";

/** Lucide house. */
export const HomeIcon = (p: IconProps) => (
  <Svg {...p}><path d="M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8" /><path d="M3 10a2 2 0 0 1 .709-1.528l7-6a2 2 0 0 1 2.582 0l7 6A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></Svg>
);
/** Lucide list. */
export const MatchesIcon = (p: IconProps) => (
  <Svg {...p}><path d="M3 5h.01" /><path d="M3 12h.01" /><path d="M3 19h.01" /><path d="M8 5h13" /><path d="M8 12h13" /><path d="M8 19h13" /></Svg>
);
/** Lucide user. */
export const ProfileIcon = (p: IconProps) => (
  <Svg {...p}><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" /></Svg>
);
/** Lucide crosshair: aim, and the empty states of the aim panels. */
export const AimIcon = (p: IconProps) => (
  <Svg {...p}><circle cx="12" cy="12" r="10" /><line x1="22" x2="18" y1="12" y2="12" /><line x1="6" x2="2" y1="12" y2="12" /><line x1="12" x2="12" y1="6" y2="2" /><line x1="12" x2="12" y1="22" y2="18" /></Svg>
);
/** Lucide clapperboard: Clips. */
export const ClipsIcon = (p: IconProps) => (
  <Svg {...p}><path d="m12.296 3.464 3.02 3.956" /><path d="M20.2 6 3 11l-.9-2.4c-.3-1.1.3-2.2 1.3-2.5l13.5-4c1.1-.3 2.2.3 2.5 1.3z" /><path d="M3 11h18v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /><path d="m6.18 5.276 3.1 3.899" /></Svg>
);
/** Lucide settings-2. */
export const SettingsIcon = (p: IconProps) => (
  <Svg {...p}><path d="M14 17H5" /><path d="M19 7h-9" /><circle cx="17" cy="17" r="3" /><circle cx="7" cy="7" r="3" /></Svg>
);
/** Lucide panel-left-close: the sidebar's collapse control. */
export const PanelCloseIcon = (p: IconProps) => (
  <Svg {...p}><rect width="18" height="18" x="3" y="3" rx="2" /><path d="M9 3v18" /><path d="m16 15-3-3 3-3" /></Svg>
);

/** Lucide bot: Bot Mode. */
export const BotIcon = (p: IconProps) => (
  <Svg {...p}><path d="M12 8V4H8" /><rect width="16" height="12" x="4" y="8" rx="2" /><path d="M2 14h2" /><path d="M20 14h2" /><path d="M15 13v2" /><path d="M9 13v2" /></Svg>
);
/** Lucide play: launching the game. */
export const PlayIcon = (p: IconProps) => <Svg {...p}><path d="M5 5a2 2 0 0 1 3.008-1.728l11.997 6.998a2 2 0 0 1 .003 3.458l-12 7A2 2 0 0 1 5 19z" /></Svg>;
/** Lucide download: installing a release. */
export const DownloadIcon = (p: IconProps) => <Svg {...p}><path d="M12 15V3" /><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><path d="m7 10 5 5 5-5" /></Svg>;

export const ChevronIcon = (p: IconProps) => <Svg {...p}><path d="m6 9 6 6 6-6" /></Svg>;
export const ChevronRightIcon = (p: IconProps) => <Svg {...p}><path d="m9 18 6-6-6-6" /></Svg>;
export const ChevronLeftIcon = (p: IconProps) => <Svg {...p}><path d="m15 18-6-6 6-6" /></Svg>;
export const CloseIcon = (p: IconProps) => <Svg {...p}><path d="M18 6 6 18" /><path d="m6 6 12 12" /></Svg>;
export const SearchIcon = (p: IconProps) => <Svg {...p}><path d="m21 21-4.34-4.34" /><circle cx="11" cy="11" r="8" /></Svg>;
export const FolderIcon = (p: IconProps) => <Svg {...p}><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" /></Svg>;
export const UploadIcon = (p: IconProps) => <Svg {...p}><path d="M12 3v12" /><path d="m17 8-5-5-5 5" /><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /></Svg>;
/** Lucide refresh-cw. */
export const RefreshIcon = (p: IconProps) => <Svg {...p}><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" /><path d="M21 3v5h-5" /><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" /><path d="M8 16H3v5" /></Svg>;
export const CopyIcon = (p: IconProps) => <Svg {...p}><rect width="14" height="14" x="8" y="8" rx="2" ry="2" /><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" /></Svg>;
export const CheckIcon = (p: IconProps) => <Svg {...p}><path d="M20 6 9 17l-5-5" /></Svg>;
/** Lucide trending-up: a stat with no topic icon of its own. */
export const TrendIcon = (p: IconProps) => <Svg {...p}><path d="M16 7h6v6" /><path d="m22 7-8.5 8.5-5-5L2 17" /></Svg>;

/**
 * Sort glyph for table headers: Lucide arrow-up-down, the up arrow lit for ascending and the down
 * arrow for descending, both dim when the column is not the sort.
 */
export const SortIcon = ({ dir, ...p }: IconProps & { dir: "asc" | "desc" | null }) => (
  <Svg {...p}>
    <g opacity={dir === "asc" ? 1 : 0.32}><path d="m3 8 4-4 4 4" /><path d="M7 4v16" /></g>
    <g opacity={dir === "desc" ? 1 : 0.32}><path d="m21 16-4 4-4-4" /><path d="M17 20V4" /></g>
  </Svg>
);
