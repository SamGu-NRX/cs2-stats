// Shared frame for every icon. Rules for the set:
// - Stroke icons draw on a 24-unit grid (attributes, navigation, controls) or a 16-unit grid (win
//   types, buy types, grenades, killfeed marks). Strokes are 1.5 px at every rendered size
//   (vector-effect: non-scaling-stroke, set in CSS), round caps and joins, in currentColor.
//   Below 14 px, glyphs that would crumble are filled instead.
// - Weapons are filled silhouettes on a shared 64×20 grid, muzzle to the right, drawn at the same
//   scale so a pistol reads smaller than a rifle, as in the game's killfeed.
// - An icon with a `label` is announced (role img); without one it is decorative (aria-hidden).
import type { ReactNode, SVGProps } from "react";

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, "children"> {
  size?: number;
  label?: string;
}

export function Svg({ size = 16, label, grid = 24, solid = false, width, height, children, className, ...rest }: IconProps & { grid?: number | [number, number]; solid?: boolean; children: ReactNode }) {
  const stroke = !solid;
  const [w, h] = Array.isArray(grid) ? grid : [grid, grid];
  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      width={width ?? (Array.isArray(grid) ? (size * w) / h : size)}
      height={height ?? size}
      className={className ? `ico ${className}` : "ico"}
      fill={stroke ? "none" : "currentColor"}
      stroke={stroke ? "currentColor" : "none"}
      strokeWidth={stroke ? 1.5 : undefined}
      strokeLinecap="round"
      strokeLinejoin="round"
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      focusable="false"
      {...rest}
    >
      {label && <title>{label}</title>}
      {children}
    </svg>
  );
}
