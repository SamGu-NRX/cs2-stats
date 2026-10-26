// An official CS2 icon from the local pack (data/icons.ts), tinted with currentColor through a CSS mask,
// or the app's own glyph when the pack or the icon is missing. While the icon loads the box keeps its
// size and stays empty, so the glyph never flashes before the official icon.
import type { ReactNode } from "react";
import { useGameIcon } from "../data/icons";

export function GameIcon({ id, width, height = width, label, fallback, className }: {
  id: string | null;
  width: number;
  height?: number;
  /** spoken name; omit when the text beside the icon already says it */
  label?: string;
  fallback: ReactNode;
  className?: string;
}) {
  const url = useGameIcon(id);
  if (url === null) return <>{fallback}</>;
  return (
    <span
      className={`gicon ${className ?? ""}`}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      style={{ width, height, ...(url ? { WebkitMaskImage: `url("${url}")`, maskImage: `url("${url}")` } : { background: "transparent" }) }}
    />
  );
}
