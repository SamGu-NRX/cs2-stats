// Every utility stat for one player, split by T and CT. HLTV's names first, then "More".
import { formatMetric, tooltip, UTIL_METRICS } from "../stats/metrics";
import { sideSlices, type UtilSlice } from "../stats/utility";

const HLTV_COUNT = 8;

export function UtilityTable({ util, title }: { util: { t: UtilSlice; ct: UtilSlice }; title: string }) {
  const both = sideSlices(util, "both");
  const row = (i: number) => {
    const m = UTIL_METRICS[i];
    const asMetric = { ...m, value: () => null };
    return (
      <tr key={m.id}>
        <td><span className="has-tip" data-tip={tooltip(asMetric)} tabIndex={0}>{m.label}</span></td>
        <td>{formatMetric(asMetric, m.u(util.t))}</td>
        <td>{formatMetric(asMetric, m.u(util.ct))}</td>
        <td><b>{formatMetric(asMetric, m.u(both))}</b></td>
      </tr>
    );
  };
  return (
    <section className="glass card" aria-label={title}>
      <div className="card__head">
        <h2 className="card__title">{title}</h2>
        <span className="note">{util.t.rounds} T rounds · {util.ct.rounds} CT rounds</span>
      </div>
      <table className="tbl">
        <thead><tr><th>Stat</th><th><span className="side side--t">T</span></th><th><span className="side side--ct">CT</span></th><th>Total</th></tr></thead>
        <tbody>
          {UTIL_METRICS.slice(0, HLTV_COUNT).map((_, i) => row(i))}
          <tr className="tbl__sep"><td colSpan={4}><span className="eyebrow">More</span></td></tr>
          {UTIL_METRICS.slice(HLTV_COUNT).map((_, i) => row(i + HLTV_COUNT))}
        </tbody>
      </table>
    </section>
  );
}
