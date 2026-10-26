// A game object (weapon, grenade, kill flag, round end, equipment, economy) as the official CS2 icon
// from the local pack (data/icons.ts), tinted with currentColor through a CSS mask. Every game object
// in the app draws through this one component (design-target-v2/SYSTEM.md, icon policy). When the pack
// or the icon is missing it shows the object's name as text, never a hand-drawn stand-in. While the
// icon loads the box keeps its size and stays empty, so the name never flashes before the icon.
import { useGameIcon } from "../data/icons";

export function GameIcon({ id, name, width, height = width, beside = false, text, className }: {
  /** the pack's id (manifest.json): "ak47", "hegrenade", "headshot", "elimination", "money" */
  id: string | null;
  /** the object's name: spoken, and shown as text when the pack has no icon for it */
  name: string;
  width: number;
  height?: number;
  /** the name already sits in the text beside the icon (or its tooltip): the icon is silent, and nothing shows without the pack */
  beside?: boolean;
  /** shorter text for the no-pack fallback where the full name cannot fit (round rails); shown even when `beside` */
  text?: string;
  className?: string;
}) {
  const url = useGameIcon(id);
  if (url === null) {
    if (text === undefined && beside) return null;
    return <span className={`gicon-text ${className ?? ""}`} aria-hidden={beside || undefined}>{text ?? name}</span>;
  }
  return (
    <span
      className={`gicon ${className ?? ""}`}
      role={beside ? undefined : "img"}
      aria-label={beside ? undefined : name}
      aria-hidden={beside || undefined}
      style={{ width, height, ...(url ? { WebkitMaskImage: `url("${url}")`, maskImage: `url("${url}")` } : { background: "transparent" }) }}
    />
  );
}
