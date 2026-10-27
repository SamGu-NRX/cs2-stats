// Pieces every Leetify view shares: the link back to Leetify, the attribution Leetify's guidelines ask
// for, and the comparison table, whose middle column (the seam) says whether a row's two numbers count
// the same thing.
import type { ReactNode } from "react";
import type { LeetifyData } from "../../data/leetify/api";
import { LEETIFY_HOME } from "../../data/leetify/api";
import { oursText, type Group, type OursSource, type Row } from "../../data/leetify/present";
import { useHidePersonal } from "../../data/privacy";
import { DASH } from "../../lib/format";

/** Opens a page as the app's other outside links do: a target="_blank" anchor. lib.rs sets no new-window handler, so WebView2's default decides where it opens. */
export function openOutside(url: string) {
  const a = document.createElement("a");
  a.href = url;
  a.target = "_blank";
  a.rel = "noreferrer";
  a.click();
}

/**
 * "View on Leetify" (guidelines, section 3.1: that wording, bold or underlined). A link whose address
 * names the player is a button while personal info is hidden, so the address never enters the page.
 */
export function LeetifyLink({ url, personal, children = "View on Leetify" }: { url: string; personal?: boolean; children?: ReactNode }) {
  const hide = useHidePersonal();
  if (personal && hide) return <button type="button" className="lt-link" onClick={() => openOutside(url)}>{children}</button>;
  return <a className="lt-link" href={url} target="_blank" rel="noreferrer">{children}</a>;
}

/**
 * "Data Provided by Leetify", linking to Leetify's landing page (guidelines, sections 1 and 3.2). The
 * guidelines ask for Leetify's logo here; the logo files sit in a Google Drive folder the app does not
 * ship, so this is the guideline's wording as text until the logo is added.
 */
export function Attribution() {
  return <a className="lt-attr" href={LEETIFY_HOME} target="_blank" rel="noreferrer">Data Provided by Leetify</a>;
}

/** The dev build's stand-in data says so wherever it shows. */
export const SyntheticChip = () => <span className="chip chip--outline lt-synthetic" tabIndex={0} data-tip="Made-up data from the dev build (?leetify=synthetic), not a real player's.">Synthetic Leetify data</span>;

/** "Fetched 3 min ago" from a fetch time, against now. */
export function fetchedAgo(at: number, now = Date.now()): string {
  const min = Math.floor((now - at) / 60_000);
  if (min < 1) return "Fetched just now";
  if (min < 60) return `Fetched ${min} min ago`;
  const h = Math.floor(min / 60);
  return h < 24 ? `Fetched ${h} h ago` : `Fetched ${Math.floor(h / 24)} d ago`;
}

const SEAM = {
  same: { glyph: "=", label: "Same definition" },
  differs: { glyph: "≠", label: "Definitions differ" },
  none: { glyph: "·", label: "Nothing to compare" },
} as const;

/** The seam between the two columns: =, ≠ or ·, focusable, its note in the tooltip. */
function Seam<S>({ r }: { r: Row<S> }) {
  const s = SEAM[r.match];
  return <span className={`lt-seam lt-seam--${r.match}`} data-tip={`${s.label}. ${r.note}`} tabIndex={0} role="note" aria-label={`${s.label}: ${r.note}`}>{s.glyph}</span>;
}

/**
 * Leetify's numbers beside ours, a group per block. Each row: Leetify's label (its definition on hover),
 * Leetify's value, the seam, our value and our label. No verdict colour on either side: the two are on
 * different scales and from different samples, so neither is "better".
 */
export function CompareTable<S>({ groups, source, ours, label }: { groups: Group<S>[]; source: S; ours: OursSource | null; label: string }) {
  return (
    <div className="lt-cmp" role="table" aria-label={label}>
      <div className="lt-cmp__head" role="row">
        <span className="caps" role="columnheader">Leetify metric</span>
        <span className="caps lt-cmp__v" role="columnheader">Leetify</span>
        <span role="columnheader" className="lt-cmp__seamhead"><span className="sr-only">Same definition?</span></span>
        <span className="caps lt-cmp__v" role="columnheader">Ours</span>
        <span className="caps lt-cmp__ours" role="columnheader">Our metric</span>
      </div>
      {groups.map((g) => (
        <div key={g.title} role="rowgroup" className="lt-cmp__group">
          <div className="lt-cmp__title" role="row"><span role="rowheader" className="caps">{g.title}</span></div>
          {g.rows.map((r) => {
            const o = r.ours && ours ? oursText(r.ours, ours) : null;
            return (
              <div key={r.key} className="lt-cmp__row" role="row">
                <span role="rowheader" className="lt-cmp__label"><span className="has-def" data-tip={r.what} tabIndex={0}>{r.label}</span></span>
                <b role="cell" className="num lt-cmp__v">{r.fmt(r.value(source))}</b>
                <span role="cell" className="lt-cmp__seam"><Seam r={r} /></span>
                <span role="cell" className={`num lt-cmp__v ${o ? "" : "faint"}`}>{o ? o.text : DASH}</span>
                <span role="cell" className="meta lt-cmp__ours">{r.ours ? r.ours.label : "None here"}</span>
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

/** How many matches the import holds and how many of them have a demo here. */
export function joinedText(data: LeetifyData, joined: number): string {
  const n = data.matches.length;
  return `${n} ${n === 1 ? "match" : "matches"} from Leetify, ${joined} with a demo here`;
}
