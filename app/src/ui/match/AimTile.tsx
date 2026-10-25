// One aim stat tile, shared by the Aim views and the profile card (kept apart from the charts).
import type { ShotStats } from "../../stats/aim";
import { FLAG_LABEL, FLAG_TIP, type AimStat } from "./aimStats";

/** One aim stat with its caveat labels: validating (until the plugin validates visibility), provisional, smoke approximated. */
export function AimTile({ st, s, validated }: { st: AimStat; s: ShotStats; validated: boolean }) {
  const flags = (st.flags ?? []).filter((f) => f !== "validating" || !validated);
  const extra = st.extra?.(s);
  return (
    <div className="stat has-tip" data-tip={st.tip} tabIndex={0}>
      <b className="num">{st.value(s)}</b>
      <span>{st.label}</span>
      {extra && <span className="muted" style={{ fontSize: 10.5 }}>{extra}</span>}
      {flags.length > 0 && <span className="aimflags">{flags.map((f) => <i key={f} className={`aimflag aimflag--${f}`} title={FLAG_TIP[f]}>{FLAG_LABEL[f]}</i>)}</span>}
    </div>
  );
}

