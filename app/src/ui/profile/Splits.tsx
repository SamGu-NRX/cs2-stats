// Splits across all matches: sides, maps, buy types, weapon classes, clutches, kill-count rounds,
// and utility by side.
import { WEAPON_CLASSES, type Slice } from "../../stats/counters";
import { rating2 } from "../../stats/rating";
import { BuySplits } from "../match/Economy";
import { mapName, ratingClass } from "../format";
import { UtilityTable } from "../UtilityTable";
import type { ProfileTabProps } from "./ProfilePage";

const CLASS_LABEL: Record<string, string> = { rifle: "Rifles", sniper: "Snipers", smg: "SMGs", heavy: "Shotguns and MGs", pistol: "Pistols", grenade: "Grenades and fire", knife: "Knife", other: "Other" };

function SliceCells({ s }: { s: Slice }) {
  const r = rating2(s);
  return (
    <>
      <td>{s.rounds}</td>
      <td>{s.rounds ? (s.kills / s.rounds).toFixed(2) : "–"}</td>
      <td>{s.rounds ? (s.dmg / s.rounds).toFixed(1) : "–"}</td>
      <td>{s.rounds ? `${((100 * s.kastRounds) / s.rounds).toFixed(1)}%` : "–"}</td>
      <td className={`rt ${s.rounds ? ratingClass(r) : ""}`}>{s.rounds ? r.toFixed(2) : "–"}</td>
    </>
  );
}

const SLICE_HEAD = (
  <>
    <th tabIndex={0} data-tip="Rounds with stats">Rounds</th><th tabIndex={0} data-tip="Kills per round">KPR</th><th tabIndex={0} data-tip="Damage per round">ADR</th>
    <th tabIndex={0} data-tip="Rounds with a kill, assist, survival or traded death">KAST</th><th tabIndex={0} data-tip="Rating 2.0 (public approximation) over these rounds">Rating</th>
  </>
);

function Bars({ rows, total }: { rows: [string, number, string?][]; total: number }) {
  const max = Math.max(1, ...rows.map((r) => r[1]));
  return (
    <div className="places">
      {rows.map(([label, n, tip]) => (
        <div key={label} className="places__row" data-tip={tip}>
          <span>{label}</span>
          <span className="bar"><i style={{ width: `${(100 * n) / max}%` }} /></span>
          <b className="num">{n}<span className="muted" style={{ fontWeight: 450 }}> · {total ? Math.round((100 * n) / total) : 0}%</span></b>
        </div>
      ))}
    </div>
  );
}

export default function Splits({ p }: ProfileTabProps) {
  const t = p.total;
  return (
    <>
      <div className="grid-2">
        <section className="glass card" aria-label="By side">
          <div className="card__head"><h2 className="card__title">By side</h2></div>
          <table className="tbl">
            <thead><tr><th>Side</th>{SLICE_HEAD}</tr></thead>
            <tbody>
              <tr><td><span className="side side--t">T</span></td><SliceCells s={t.sideT} /></tr>
              <tr><td><span className="side side--ct">CT</span></td><SliceCells s={t.sideCT} /></tr>
            </tbody>
          </table>
        </section>
        <section className="glass card" aria-label="By map">
          <div className="card__head"><h2 className="card__title">By map</h2></div>
          <table className="tbl">
            <thead><tr><th>Map</th><th>Won</th>{SLICE_HEAD}</tr></thead>
            <tbody>
              {p.maps.map((m) => (
                <tr key={m.map}><td>{mapName(m.map)}</td><td>{m.wins}/{m.matches}</td><SliceCells s={m.c} /></tr>
              ))}
            </tbody>
          </table>
        </section>
      </div>

      <BuySplits own={t.own} opp={t.opp} note="Kills on full buys count for more than kills on ecos, which is the intent behind HLTV's eco adjustment." />

      <div className="grid-2">
        <section className="glass card" aria-label="Kills by weapon class">
          <div className="card__head"><h2 className="card__title">Kills by weapon</h2><span className="note">{t.kills} kills</span></div>
          <Bars total={t.kills} rows={WEAPON_CLASSES.map((c, i) => [CLASS_LABEL[c], t.weaponKills[i]] as [string, number]).filter((r) => r[1] > 0)} />
        </section>
        <section className="glass card" aria-label="Kills per round">
          <div className="card__head"><h2 className="card__title has-tip" tabIndex={0} data-tip="Rounds in which you got exactly this many kills. As in CS Demo Manager.">Kills per round</h2><span className="note">{t.rounds} rounds</span></div>
          <Bars total={t.rounds} rows={t.kc.map((n, k) => [`${k} kill${k === 1 ? "" : "s"}`, n] as [string, number])} />
        </section>
      </div>

      <section className="glass card" aria-label="Clutches">
        <div className="card__head">
          <h2 className="card__title has-tip" tabIndex={0} data-tip="1vX situations as CS Demo Manager detects them: the first time your side is down to you alone, against the enemies still alive. A 1vX that becomes 1v1 also counts the last enemy's 1v1.">Clutches</h2>
          <span className="note">won / played</span>
        </div>
        <div className="clutches">
          {t.clutchN.map((n, i) => (
            <div key={i} className="stat">
              <b className="num">{t.clutchW[i]}/{n}</b>
              <span>1v{i + 1}{n ? ` · ${Math.round((100 * t.clutchW[i]) / n)}%` : ""}</span>
            </div>
          ))}
        </div>
      </section>

      <UtilityTable util={t.util} title="Utility by side" />
    </>
  );
}
