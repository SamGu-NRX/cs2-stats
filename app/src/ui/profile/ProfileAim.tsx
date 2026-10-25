// Aim analytics summed over every match that has aim data.
import { AimPanels } from "../match/Aim";
import type { ProfileTabProps } from "./ProfilePage";

export default function ProfileAim({ p }: ProfileTabProps) {
  if (!p.aim) return <div className="glass card empty"><h2>No aim data yet</h2><p>Matches captured by the plugin from the start include aim data.</p></div>;
  return (
    <>
      <p className="note" style={{ padding: "0 6px" }}>From {p.aimMatches} match{p.aimMatches === 1 ? "" : "es"} with aim data.</p>
      <AimPanels a={p.aim} />
    </>
  );
}
