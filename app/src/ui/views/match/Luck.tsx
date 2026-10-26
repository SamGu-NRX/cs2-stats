// Luck, for fun (stats/luck.ts): how the dice rolled for you in this match. The hero puts the luck score
// in words beside your hits beyond the odds and the enemies' on you, then the score round by round; then
// every lucky moment each way, each a link to its round; then the lobby by luck and every luck metric.
// None of it is ranked against the pros. A source that lacks an input shows what it has and one line
// for the rest (luck/model.ts missingInputs).
import { useMemo, useState, type ReactNode } from "react";
import type { Input } from "../../../stats/facts";
import { Card } from "../../components/Card";
import { GameIcon } from "../../components/GameIcon";
import { Fig, symmetricMax } from "../../components/MatchSeries";
import { MetricList, MetricRow } from "../../components/MetricRow";
import { fmtMetric } from "../../data/engine";
import type { MatchModel } from "../../data/match";
import { metric } from "../../data/meta";
import { tipOf } from "../../data/tips";
import { WeaponIcon } from "../../icons/game";
import { matchHref, navWasPointer } from "../../router";
import { SectionAside } from "../shared";
import { useRoving } from "./roving";
import type { TabProps } from "./MatchView";
import {
  CLOSE_CALL_HP, fmtLuck, inputOf, LOW_HP, lobbyLuck, LUCK_GROUPS, luckHeadline, luckMoments, missingInputs,
  missingLine, roundLuck, tally, type FlagId, type Moment, type MomentKind, type RoundLuck,
} from "./luck/model";

/** Moment rows shown before "Show all". */
const FIRST_ROWS = 8;

export default function Luck({ v, file }: TabProps) {
  // the strip draws in only when a click opened the tab; Enter on a tab, Alt and a digit, a deep link or
  // a reload renders the end state (SYSTEM.md, motion)
  const [enter] = useState(() => navWasPointer());
  const line = v.b.lines.both[v.human];
  const missing = useMemo(() => missingInputs(line.m), [line]);
  const moments = useMemo(() => luckMoments(v), [v]);
  const mine = moments.filter((x) => !x.against);
  const theirs = moments.filter((x) => x.against);
  return (
    <div className="tabpad luck" data-enter={enter || undefined}>
      <Hero v={v} file={file} missing={missing} mine={mine} theirs={theirs} />
      <div className="grid-2 lk-pair">
        <Moments title="Lucky for you" empty="No lucky kills or close calls this match." v={v} file={file} rows={mine} />
        <Moments title="Lucky against you" empty="The enemies had no luck on you this match." v={v} file={file} rows={theirs} against />
      </div>
      <div className={missing.includes("spread") ? "lk-solo" : "grid-2 lk-pair"}>
        {!missing.includes("spread") && <Lobby v={v} />}
        <Numbers v={v} missing={missing} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- hero

function Hero({ v, file, missing, mine, theirs }: { v: MatchModel; file: string; missing: Input[]; mine: Moment[]; theirs: Moment[] }) {
  const vals = v.b.lines.both[v.human].v;
  const score = vals.luckScore;
  const headline = luckHeadline(score);
  const count = (ms: Moment[]) => ms.reduce((a, x) => a + x.count, 0);
  if (headline === null) {
    // no luck score: the source has no spread, so the hero counts the moments it does have
    return (
      <Card className="hero lk-hero">
        <div className="lk-hero__top">
          <div className="lk-verdict">
            <span className="caps">Lucky moments</span>
            <div className="lk-verdict__row">
              <b className="disp disp--l">{count(mine)}</b>
              <span className="lk-verdict__words">
                <span className="disp disp--s lk-verdict__line">for you, <span className="lk-verdict__them">{count(theirs)} against you</span></span>
                <span className="meta">{missing.includes("spread") ? missingLine("spread") : "No shots at a visible enemy to score."}</span>
              </span>
            </div>
          </div>
        </div>
      </Card>
    );
  }
  const strip = roundLuck(v);
  return (
    <Card className="hero lk-hero">
      <div className="lk-hero__top">
        <div className="lk-verdict">
          <span className="caps lk-tipped" data-tip={tipOf("luckScore")} tabIndex={0}>Luck score</span>
          <div className="lk-verdict__row">
            <b className="disp disp--l">{fmtLuck(score)}</b>
            <span className="lk-verdict__words">
              <span className="disp disp--s lk-verdict__line">{headline}</span>
              <span className="meta">Lucky hits per 24 rounds: yours, less the enemies' on you</span>
            </span>
          </div>
        </div>
        <Balance you={vals.luckHits} them={vals.luckAgainst} />
      </div>
      {strip.some((r) => r.value !== null) && (
        <div className="lk-strip">
          <div className="lk-strip__head">
            <span className="caps lk-tipped" data-tip="Each round's lucky hits, yours less the enemies' on you. Open a round to see it." tabIndex={0}>Round by round</span>
            <span className="meta">Cream round numbers: rounds you won</span>
          </div>
          <div className="lk-strip__body">
            <RoundStrip rounds={strip} file={file} />
            <Extremes rounds={strip} file={file} />
          </div>
        </div>
      )}
    </Card>
  );
}

/** The luckiest and unluckiest rounds, each a link to it; one alone when only one way happened. */
function Extremes({ rounds, file }: { rounds: RoundLuck[]; file: string }) {
  const scored = rounds.filter((r): r is RoundLuck & { value: number } => r.value !== null);
  const best = scored.reduce<(typeof scored)[number] | null>((a, r) => (r.value > 0 && (!a || r.value > a.value) ? r : a), null);
  const worst = scored.reduce<(typeof scored)[number] | null>((a, r) => (r.value < 0 && (!a || r.value < a.value) ? r : a), null);
  if (!best && !worst) return null;
  return (
    <dl className="figs lk-figs">
      {best && <Fig label="Luckiest round" value={`Round ${best.round}`} sub={`${fmtLuck(best.value)} hits`} href={matchHref(file, "rounds", { round: best.round })} />}
      {worst && <Fig label="Unluckiest round" value={`Round ${worst.round}`} sub={`${fmtLuck(worst.value)} hits`} href={matchHref(file, "rounds", { round: worst.round })} />}
    </dl>
  );
}

/** Your hits beyond the odds against the enemies' on you, as two lollipops from zero on one scale. */
function Balance({ you, them }: { you: number | null; them: number | null }) {
  const max = symmetricMax([you ?? 0, them ?? 0]);
  return (
    <div className="lk-balance">
      <dl>
        <Lolly label="Your shots" tip={tipOf("luckHits")} value={you} max={max} you />
        <Lolly label="Their shots at you" tip={tipOf("luckAgainst")} value={them} max={max} />
      </dl>
      <p className="meta">Hits beyond the odds, per 24 rounds</p>
    </div>
  );
}

function Lolly({ label, tip, value, max, you }: { label: ReactNode; tip?: string; value: number | null; max: number; you?: boolean }) {
  return (
    <div className={`lk-lolly ${you ? "is-you" : ""}`} data-tip={tip} tabIndex={tip ? 0 : undefined}>
      <dt className="lk-lolly__l">{label}</dt>
      <dd className="lk-lolly__v"><DivTrack value={value} max={max} /><b className="num">{fmtLuck(value)}</b></dd>
    </div>
  );
}

/** A diverging lollipop from a dotted zero in the middle: right of it the dice favoured, left not. */
function DivTrack({ value, max }: { value: number | null; max: number }) {
  const at = value === null ? null : 50 + (50 * Math.max(-max, Math.min(max, value))) / max;
  return (
    <span className="lk-div" aria-hidden>
      <i className="lk-div__zero" />
      {at !== null && <>
        <i className={`lk-div__stem ${value! < 0 ? "is-neg" : ""}`} style={{ left: `${Math.min(50, at)}%`, width: `${Math.abs(at - 50)}%` }} />
        <i className={`lk-div__dot ${value! < 0 ? "is-neg" : ""}`} style={{ left: `${at}%` }} />
      </>}
    </span>
  );
}

const PITCH = 26;
const PLOT = 92;

/**
 * Each round's luck as a vertical lollipop from a dotted zero (SYSTEM.md, diverging values), one fixed
 * pitch per round so the width follows the match; the luckiest and unluckiest rounds are labelled.
 * Every round is a link to it on the Rounds tab; the strip is one tab stop, the arrow keys, Home and
 * End move between rounds (roving.ts).
 */
function RoundStrip({ rounds, file }: { rounds: RoundLuck[]; file: string }) {
  const roving = useRoving(rounds.length);
  const vals = rounds.flatMap((r) => (r.value === null ? [] : [r.value]));
  const max = symmetricMax(vals);
  const top = 12, bottom = PLOT - 8, zero = (top + bottom) / 2;
  const Y = (x: number) => zero - ((x / max) * (bottom - top)) / 2;
  const left = 30;
  const X = (i: number) => left + PITCH / 2 + i * PITCH;
  const end = left + rounds.length * PITCH;
  const best = Math.max(...vals), worst = Math.min(...vals);
  const bi = rounds.findIndex((r) => r.value === best), wi = rounds.findIndex((r) => r.value === worst);
  const h = PLOT + 18;
  const tick = (x: number) => `${x > 0 ? "+" : x < 0 ? "−" : ""}${Math.abs(x)}`;
  return (
    <svg className="lk-rs" width={end + 8} height={h} role="group" aria-label={`Luck by round, scale ±${max} hits; arrow keys move between rounds`} onKeyDown={roving.onKeyDown}>
      <g aria-hidden>
        <text x={left - 8} y={top + 4} textAnchor="end" className="ax">{tick(max)}</text>
        <text x={left - 8} y={zero + 4} textAnchor="end" className="ax">0</text>
        <text x={left - 8} y={bottom + 4} textAnchor="end" className="ax">{tick(-max)}</text>
        <line x1={left} x2={end} y1={top} y2={top} className="ms__grid" />
        <line x1={left} x2={end} y1={bottom} y2={bottom} className="ms__grid" />
        <line x1={left} x2={end} y1={zero} y2={zero} className="ms__zero" />
        {rounds.map((r, i) => i > 0 && r.halfStart && <line key={r.ri} x1={left + i * PITCH} x2={left + i * PITCH} y1={top - 6} y2={h - 2} className="lk-rs__half" />)}
      </g>
      {rounds.map((r, i) => {
        const x = X(i);
        const won = r.won === null ? "" : r.won ? ", won" : ", lost";
        const name = `Round ${r.round}${won}: ${r.value === null ? "not measured" : `${fmtLuck(r.value)} hits`}`;
        const neg = r.value !== null && r.value < 0;
        const y = r.value === null ? zero : Y(r.value);
        return (
          <a key={r.ri} href={matchHref(file, "rounds", { round: r.round })} className="lk-rs__r" aria-label={name} data-tip={name} {...roving.item(i)}>
            <rect x={x - PITCH / 2 + 1} y={2} width={PITCH - 2} height={h - 4} rx={4} className="lk-rs__hit" />
            {r.value === null
              ? <circle cx={x} cy={zero} r={1.5} className="lk-rs__none" />
              : (
                <g className={neg ? "is-neg" : "is-pos"} style={{ ["--i" as string]: i, ["--dy" as string]: `${zero - y}px` }}>
                  <line x1={x} x2={x} y1={zero} y2={y} className="lk-rs__stem" />
                  <circle cx={x} cy={y} r={4} className="lk-rs__pop" />
                </g>
              )}
            {(i === bi || i === wi) && vals.length > 1 && r.value !== null && r.value !== 0 && (
              <text x={x} y={neg ? y + 15 : y - 8} textAnchor="middle" className="ax lk-rs__ext">{fmtLuck(r.value)}</text>
            )}
            <text x={x} y={h - 3} textAnchor="middle" className={`ax lk-rs__n ${r.won ? "is-won" : ""}`}>{r.round}</text>
          </a>
        );
      })}
    </svg>
  );
}

// ---------------------------------------------------------------- moments

const FLAG_WORD: Record<FlagId, { mine: string; theirs: string; icon: string }> = {
  noscope: { mine: "No-scope", theirs: "No-scope", icon: "noscope" },
  smoke: { mine: "Through smoke", theirs: "Through smoke", icon: "smoke" },
  blind: { mine: "While blind", theirs: "Killer blind", icon: "blind" },
  inair: { mine: "In the air", theirs: "Killer in the air", icon: "inair" },
};

const plural = (n: number, one: string, many: string) => (n === 1 ? one : `${n} ${many}`);

/** The row's words: what happened, counted when the round had more than one. */
function kindLabel(x: Moment): string {
  switch (x.kind) {
    case "flag": return x.flags.map((f) => FLAG_WORD[f][x.against ? "theirs" : "mine"]).join(" · ");
    case "runGun": return x.against ? "Killer was running" : plural(x.count, "Run-and-gun kill", "run-and-gun kills");
    case "luckyHs": return x.against ? "Lucky headshot on you" : plural(x.count, "Lucky headshot", "lucky headshots");
    case "lowHp": return x.against ? `Killer on ${LOW_HP} HP or less` : plural(x.count, "Kill on low health", "kills on low health");
    case "closeCall": return x.count === 1 ? "Close call" : `${x.count} close calls`;
  }
}

/** The engine metric each kind counts, yours then against you, for the tooltips. Your flag kills have
 *  one metric per flag (FLAG_TIP), so the kind as a whole has none. */
const KIND_METRIC: Record<MomentKind, [string | null, string]> = {
  flag: [null, "flagDeaths"], runGun: ["runAndGunKills", "runAndGunDeaths"], luckyHs: ["luckyHeadshots", "luckyHeadshotDeaths"],
  lowHp: ["lowHpKills", "lowHpDeaths"], closeCall: ["closeCalls", "closeCalls"],
};
const FLAG_TIP: Record<FlagId, string> = { noscope: "noscopeKills", smoke: "smokeKills", blind: "blindKills", inair: "airKills" };
const kindTip = (kind: MomentKind, against: boolean) => {
  const id = KIND_METRIC[kind][against ? 1 : 0];
  return id ? tipOf(id) : "Kills while blind or in the air, without a scope, or through smoke.";
};
const momentTip = (x: Moment) => (x.kind === "flag" && !x.against ? x.flags.map((f) => tipOf(FLAG_TIP[f])).join("\n") : kindTip(x.kind, x.against));

/** The kind's mark: the killfeed icons where the game has one, a text pip where it does not. */
function Mark({ x }: { x: Moment }) {
  if (x.kind === "flag") return <span className="lk-mark">{x.flags.map((f) => <GameIcon key={f} id={FLAG_WORD[f].icon} name={FLAG_WORD[f].mine} width={16} beside />)}</span>;
  if (x.kind === "luckyHs") return <span className="lk-mark"><GameIcon id="headshot" name="Headshot" width={16} beside /></span>;
  const text = x.kind === "runGun" ? "RUN" : x.kind === "lowHp" ? `${LOW_HP} HP` : `${CLOSE_CALL_HP} HP`;
  return <span className="lk-mark"><span className="pip pip--o lk-pip">{text}</span></span>;
}

/** Who it was: your victims, or your killer, each with the gun; the side colours the name. */
function Who({ v, x }: { v: MatchModel; x: Moment }) {
  if (x.kind === "closeCall") return <span className="lk-who faint">Survived on {CLOSE_CALL_HP} HP or less</span>;
  // the round's count covers some kills but not all of them, so no kill is named (luck/model.ts)
  if (!x.kills.length) return <span className="lk-who" />;
  const weapons = [...new Set(x.kills.map((k) => k.weapon))];
  const people = x.kills.map((k) => {
    const pi = x.against ? k.killer : k.victim;
    const side = x.against ? k.killerSide : k.victimSide;
    return pi === null ? null : <span key={`${k.tick}-${pi}`} className={side === "T" ? "t-text" : side === "CT" ? "ct-text" : undefined}>{v.players[pi].name}</span>;
  }).filter(Boolean);
  return (
    <span className="lk-who">
      {weapons.map((w) => <WeaponIcon key={w} name={w} height={13} className="lk-who__gun" />)}
      <span className="lk-who__names">{x.against ? "by " : "on "}{people.flatMap((p, i) => (i ? [", ", p] : [p]))}</span>
    </span>
  );
}

function Moments({ title, empty, v, file, rows, against }: { title: string; empty: string; v: MatchModel; file: string; rows: Moment[]; against?: boolean }) {
  const [all, setAll] = useState(false);
  const t = tally(rows);
  const total = rows.reduce((a, x) => a + x.count, 0);
  const shown = all ? rows : rows.slice(0, FIRST_ROWS);
  const flagIcons = [...new Set(rows.flatMap((x) => x.flags))];
  const parts: { kind: MomentKind; mark: ReactNode; text: string }[] = [
    { kind: "flag", mark: flagIcons.map((f) => <GameIcon key={f} id={FLAG_WORD[f].icon} name={FLAG_WORD[f].mine} width={14} beside />), text: against ? "to flag kills" : "flag kills" },
    { kind: "runGun", mark: <span className="pip pip--o lk-pip">RUN</span>, text: "running" },
    { kind: "luckyHs", mark: <GameIcon id="headshot" name="Headshot" width={14} beside />, text: "wide-cone headshots" },
    { kind: "lowHp", mark: <span className="pip pip--o lk-pip">{LOW_HP} HP</span>, text: against ? "by a low-health killer" : "on low health" },
    { kind: "closeCall", mark: <span className="pip pip--o lk-pip">{CLOSE_CALL_HP} HP</span>, text: "close calls" },
  ];
  return (
    <Card title={title} aside={<SectionAside label={against ? "Against you" : "For you"} value={total} color={against ? undefined : "var(--cream)"} />} className={`lk-moments ${against ? "is-against" : ""}`}>
      {total > 0 && (
        <ul className="lk-tally" aria-label={`${title}, by kind`}>
          {parts.filter((p) => t[p.kind] > 0).map((p) => (
            <li key={p.kind} data-tip={kindTip(p.kind, !!against)} tabIndex={0}>
              <span className="lk-tally__mark" aria-hidden>{p.mark}</span><b className="num">{t[p.kind]}</b><span>{p.text}</span>
            </li>
          ))}
        </ul>
      )}
      {rows.length ? (
        <ul className="lk-list">
          {shown.map((x) => {
            const label = kindLabel(x);
            const result = x.won === null ? "" : x.won ? ", won" : ", lost";
            return (
              <li key={`${x.ri}-${x.kind}-${x.kills.map((k) => `${k.tick}:${k.victim}`).join()}`}>
                <a className="lk-row" href={matchHref(file, "rounds", { round: x.round })} data-tip={momentTip(x)}
                  aria-label={`Round ${x.round}${result}: ${label}`}>
                  <span className={`wl wl--${x.won === null ? "T" : x.won ? "W" : "L"} lk-row__r`}>{x.round}</span>
                  <Mark x={x} />
                  <span className="lk-row__what">{label}</span>
                  <Who v={v} x={x} />
                </a>
              </li>
            );
          })}
        </ul>
      ) : <p className="meta lk-empty">{empty}</p>}
      {rows.length > FIRST_ROWS && (
        <button className="btn btn--ghost btn--sm press lk-more" onClick={() => setAll((a) => !a)} aria-expanded={all}>
          {all ? "Show fewer" : `Show all ${rows.length}`}
        </button>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------- the lobby and the numbers

function Lobby({ v }: { v: MatchModel }) {
  const rows = lobbyLuck(v);
  const max = symmetricMax(rows.map((r) => r.score));
  const us = v.b.teams.us.v.luckScore;
  return (
    <Card title="Luck in the lobby" tip="Every player's luck score in this match, luckiest first." aside={us === null ? undefined : <SectionAside label="Your team" value={fmtLuck(us)} color="var(--cream)" />}>
      {rows.length ? (
        <ul className="lk-lobby" aria-label="Luck score by player">
          {rows.map((r) => (
            <li key={r.pi} className={r.you ? "is-you" : undefined} tabIndex={0} data-tip={`${r.name}: ${fmtLuck(r.score)} lucky hits per 24 rounds, less the enemies' on them${r.team === "us" ? "" : " (opponent)"}`}>
              <span className={`lk-lobby__n ${r.team === "us" ? "us-text" : "them-text"}`}>{r.name}</span>
              <DivTrack value={r.score} max={max} />
              <b className="num">{fmtLuck(r.score)}</b>
            </li>
          ))}
        </ul>
      ) : <p className="meta">No player had shots at a visible enemy to score.</p>}
      <p className="meta lk-lobby__foot">Grey names: opponents</p>
    </Card>
  );
}

/**
 * Every luck metric the source gives, grouped. A metric whose input the file lacks is left out, and
 * the card's foot says why, once per input; the luck score's reason is the hero's, so it is not repeated.
 */
function Numbers({ v, missing }: { v: MatchModel; missing: Input[] }) {
  const line = v.b.lines.both[v.human];
  const groups = LUCK_GROUPS.map((g) => ({ ...g, rows: g.rows.filter((r) => { const i = inputOf(r.id); return i === null || !missing.includes(i); }) })).filter((g) => g.rows.length);
  const gone = missing.filter((i) => i !== "spread");
  return (
    <Card title="Every luck number" tip="Per match, never ranked: luck is not a skill."
      foot={gone.length ? <ul className="lk-missing">{gone.map((i) => <li key={i} className="meta">{missingLine(i)}</li>)}</ul> : undefined}>
      <div className="lk-groups">
        {groups.map((g) => (
          <section key={g.title} className="lk-group" aria-label={g.title}>
            <h3 className="caps lk-group__h">{g.title}</h3>
            <MetricList label={g.title}>
              {g.rows.map((r) => {
                const x = line.v[r.id] ?? null;
                const balance = g.inputs.includes("spread");
                return (
                  <MetricRow key={r.id} label={metric(r.id).label} value={x === null ? null : balance ? fmtLuck(x) : fmtMetric(r.id, x)}
                    sample={r.sample(line.m)} n={r.n?.(line.m) ?? null} pct={null} kind="style" population="" tip={tipOf(r.id)} />
                );
              })}
            </MetricList>
          </section>
        ))}
      </div>
    </Card>
  );
}
