// Agent art from the packs folder. Without the pack, a drawn head-and-shoulders silhouette in the
// side's colour stands in, so the card, hero and avatar keep their composition.
import { useAgents } from "../data/packs";

function Silhouette({ side, className }: { side: "t" | "ct"; className?: string }) {
  const tone = side === "t" ? "var(--t)" : "var(--ct)";
  const id = `agent-fill-${side}`;
  return (
    <svg viewBox="0 0 340 350" className={`${className ?? ""} agent-fallback`} aria-hidden preserveAspectRatio="xMidYMax meet">
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={tone} stopOpacity="0.32" />
          <stop offset="1" stopColor={tone} stopOpacity="0.06" />
        </linearGradient>
      </defs>
      <path fill={`url(#${id})`} d="M170 30c40 0 66 30 66 72 0 30-12 54-30 68l2 22c46 10 88 34 104 70 8 18 12 50 12 88H16c0-38 4-70 12-88 16-36 58-60 104-70l2-22c-18-14-30-38-30-68 0-42 26-72 66-72z" />
      <path fill="none" stroke={tone} strokeOpacity="0.35" strokeWidth="2" d="M170 30c40 0 66 30 66 72 0 30-12 54-30 68l2 22c46 10 88 34 104 70 8 18 12 50 12 88M16 350c0-38 4-70 12-88 16-36 58-60 104-70l2-22c-18-14-30-38-30-68 0-42 26-72 66-72" />
    </svg>
  );
}

export function AgentImg({ side, kind, className }: { side: "t" | "ct"; kind: "portrait" | "ghost"; className?: string }) {
  const a = useAgents();
  const art = a?.[side];
  if (!a) return null;
  if (!art) return <Silhouette side={side} className={className} />;
  return <img src={art[kind]} alt="" className={className} draggable={false} />;
}
