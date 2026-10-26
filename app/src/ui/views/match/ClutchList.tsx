// Every clutch of the match, both teams (worker clutches, stats/closing.ts): the round, 1vN, won, saved
// or lost, the kills made in it and the clock when it began. A row opens its round in the drawer.
import { useMemo } from "react";
import { ClutchBadge } from "../../components/bits";
import { Card } from "../../components/Card";
import { DataTable, type Column } from "../../components/DataTable";
import { useCall } from "../../data/hooks";
import { WeaponIcon } from "../../icons/game";
import { fmtClock } from "../../lib/format";
import { go, matchHref } from "../../router";
import type { ClutchRow } from "../../../worker/protocol";
import { PlayerName, SectionAside } from "../shared";
import { LoadFailed } from "./LoadFailed";
import type { TabProps } from "./MatchView";

type Row = ClutchRow & { pi: number };

const RESULT = { won: "Won", saved: "Saved", lost: "Lost" } as const;
const resultOf = (c: ClutchRow): keyof typeof RESULT => (c.won ? "won" : c.saved ? "saved" : "lost");

/** Why a clutch has no time left: the clock it would read is not in the file. */
const noClock = (c: ClutchRow) => (c.afterPlant
  ? "No bomb exploded in this match, so its bomb timer is unknown."
  : "This file records no round timer, and no round of the match ran out of time.");

export function ClutchList({ v, file }: { v: TabProps["v"]; file: string }) {
  const ids = useMemo(() => v.players.map((p) => p.key), [v.players]);
  const call = useCall("clutches", [{ files: [file], filter: { player: ids } }]);
  const rows: Row[] = useMemo(() => {
    const pi = new Map(v.players.map((p) => [p.key, p.pi]));
    // another match's clutches never show, not even while this match's load
    return (call.stale ? [] : call.data ?? []).flatMap((c) => (c.player !== undefined && pi.has(c.player) ? [{ ...c, pi: pi.get(c.player)! }] : []));
  }, [call.data, call.stale, v.players]);
  const of = (t: "us" | "them") => rows.filter((c) => v.players[c.pi].team === t);
  const mine = rows.filter((c) => c.pi === v.human);
  const open = (c: Row) => go(matchHref(file, "rounds", { round: c.round }));
  const columns: Column<Row>[] = [
    { key: "round", label: "Round", align: "l", width: 60, sort: (c) => c.round, render: (c) => <a className="num clutchtbl__r" href={matchHref(file, "rounds", { round: c.round })} onClick={(e) => e.stopPropagation()}>R{c.round}</a> },
    { key: "player", label: "Player", align: "l", sort: (c) => v.players[c.pi].name, render: (c) => <span className={`name-cell ${c.side === "T" ? "t-text" : "ct-text"}`}><PlayerName v={v} pi={c.pi} /></span> },
    { key: "vs", label: "Vs", tip: "Enemies alive when the player became the last of their side", width: 52, sort: (c) => c.opponents, render: (c) => <ClutchBadge vs={c.opponents} won={c.won} /> },
    { key: "res", label: "Result", tip: "Saved: lost the round but survived it", width: 68, sort: (c) => (c.won ? 2 : c.saved ? 1 : 0), colored: true, render: (c) => <span className={`clutchtbl__res is-${resultOf(c)}`}>{RESULT[resultOf(c)]}</span> },
    { key: "kills", label: "Kills", tip: "Enemy kills after the clutch began", width: 56, sort: (c) => c.kills ?? null, render: (c) => <span className="num">{c.kills ?? "–"}</span> },
    {
      key: "left", label: "Left", tip: "The clock when the clutch began: the round timer, or the bomb's after a plant", width: 76, sort: (c) => c.left,
      render: (c) => (c.left === null
        ? <span className="faint" data-tip={noClock(c)} tabIndex={0}>–</span>
        : <span className="clutchtbl__left" tabIndex={0} data-tip={`Began ${fmtClock(c.t)} into the round${c.afterPlant ? ", after the plant" : ""}`}>{c.afterPlant && <WeaponIcon name="c4" height={12} />}<span className="num">{fmtClock(c.left)}</span></span>),
    },
  ];
  return (
    <Card title="Every clutch" className="clutchtbl" flush id="match-clutch-list" collapsible
      aside={<>
        <SectionAside label="You won" value={<>{mine.filter((c) => c.won).length}<span className="faint">/{mine.length}</span></>} color="var(--cream)" />
        <SectionAside label="Saved" value={mine.filter((c) => c.saved).length} />
      </>}>
      {call.error && !call.stale ? <div className="tabpad"><LoadFailed what="The clutches" error={call.error} /></div> : !call.data || call.stale ? <div className="skel" style={{ height: 160, margin: 12 }} /> : !rows.length ? (
        <p className="meta clutchtbl__none">Nobody was left alone against the other side this match.</p>
      ) : (
        <div className="clutchtbl__cols">
          {(["us", "them"] as const).map((t) => (
            <section key={t} aria-label={t === "us" ? "Your team's clutches" : "Opponents' clutches"}>
              <h3 className="caps clutchtbl__h">{t === "us" ? "Your team" : "Opponents"}</h3>
              {of(t).length ? (
                <DataTable<Row>
                  label={t === "us" ? "Your team's clutches" : "Opponents' clutches"}
                  rows={of(t)}
                  rowKey={(c) => `${c.round}-${c.pi}`}
                  defaultSort={{ key: "round", dir: "asc" }}
                  onOpen={open}
                  rowClass={(c) => (c.pi === v.human ? "is-you" : undefined)}
                  columns={columns}
                />
              ) : <p className="meta clutchtbl__none">No clutches.</p>}
            </section>
          ))}
        </div>
      )}
    </Card>
  );
}
