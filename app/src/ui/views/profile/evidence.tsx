// The Role card's evidence (#35): each role measure the engine reads, for T and CT on one track
// against the pros' range and the role rule's tick (identity.ts RoleMetric, role-thresholds.ts).
import type { RoleBlend, RoleMetric } from "../../../stats/identity";
import type { SideKey } from "../../data/engine";
import { evidenceScale, fmtRoleValue, splitEvidence } from "./career-logic";

const EVIDENCE_TIP = "The band holds 8 in 10 pros (10th to 90th percentile, long halves). The tick is the role rule's line, set by hand.";

/** One evidence track: dotted line, the pros' band, the rule tick, and a dot per side. */
function EvidenceTrack({ t, ct, label }: { t: RoleMetric | null; ct: RoleMetric | null; label: string }) {
  const ref = t ?? ct!;
  const sc = evidenceScale([t?.value ?? null, ct?.value ?? null], ref.proRange, ref.threshold, ref.unit);
  const f = (v: number) => fmtRoleValue(v, ref.unit);
  const desc = [
    ref.proRange ? `Pros mostly ${f(ref.proRange[0])} to ${f(ref.proRange[1])}.` : "No pro range.",
    ref.threshold === null ? null : `Role rule line at ${f(ref.threshold)}.`,
    // a side the row does not show (the page on the other side) is left out
    `${[t && `T ${fmtRoleValue(t.value, ref.unit)}`, ct && `CT ${fmtRoleValue(ct.value, ref.unit)}`].filter(Boolean).join(", ")}.`,
  ].filter(Boolean).join(" ");
  const dot = (m: RoleMetric | null, side: "t" | "ct") => (m?.value === null || m?.value === undefined ? null
    : <i className={`evtrk__dot evtrk__dot--${side}`} style={{ left: `${sc.at(m.value)}%`, ["--p" as string]: sc.at(m.value) }} />);
  return (
    <span className="evtrk" role="img" tabIndex={0} aria-label={`${label}: ${desc}`} data-tip={desc}>
      {sc.band && <span className="evtrk__band" style={{ left: `${sc.band[0]}%`, width: `${sc.band[1] - sc.band[0]}%` }} />}
      {sc.tick !== null && <span className="evtrk__tick" style={{ left: `${sc.tick}%` }} />}
      {dot(t, "t")}
      {dot(ct, "ct")}
    </span>
  );
}

/**
 * The Role card's evidence (roles(q) T and CT metrics, identity.ts RoleMetric): one row per measure
 * with both sides on one track, so a side's lean reads against the other's, the pros' range and the
 * rule's tick. The row's (?) is the engine's tip. Measures neither side has (area changes in rollups)
 * are named in one line under the rows. With the page on one side (`side`), that side's dot and value
 * alone, and "not measured" means not on that side.
 */
export function RoleEvidence({ t, ct, side = "both" }: { t: RoleBlend; ct: RoleBlend; side?: SideKey }) {
  const showT = side !== "ct", showCt = side !== "t";
  const { rows, missing } = splitEvidence(showT ? t.metrics : [], showCt ? ct.metrics : []);
  if (!rows.length && !missing.length) return null;
  return (
    <>
      <h3 className="caps rmaps__h">Evidence <span className="help" data-tip={EVIDENCE_TIP} tabIndex={0} aria-label="What the band and tick mean">?</span>
        <span className="evid__key meta" aria-hidden>{showT && <><i className="evtrk__dot evtrk__dot--t" />T </>}{showCt && <><i className="evtrk__dot evtrk__dot--ct" />CT</>}</span>
      </h3>
      <ul className={`evid ${showT && showCt ? "" : "evid--one"}`}>
        {rows.map((r) => {
          const ref = (r.t ?? r.ct)!;
          return (
            <li key={r.id} className="evid__row" data-metric={r.id}>
              <span className="evid__lab">{ref.label}<span className="help" data-tip={ref.tip} tabIndex={0} role="note" aria-label={ref.tip}>?</span></span>
              <EvidenceTrack t={r.t} ct={r.ct} label={ref.label} />
              {showT && <b className="num evid__v t-text">{fmtRoleValue(r.t?.value ?? null, ref.unit)}</b>}
              {showCt && <b className="num evid__v ct-text">{fmtRoleValue(r.ct?.value ?? null, ref.unit)}</b>}
            </li>
          );
        })}
      </ul>
      {missing.length > 0 && (
        <p className="meta evid__missing">Not measured here: {missing.map((m, i) => (
          <span key={m.id}>{i ? ", " : ""}<span className="has-def" data-tip={m.tip} tabIndex={0}>{m.label}</span></span>
        ))}.</p>
      )}
    </>
  );
}
