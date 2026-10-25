// Economy: each team's buy per round (CS Demo Manager's classification), win rate by buy against
// buy, money left after buying, saves, and your own numbers split by buy type.
import type { Slice } from "../../stats/counters";
import type { MatchView } from "../../stats/derive";
import { BUY_TYPES, type BuyType } from "../../stats/economy";
import { rating2 } from "../../stats/rating";
import { money, ratingClass } from "../format";
import type { TabProps } from "./MatchPage";

export const BUY_LABEL: Record<BuyType, string> = { pistol: "Pistol", eco: "Eco", semi: "Semi-buy", "force-buy": "Force-buy", full: "Full buy" };
const BUY_SHORT_LABEL: Record<BuyType, string> = { pistol: "pistol", eco: "eco", semi: "semi", "force-buy": "force", full: "full" };
const BUY_SHORT: Record<BuyType, string> = { pistol: "P", eco: "E", semi: "S", "force-buy": "F", full: "B" };
export const BUY_TIP =
  "Team buy as CS Demo Manager classifies it, with every player counted: pistol = first round of a half; eco = equipment ≤ $1,000 per player; full = ≥ $4,500 per player on CT or ≥ $4,000 on T; force-buy = lost the previous round and under $400 per player left; semi = anything else.";

function BuyChip({ t }: { t: BuyType | null }) {
  if (!t) return <span className="buy buy--unknown" aria-label="Unknown buy" data-tip="Unknown: a player's equipment or money was not recorded">?</span>;
  return <span className={`buy buy--${t}`} data-tip={BUY_LABEL[t]} aria-label={BUY_LABEL[t]}>{BUY_SHORT[t]}</span>;
}

function EquipChart({ v }: { v: MatchView }) {
  const rounds = v.rounds.filter((r) => r.captured);
  const max = Math.max(1, ...rounds.flatMap((r) => [r.equip.us ?? 0, r.equip.them ?? 0]));
  const H = 140;
  const bw = 100 / Math.max(rounds.length, 1);
  return (
    <div className="eco">
      <svg className="eco__chart" viewBox={`0 0 100 ${H}`} preserveAspectRatio="none" role="img"
        aria-label="Team equipment value per round: your team in blue, opponents in grey">
        {[0.25, 0.5, 0.75, 1].map((k) => <line key={k} x1="0" x2="100" y1={H - k * H} y2={H - k * H} stroke="rgba(60,60,67,.08)" vectorEffect="non-scaling-stroke" />)}
        {rounds.map((r, i) => {
          const x = i * bw;
          // Unknown equipment draws nothing (never a $0 bar).
          const u = r.equip.us === null ? null : (r.equip.us / max) * (H - 4);
          const t = r.equip.them === null ? null : (r.equip.them / max) * (H - 4);
          return (
            <g key={r.ri}>
              {u !== null && <rect x={x + bw * 0.12} y={H - u} width={bw * 0.36} height={u} rx="0.6" fill="var(--c-blue)" opacity={r.winner === "us" ? 1 : 0.45} />}
              {t !== null && <rect x={x + bw * 0.52} y={H - t} width={bw * 0.36} height={t} rx="0.6" fill="#8e8e93" opacity={r.winner === "them" ? 0.9 : 0.4} />}
            </g>
          );
        })}
      </svg>
      <div className="eco__axis" style={{ gridTemplateColumns: `repeat(${rounds.length}, 1fr)` }}>
        {rounds.map((r) => (
          <div key={r.ri} className="eco__col" data-tip={`Round ${r.ri + 1}: ${r.winner === "us" ? "won" : "lost"} · your team ${money(r.equip.us)} (${r.buy.us ? BUY_LABEL[r.buy.us] : "unknown"}) vs ${money(r.equip.them)} (${r.buy.them ? BUY_LABEL[r.buy.them] : "unknown"})`}>
            <BuyChip t={r.buy.us} />
            <span className="eco__n num">{r.ri + 1}</span>
            <BuyChip t={r.buy.them} />
          </div>
        ))}
      </div>
      <div className="strip__legend">
        <span><i className="sw" style={{ background: "var(--c-blue)" }} /> Your team</span>
        <span><i className="sw" style={{ background: "#8e8e93" }} /> Opponents</span>
        <span>Solid bars = round won</span>
        <span data-tip={BUY_TIP} className="has-tip" tabIndex={0}>P pistol · E eco · S semi · F force · B full buy</span>
      </div>
    </div>
  );
}

function sliceRow(label: string, s: Slice) {
  return (
    <tr key={label}>
      <td>{label}</td>
      <td>{s.rounds}</td>
      <td>{s.kills}</td>
      <td>{s.deaths}</td>
      <td>{s.rounds ? (s.dmg / s.rounds).toFixed(1) : "–"}</td>
      <td className={`rt ${s.rounds ? ratingClass(rating2(s)) : ""}`}>{s.rounds ? rating2(s).toFixed(2) : "–"}</td>
    </tr>
  );
}

export function BuySplits({ own, opp, note }: { own: Slice[]; opp: Slice[]; note?: string }) {
  const head = (first: string, tip: string) => (
    <thead><tr>
      <th tabIndex={0} data-tip={tip}>{first}</th><th>Rounds</th><th>Kills</th><th>Deaths</th>
      <th tabIndex={0} data-tip="Health damage to enemies per round, in these rounds">ADR</th>
      <th tabIndex={0} data-tip="Rating 2.0 (public approximation) over these rounds only">Rating</th>
    </tr></thead>
  );
  return (
    <div className="grid-2">
      <section className="glass card" aria-label="By your team's buy">
        <div className="card__head"><h2 className="card__title">By your team's buy</h2></div>
        <table className="tbl">{head("Your buy", BUY_TIP)}<tbody>{BUY_TYPES.map((t, i) => own[i].rounds ? sliceRow(BUY_LABEL[t], own[i]) : null)}</tbody></table>
      </section>
      <section className="glass card" aria-label="By the opponents' buy">
        <div className="card__head"><h2 className="card__title">By the opponents' buy</h2></div>
        <table className="tbl">{head("Their buy", BUY_TIP)}<tbody>{BUY_TYPES.map((t, i) => opp[i].rounds ? sliceRow(BUY_LABEL[t], opp[i]) : null)}</tbody></table>
        {note && <p className="note" style={{ marginTop: 8 }}>{note}</p>}
      </section>
    </div>
  );
}

export default function Economy({ v }: TabProps) {
  const e = v.economy;
  const h = v.players[v.human];
  const legacy = v.env.plugin === "legacy-convert";
  const usedRows = BUY_TYPES.map((t, i) => ({ t, i })).filter(({ i }) => e.byOwn[i].rounds > 0);
  const usedCols = BUY_TYPES.map((t, i) => ({ t, i })).filter(({ i }) => e.matrix.some((row) => row[i].rounds > 0));
  const captured = v.rounds.filter((r) => r.captured);
  const bankUs = captured.reduce((a, r) => a + (r.money.us ?? 0), 0);
  const bankThem = captured.reduce((a, r) => a + (r.money.them ?? 0), 0);
  const savers = v.players.filter((p) => p.c.saves > 0).sort((a, b) => b.c.saves - a.c.saves);
  return (
    <>
      <section className="glass card" aria-label="Equipment per round">
        <div className="card__head">
          <h2 className="card__title">Equipment per round</h2>
          <span className="note">Freeze-end equipment value per team</span>
        </div>
        <EquipChart v={v} />
        {legacy && <p className="note" style={{ marginTop: 10 }}>Converted from a legacy log: bot equipment is rebuilt from their purchases, so values are close but not exact.</p>}
        {(v.env.equipSource === "inventory" || v.env.equipSource === "mixed") && (
          <p className="note" style={{ marginTop: 10 }}>
            {v.env.equipSource === "inventory" ? "Equipment values" : "Some rounds' equipment values"} were rebuilt from each player's inventory at store prices, because the game reported $0 for every alive bot.
          </p>
        )}
        {v.rounds.some((r) => r.captured && (r.equip.us === null || r.equip.them === null)) && <p className="note">Rounds without a bar have unknown equipment; they get no buy type.</p>}
        {e.unknown > 0 && <p className="note">{e.unknown} round{e.unknown > 1 ? "s" : ""} could not be classified because a player's equipment or money is unknown.</p>}
      </section>

      <div className="grid-2">
        <section className="glass card" aria-label="Win rate by buy">
          <div className="card__head">
            <h2 className="card__title has-tip" tabIndex={0} data-tip={BUY_TIP}>Win rate by buy</h2>
            <span className="note">your buy ↓ vs theirs →</span>
          </div>
          <table className="tbl tbl--auto">
            <thead><tr><th>Your buy</th>{usedCols.map(({ t }) => <th key={t}>vs {BUY_SHORT_LABEL[t]}</th>)}<th>All</th></tr></thead>
            <tbody>
              {usedRows.map(({ t, i }) => (
                <tr key={t}>
                  <td>{BUY_LABEL[t]}</td>
                  {usedCols.map(({ t: u, i: j }) => {
                    const c = e.matrix[i][j];
                    return <td key={u} className={c.rounds ? "" : "muted"}>{c.rounds ? <><b>{Math.round((100 * c.wins) / c.rounds)}%</b> <span className="muted">{c.wins}/{c.rounds}</span></> : "–"}</td>;
                  })}
                  <td><b>{Math.round((100 * e.byOwn[i].wins) / e.byOwn[i].rounds)}%</b> <span className="muted">{e.byOwn[i].wins}/{e.byOwn[i].rounds}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
        <section className="glass card" aria-label="Money and saves">
          <div className="card__head"><h2 className="card__title">Money and saves</h2></div>
          <div className="pcard__stats" style={{ marginBottom: 12 }}>
            <div className="stat has-tip" tabIndex={0} data-tip="Money your team still held at freeze end, averaged over captured rounds."><b>{money(captured.length ? Math.round(bankUs / captured.length) : null)}</b><span>Your team unspent / round</span></div>
            <div className="stat has-tip" tabIndex={0} data-tip="Money the opponents still held at freeze end, averaged over captured rounds."><b>{money(captured.length ? Math.round(bankThem / captured.length) : null)}</b><span>Opponents unspent / round</span></div>
            <div className="stat has-tip" tabIndex={0} data-tip="Rounds you lost but survived with more than $1,000 of equipment."><b>{h.c.saves}</b><span>Your saves</span></div>
            <div className="stat"><b>{h.c.lostRounds}</b><span>Rounds lost</span></div>
          </div>
          <p className="note">{savers.length ? `Saves: ${savers.map((p) => `${p.name} ${p.c.saves}`).join(", ")}.` : "Nobody saved this match."}</p>
        </section>
      </div>

      <BuySplits own={h.c.own} opp={h.c.opp} note="Kills on full buys count for more than kills on ecos, which is the intent behind HLTV's eco adjustment." />
    </>
  );
}
