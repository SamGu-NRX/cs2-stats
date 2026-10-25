// One match: header with the round strip, then sub-tabs. Heavy tabs load on first use.
import { lazy, Suspense, useEffect, useState, type ComponentType } from "react";
import type { MatchView } from "../../stats/derive";
import { useData } from "../data";
import { fmtDate, fmtDuration, fmtTime, mapName } from "../format";
import { Back } from "../icons";
import { go, matchHref, type MatchTab } from "../router";
import { Segmented } from "../Segmented";
import { RoundStrip } from "./RoundStrip";
import { Scoreboard } from "./Scoreboard";

const RECON_RULE = "Kills, deaths and assists must equal the game's own round stats. Damage may be up to 1 HP per hit lower than the game's, because the hurt event truncates fractional damage, so ADR is close but not exact.";

function ReconPill({ r }: { r: NonNullable<MatchView["recon"]> }) {
  if (r.matches) return <span className="pill pill--win has-tip" tabIndex={0} data-tip={`Every round was compared with the game's own per-round stats, for every player, and matched. ${RECON_RULE}`}>Matches the game</span>;
  const diff = r.mismatches.length;
  const tip = `${r.fullyChecked} of ${r.rounds} rounds were fully compared with the game's own per-round stats.${diff ? ` ${diff} difference${diff === 1 ? "" : "s"}: ${r.mismatches.slice(0, 4).join("; ")}${diff > 4 ? "; …" : ""}.` : ""} ${RECON_RULE}`;
  return <span className={`pill ${diff ? "pill--warn" : "pill--quiet"} has-tip`} tabIndex={0} data-tip={tip}>Checked {r.fullyChecked} of {r.rounds} rounds{diff ? ` · ${diff} difference${diff === 1 ? "" : "s"}` : ""}</span>;
}

export interface TabProps { v: MatchView; focusRound: number | null; setFocusRound: (ri: number | null) => void }

const TABS: { value: MatchTab; label: string; load?: () => Promise<{ default: ComponentType<TabProps> }> }[] = [
  { value: "overview", label: "Overview" },
  { value: "detailed", label: "Detailed", load: () => import("./Detailed") },
  { value: "matrix", label: "Kill matrix", load: () => import("./KillMatrix") },
  { value: "economy", label: "Economy", load: () => import("./Economy") },
  { value: "rounds", label: "Round by round", load: () => import("./Rounds") },
  { value: "aim", label: "Aim", load: () => import("./Aim") },
  { value: "positions", label: "Positions", load: () => import("./Positions") },
];
const LAZY = Object.fromEntries(TABS.filter((t) => t.load).map((t) => [t.value, lazy(t.load!)])) as Record<string, ComponentType<TabProps>>;

function Overview({ v }: TabProps) {
  return (
    <>
      <Scoreboard v={v} team="us" />
      <Scoreboard v={v} team="them" />
    </>
  );
}

export function MatchPage({ file, tab }: { file: string; tab: MatchTab }) {
  const { client, version } = useData();
  const [v, setV] = useState<MatchView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [focusRound, setFocusRound] = useState<number | null>(null);

  useEffect(() => {
    if (!client) return;
    let alive = true;
    setError(null);
    client.match(file).then((x) => alive && setV(x), (e: Error) => alive && setError(e.message));
    return () => { alive = false; };
  }, [client, file, version]);

  if (error) {
    return (
      <div className="page"><div className="glass card empty" role="alert">
        <h2>This match could not be opened</h2>
        <p className="selectable">{error}</p>
        <button className="btn" onClick={() => go("#/matches")}>Back to matches</button>
      </div></div>
    );
  }
  if (!v || v.file !== file) {
    return <div className="page"><div className="skeleton" style={{ height: 250 }} /><div className="skeleton" style={{ height: 300 }} /></div>;
  }

  const Tab = tab === "overview" ? Overview : LAZY[tab];
  const usWon = v.result === "W";
  const resultPill = v.result === "W" ? "pill--win" : v.result === "L" ? "pill--loss" : "pill--tie";
  const tabOptions = TABS.map((t) => ({
    value: t.value, label: t.label,
    disabled: (t.value === "aim" && !v.hasAim) || (t.value === "positions" && !v.hasPos && !v.rounds.some((r) => r.kills.some((k) => k.vpos))),
    tip: t.value === "aim" && !v.hasAim ? "This match has no aim data. The capture plugin records it for new matches." : undefined,
  }));

  return (
    <div className="page fade-in">
      <section className="glass mhead" style={{ borderRadius: "var(--r-lg)" }} aria-label="Match summary">
        <div className="mhead__top">
          <div className="mhead__meta">
            <button className="btn btn--ghost" style={{ marginLeft: -8 }} onClick={() => go("#/matches")}><Back /> Matches</button>
            <strong>{mapName(v.map)}</strong>
            <span>·</span><span>{fmtDate(v.startUtc)}, {fmtTime(v.startUtc)}</span>
            <span>·</span><span>{fmtDuration(v.startUtc, v.endUtc)}</span>
            <span>·</span><span>MR{(v.env.maxrounds ?? 24) / 2}</span>
          </div>
          <span style={{ display: "flex", gap: 6 }}>
            {v.env.plugin === "synthetic-demo" && <span className="pill pill--warn" data-tip="Generated data for checking the Aim and Positions views. Not a real match.">Synthetic demo</span>}
            {v.recon && <ReconPill r={v.recon} />}
            {v.env.plugin === "legacy-convert" && <span className="pill pill--quiet" data-tip="Converted from the older server snapshot and event log. Aim and position samples do not exist for it; bot equipment is rebuilt from purchases.">Converted log</span>}
            <span className={`pill ${resultPill}`}>{v.result === "W" ? "Win" : v.result === "L" ? "Loss" : "Tie"}</span>
          </span>
        </div>
        <div className="mhead__score">
          <div className="mhead__team">
            <span className="mhead__team-name">Your team</span>
            <span className="note">{v.players[v.human].name} and {v.players.filter((p) => p.team === "us").length - 1} bots</span>
          </div>
          <div className="mhead__nums" aria-label={`Score ${v.score.us} to ${v.score.them}`}>
            <span className={usWon ? "" : "lose"} style={usWon ? { color: "var(--c-blue)" } : undefined}>{v.score.us}</span>
            <span className="colon">:</span>
            <span className={usWon ? "lose" : ""}>{v.score.them}</span>
          </div>
          <div className="mhead__team mhead__team--them">
            <span className="mhead__team-name">Opponents</span>
            <span className="note">{v.players.filter((p) => p.team === "them").length} bots</span>
          </div>
        </div>
        <RoundStrip v={v} onRound={(ri) => { setFocusRound(ri); go(matchHref(file, "rounds")); }} />
        {v.captured < v.nRounds && (
          <p className="note" style={{ marginTop: 12 }}>
            <span className="pill pill--warn" style={{ marginRight: 8 }}>Partial</span>
            The kill-by-kill log covers {v.captured} of {v.nRounds} rounds{v.firstFullRound > 0 ? ` (from round ${v.firstFullRound + 1})` : ""}.{" "}
            {v.statRounds === v.nRounds
              ? <>K–D, ADR, KAST and rating cover all {v.nRounds} rounds from the game's round totals; opening duels, trades, clutches, sniping, utility and swing cover the {v.captured} round{v.captured === 1 ? "" : "s"} with the log.</>
              : <>Player stats cover {v.statRounds} of {v.nRounds} rounds; the score and round results cover the whole match.</>}
          </p>
        )}
      </section>

      <div className="tabs">
        <Segmented kind="tabs" panelId="match-panel" label="Match views" value={tab} options={tabOptions} onChange={(t) => go(matchHref(file, t))} />
      </div>

      <Suspense fallback={<div className="skeleton" style={{ height: 320 }} />}>
        <div id="match-panel" role="tabpanel" aria-labelledby={`match-panel-tab-${tab}`} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <Tab v={v} focusRound={focusRound} setFocusRound={setFocusRound} />
        </div>
      </Suspense>
    </div>
  );
}
