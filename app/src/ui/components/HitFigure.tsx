// Where hits landed, on a figure drawn like a CS2 agent (helmet, plate carrier, belt, knee pads, boots)
// rather than a block silhouette. Regions follow the engine's hit groups (stats/facts.ts HIT_GROUPS):
// head, neck, chest, stomach, left and right arm, left and right leg. A region's cream deepens with its
// share of hits; regions with none stay at the track colour.
import { HIT_GROUPS } from "../../stats/facts";

const PATHS: Record<(typeof HIT_GROUPS)[number], string> = {
  head: "M100 8c-15 0-26 9-27 24l-1 12c0 4 2 6 4 7l1 7c3 10 12 16 23 16s20-6 23-16l1-7c2-1 4-3 4-7l-1-12C126 17 115 8 100 8z",
  neck: "M88 74h24l3 14H85z",
  chest: "M85 88c-12 1-22 4-29 9l-4 20 6 34h84l6-34-4-20c-7-5-17-8-29-9l-6 6H91z",
  stomach: "M58 151h84l-3 30 4 26H57l4-26z",
  // the figure faces you: the player's right arm and leg are on the viewer's left
  right_arm: "M52 97c-9 3-14 10-16 20l-6 45 1 30 5 24 6 22c2 4 9 4 10-1l-1-24 1-28 6-36 4-28z",
  left_arm: "M148 97c9 3 14 10 16 20l6 45-1 30-5 24-6 22c-2 4-9 4-10-1l1-24-1-28-6-36-4-28z",
  right_leg: "M57 207h41l-2 26-3 60 2 18-3 70 4 40c1 6-4 9-10 9H66c-6 0-9-4-7-9l5-40-6-70 2-20-4-58z",
  left_leg: "M143 207h-41l2 26 3 60-2 18 3 70-4 40c-1 6 4 9 10 9h20c6 0 9-4 7-9l-5-40 6-70-2-20 4-58z",
};
const GEAR = "M76 36h48M70 104l14 46M130 104l-14 46M60 180h80M74 196h52M66 300h26M108 300h26";
const LABEL: Record<(typeof HIT_GROUPS)[number], string> = { head: "Head", neck: "Neck", chest: "Chest", stomach: "Stomach", left_arm: "Left arm", right_arm: "Right arm", left_leg: "Left leg", right_leg: "Right leg" };

/** groups: hits per HIT_GROUPS index */
export function HitFigure({ groups, width = 150 }: { groups: readonly number[]; width?: number }) {
  const total = groups.reduce((a, b) => a + b, 0);
  const max = Math.max(1, ...groups);
  const fill = (n: number) => (n === 0 ? "var(--pill)" : `rgba(255, 215, 173, ${(0.18 + (0.82 * n) / max).toFixed(2)})`);
  const said = HIT_GROUPS.map((g, i) => `${LABEL[g]} ${total ? Math.round((100 * groups[i]) / total) : 0}%`).join(", ");
  return (
    <svg viewBox="0 0 200 470" width={width} role="img" aria-label={`Hits by body part: ${said}`} className="hitfig">
      <g stroke="var(--bg0)" strokeWidth="2" strokeLinejoin="round">
        {HIT_GROUPS.map((g, i) => <path key={g} d={PATHS[g]} fill={fill(groups[i])}><title>{`${LABEL[g]}: ${groups[i]} hits`}</title></path>)}
      </g>
      <path d={GEAR} fill="none" stroke="rgba(26, 24, 23, 0.55)" strokeWidth="1.5" />
    </svg>
  );
}
