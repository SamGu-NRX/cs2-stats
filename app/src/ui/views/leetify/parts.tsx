// Pieces every Leetify view shares: the link back to Leetify, the attribution Leetify's guidelines ask
// for, and the comparison table, whose middle column (the seam) says whether a row's two numbers count
// the same thing.
import { useEffect, useState, type ReactNode } from "react";
import type { LeetifyBridge } from "../../../host/leetify";
import { useData } from "../../data/provider";
import type { LeetifyFailure } from "../../../host/leetify";
import type { LeetifyData } from "../../data/leetify/api";
import { LEETIFY_HOME } from "../../data/leetify/api";
import { oursText, type Group, type OursSource, type Row } from "../../data/leetify/present";
import { useHidePersonal } from "../../data/privacy";
import { DASH } from "../../lib/format";
import { OutsideLink, openOutside } from "../../components/OutsideLink";
import { pageHref } from "../../router";

export const LEETIFY_FOLDER = String.raw`%APPDATA%\BotMatchStats\leetify`;

/** A failure in plain words, with what to do next. */
export function failureText(f: LeetifyFailure, hasKey: boolean): { head: string; next: string } {
  switch (f.kind) {
    case "bad_key": return hasKey
      ? { head: "Leetify did not accept your saved API key.", next: "Remove it to connect without one, or paste a new key from leetify.com/app/developer." }
      : { head: "Leetify did not accept this API key.", next: "Copy the key again from leetify.com/app/developer, or leave the field empty to connect without one." };
    case "not_found": return { head: "Leetify has no profile for this player.", next: "Check the SteamID64 or profile link; Disconnect lets you enter another. A player Leetify has never analysed has no profile, and signing in to Leetify once starts one." };
    case "private": return { head: "This Leetify profile is private.", next: "Leetify's public API shares only public profiles. Make it public in Leetify's settings, then refresh." };
    case "rate_limited": return { head: f.retryAt ? `Leetify asked for a pause. The next attempt can run ${nextAttempt(f.retryAt)}.` : "Leetify asked for a pause.", next: hasKey ? "" : "An API key raises Leetify's limit." };
    case "network": return { head: "Could not reach Leetify.", next: "Check your connection and try again." };
    case "server": return { head: "Leetify's API returned an error.", next: "Try again later." };
    case "bad_response": return { head: "Leetify's reply was not in the shape this app reads.", next: "Leetify may have changed its API; the details below say where." };
    case "bad_input": return { head: f.message, next: "" };
    case "key_store": return { head: "Windows Credential Manager refused.", next: "Connect without a key, or try again." };
    case "storage": return { head: "The Leetify folder could not be read or written.", next: `Check that ${LEETIFY_FOLDER} is writable.` };
  }
}

const clock = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" });
const dayClock = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
/** "at 9:40 PM" today, "on Oct 28, 9:40 AM" another day. */
export function nextAttempt(at: number, now = Date.now()): string {
  const d = new Date(at);
  return d.toDateString() === new Date(now).toDateString() ? `at ${clock.format(d)}` : `on ${dayClock.format(d)}`;
}

/**
 * A Leetify view before its data is in: "Fetching from Leetify…" while it loads, the failure and the way
 * to Data & settings when it could not load. Never a number: the data is not here yet.
 */
export function LeetifyPending({ phase, error, hasKey, retry }: { phase: "loading" | "failed"; error: LeetifyFailure | null; hasKey: boolean; retry: () => void }) {
  if (phase === "loading") return <p className="meta lt-pending" role="status" aria-live="polite">Fetching from Leetify…</p>;
  const t = error ? failureText(error, hasKey) : { head: "Leetify's data did not load.", next: "" };
  return (
    <div className="lt-pending lt-pending--failed" role="status">
      <span className="meta"><span className="poor-text">{t.head}</span>{t.next ? ` ${t.next}` : ""}</span>
      <span className="lt-pending__do">
        <button type="button" className="btn btn--sm press" onClick={retry}>Try again</button>
        <a className="link lt-inline" href={pageHref("settings")}>Open Data &amp; settings</a>
      </span>
    </div>
  );
}

/**
 * "View on Leetify" (guidelines, section 3.1: that wording, bold or underlined). A link whose address
 * names the player is a button while personal info is hidden, so the address never enters the page.
 */
export function LeetifyLink({ url, personal, children = "View on Leetify" }: { url: string; personal?: boolean; children?: ReactNode }) {
  const hide = useHidePersonal();
  if (personal && hide) return <button type="button" className="lt-link" onClick={() => openOutside(url)}>{children}</button>;
  return <OutsideLink className="lt-link" href={url}>{children}</OutsideLink>;
}

/** The badge as an object URL, one fetch per bridge; null when the host has none. */
const badges = new WeakMap<LeetifyBridge, Promise<string | null>>();
export function badgeUrl(bridge: LeetifyBridge): Promise<string | null> {
  let p = badges.get(bridge);
  if (!p) {
    p = bridge.badge().then((b) => (b ? URL.createObjectURL(new Blob([b], { type: "image/png" })) : null), () => null);
    badges.set(bridge, p);
  }
  return p;
}

/**
 * "Data Provided by Leetify", linking to Leetify's landing page (guidelines, sections 1 and 3.2).
 *
 * With `badge`, wherever Leetify's numbers are on screen, it is Leetify's own "Data provided by" badge
 * (the white one, for dark backgrounds), unmodified. The guidelines grant no licence to redistribute the
 * badge, so the app ships none: the host fetches it from the file Leetify's guidelines link to and holds
 * it for the session (src-tauri/src/leetify.rs, "the badge"). Until it arrives, and whenever it cannot,
 * this is the guideline's words as a text link. Without `badge` (no Leetify data on screen) it is the text
 * alone, so nothing is fetched before the user connects.
 */
export function Attribution({ badge }: { badge?: boolean }) {
  const bridge = useData().host?.leetify ?? null;
  const [src, setSrc] = useState<string | null>(null);
  const [broken, setBroken] = useState(false);
  useEffect(() => {
    if (!badge || !bridge) return;
    let alive = true;
    void badgeUrl(bridge).then((u) => { if (alive) setSrc(u); });
    return () => { alive = false; };
  }, [badge, bridge]);
  if (!badge || !src || broken) return <OutsideLink className="lt-attr" href={LEETIFY_HOME}>Data Provided by Leetify</OutsideLink>;
  return (
    <OutsideLink className="lt-attr lt-attr--badge" href={LEETIFY_HOME}>
      <img className="lt-badge" src={src} alt="Data Provided by Leetify" width={66} height={28} onError={() => setBroken(true)} />
    </OutsideLink>
  );
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
export function CompareTable<S>({ groups, source, ours, label, solo }: { groups: Group<S>[]; source: S; ours: OursSource | null; label: string; solo?: boolean }) {
  // solo: another player's Leetify data, with nothing of ours to set beside it
  if (solo) {
    return (
      <div className="lt-cmp lt-cmp--solo" role="table" aria-label={label}>
        <div className="lt-cmp__head" role="row">
          <span className="caps" role="columnheader">Leetify metric</span>
          <span className="caps lt-cmp__v" role="columnheader">Leetify</span>
        </div>
        {groups.map((g) => (
          <div key={g.title} role="rowgroup" className="lt-cmp__group">
            <div className="lt-cmp__title" role="row"><span role="rowheader" className="caps">{g.title}</span></div>
            {g.rows.map((r) => (
              <div key={r.key} className="lt-cmp__row" role="row">
                <span role="rowheader" className="lt-cmp__label"><span className="has-def" data-tip={r.what} tabIndex={0}>{r.label}</span></span>
                <b role="cell" className="num lt-cmp__v">{r.fmt(r.value(source))}</b>
              </div>
            ))}
          </div>
        ))}
      </div>
    );
  }
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
