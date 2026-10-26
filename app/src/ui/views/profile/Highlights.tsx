// Highlights: your 3K-or-better rounds and won clutches across the scope's matches, newest first
// (worker highlights, stats/highlights.ts). Each row opens its round in the match's round drawer and
// draws your kills with the killfeed's icons. Profile's card lists them all with a kind filter; Home
// shows the latest few and links here.
import { useMemo, useState, type ReactNode } from "react";
import { ClutchBadge, MapThumb, MultiBadge } from "../../components/bits";
import { Card } from "../../components/Card";
import { Segmented } from "../../components/controls";
import { useCall } from "../../data/hooks";
import type { MatchEntry } from "../../data/match";
import { FlagIcon, WeaponIcon } from "../../icons/game";
import { ChevronRightIcon } from "../../icons/ui";
import { fmtMatchDay, mapName, plural } from "../../lib/format";
import { matchHref } from "../../router";
import type { HighlightKind } from "../../../stats/highlights";
import type { HighlightKill, HighlightRow, Query } from "../../../worker/protocol";
import { Empty } from "../shared";
import { LoadFailed } from "../match/LoadFailed";

type KindFilter = "all" | HighlightKind;
const KIND_LABEL: Record<HighlightKind, string> = { "3k": "3K", "4k": "4K", ace: "Ace", clutch: "1vN won" };
const KINDS: HighlightKind[] = ["3k", "4k", "ace", "clutch"];
/** Rows the full list shows before "Show more", and how many each press adds. */
const PAGE = 12;

/** A kill as the killfeed draws it: the killer's state, the gun, then what the shot went through. */
const BEFORE: { key: "blind" | "inAir"; id: string; label: string }[] = [
  { key: "blind", id: "blind", label: "Killer was flashed" },
  { key: "inAir", id: "inair", label: "Killer was in the air" },
];
const AFTER: { key: "noscope" | "smoke" | "wallbang" | "headshot"; id: string; label: string }[] = [
  { key: "noscope", id: "noscope", label: "No scope" },
  { key: "smoke", id: "smoke", label: "Through smoke" },
  { key: "wallbang", id: "wallbang", label: "Through a wall" },
  { key: "headshot", id: "headshot", label: "Headshot" },
];

function Kill({ k, size }: { k: HighlightKill; size: number }) {
  return (
    <span className="hlr__kill">
      {BEFORE.filter((f) => k[f.key] === true).map((f) => <FlagIcon key={f.key} id={f.id} label={f.label} size={size} />)}
      <WeaponIcon name={k.weapon} height={size} />
      {AFTER.filter((f) => k[f.key]).map((f) => <FlagIcon key={f.key} id={f.id} label={f.label} size={size} />)}
    </span>
  );
}

/** What the row is, in words, for its link's name. */
const describe = (h: HighlightRow, e: MatchEntry | undefined) => [
  h.kinds.filter((k) => k !== "clutch").map((k) => KIND_LABEL[k]).join(""),
  h.clutch && `1v${h.clutch.opponents} won`,
  `round ${h.round} on ${h.side}`,
  e && `${mapName(e.match.map)}, ${fmtMatchDay(e.match)}`,
].filter(Boolean).join(", ");

export function HighlightLink({ h, e, compact }: { h: HighlightRow; e: MatchEntry | undefined; compact?: boolean }) {
  const multi = h.kinds.some((k) => k !== "clutch");
  return (
    <a className={`hlr ${compact ? "hlr--compact" : ""}`} href={matchHref(h.file, "rounds", { round: h.round })} aria-label={describe(h, e)}>
      <span className="hlr__kinds">
        {multi && <MultiBadge k={h.kills} />}
        {h.clutch && <ClutchBadge vs={h.clutch.opponents} won />}
      </span>
      <span className="hlr__feed" aria-hidden>{h.feed.map((k, i) => <Kill key={i} k={k} size={compact ? 12 : 14} />)}</span>
      {compact ? (
        <span className="hlr__end" aria-hidden>
          <span className="hlr__r num"><span className={h.side === "T" ? "t-text" : "ct-text"}>{h.side}</span> R{h.round}</span>
          <span className="meta">{e ? `${mapName(e.match.map)}, ${fmtMatchDay(e.match)}` : ""}</span>
        </span>
      ) : (
        <>
          <span className="hlr__map" aria-hidden>{e && <><MapThumb map={e.match.map} size={18} /><span>{mapName(e.match.map)}</span></>}</span>
          <span className="hlr__when meta" aria-hidden>{e ? fmtMatchDay(e.match) : ""}</span>
          <span className="hlr__r num" aria-hidden><span className={h.side === "T" ? "t-text" : "ct-text"}>{h.side}</span> R{h.round}</span>
        </>
      )}
    </a>
  );
}

/** Profile: every highlight in the scope, newest first, filtered by kind, a page at a time. */
export function HighlightsCard({ q, list, sectionRef }: { q: Query; list: MatchEntry[]; sectionRef?: (el: HTMLElement | null) => void }) {
  const call = useCall("highlights", q ? [q] : null);
  const [kind, setKind] = useState<KindFilter>("all");
  const [shown, setShown] = useState(PAGE);
  const byFile = useMemo(() => new Map(list.map((e) => [e.file, e])), [list]);
  const all = call.data ?? [];
  const rows = kind === "all" ? all : all.filter((h) => h.kinds.includes(kind));
  const count = (k: HighlightKind) => all.filter((h) => h.kinds.includes(k)).length;
  const label = (text: string, n: number): ReactNode => <>{text} <span className="hl-seg__n num">{n}</span></>;
  return (
    <div id="highlights" ref={sectionRef} className="psec">
      <Card title="Highlights" id="profile-highlights" collapsible className="hlcard"
        aside={<span className="meta">{call.data ? plural(all.length, "round") : ""}</span>}>
        {call.error ? <LoadFailed what="Highlights" error={call.error} /> : !call.data ? <div className="skel" style={{ height: 220 }} /> : !all.length ? (
          <Empty text="No 3K rounds or won clutches in this filter yet." />
        ) : (
          <div className="hl-list">
            <Segmented label="Kind of highlight" value={kind} onChange={(k) => { setKind(k); setShown(PAGE); }}
              options={[{ value: "all", label: label("All", all.length) }, ...KINDS.map((k) => ({ value: k, label: label(KIND_LABEL[k], count(k)), disabled: count(k) === 0 }))]} />
            {rows.length ? (
              <ul className="hlrows" aria-label="Highlights, newest first">
                {rows.slice(0, shown).map((h) => <li key={`${h.file}|${h.round}`}><HighlightLink h={h} e={byFile.get(h.file)} /></li>)}
              </ul>
            ) : <p className="meta">None of these in this filter.</p>}
            {rows.length > shown && (
              <button className="btn btn--ghost btn--sm hl-more" onClick={() => setShown((n) => n + PAGE * 2)}>
                Show {Math.min(PAGE * 2, rows.length - shown)} more{rows.length - shown > PAGE * 2 && <span className="faint"> of {rows.length - shown}</span>}
              </button>
            )}
          </div>
        )}
      </Card>
    </div>
  );
}

/** Home: the latest few highlights, and a link to Profile's full list. */
export function HighlightsShort({ q, list, href, n = 4 }: { q: Query | null; list: MatchEntry[]; href: string; n?: number }) {
  const call = useCall("highlights", q ? [q] : null);
  const byFile = useMemo(() => new Map(list.map((e) => [e.file, e])), [list]);
  const all = call.data ?? [];
  return (
    <div className="hl__item hl__item--list">
      <span className="hl__head">
        <span className="caps">Latest highlights</span>
        {all.length > 0 && <a className="link" href={href}>All {all.length} <ChevronRightIcon size={12} /></a>}
      </span>
      {call.error ? <LoadFailed what="Highlights" error={call.error} /> : !call.data ? <div className="skel" style={{ height: 96 }} /> : !all.length ? (
        <span className="meta">No 3K rounds or won clutches yet</span>
      ) : (
        <ul className="hlrows hlrows--compact" aria-label="Latest highlights">
          {all.slice(0, n).map((h) => <li key={`${h.file}|${h.round}`}><HighlightLink h={h} e={byFile.get(h.file)} compact /></li>)}
        </ul>
      )}
    </div>
  );
}
