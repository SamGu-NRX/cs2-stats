// Data & settings, "Leetify": connect a Leetify profile, say what is fetched and where it stays, and
// manage the optional API key. The key goes straight from the field to the host, which checks it with
// Leetify and keeps it in Windows Credential Manager (src-tauri/src/leetify.rs); the field is cleared
// right after, and the page never reads the key back.
import { useId, useRef, useState, type FormEvent } from "react";
import type { LeetifyFailure } from "../../../host/leetify";
import { Card } from "../../components/Card";
import { toast } from "../../components/overlay";
import { LEETIFY_DEVELOPER } from "../../data/leetify/api";
import { useLeetify, useLeetifyJoin, type LeetifyState } from "../../data/leetify/store";
import { useHidePersonal } from "../../data/privacy";
import { useData } from "../../data/provider";
import { RefreshIcon } from "../../icons/ui";
import { pageHref } from "../../router";
import { Attribution, fetchedAgo, joinedText, LeetifyLink, SyntheticChip } from "./parts";

export const LEETIFY_FOLDER = String.raw`%APPDATA%\BotMatchStats\leetify`;

/** A failure in plain words, with what to do next. */
export function failureText(f: LeetifyFailure, hasKey: boolean): { head: string; next: string } {
  switch (f.kind) {
    case "bad_key": return hasKey
      ? { head: "Leetify did not accept your saved API key.", next: "Remove it to connect without one, or paste a new key from leetify.com/app/developer." }
      : { head: "Leetify did not accept this API key.", next: "Copy the key again from leetify.com/app/developer, or leave the field empty to connect without one." };
    case "not_found": return { head: "Leetify has no profile for this player.", next: "Check the SteamID64 or profile link; Disconnect lets you enter another. A player Leetify has never analysed has no profile, and signing in to Leetify once starts one." };
    case "private": return { head: "This Leetify profile is private.", next: "Leetify's public API shares only public profiles. Make it public in Leetify's settings, then refresh." };
    case "rate_limited": return { head: `Leetify asked for a pause${f.retryAfterS ? ` of ${f.retryAfterS} s` : ""}.`, next: hasKey ? "Try again after it." : "Try again after it. An API key raises Leetify's limit." };
    case "network": return { head: "Could not reach Leetify.", next: "Check your connection and try again. Data already fetched stays." };
    case "server": return { head: "Leetify's API returned an error.", next: "Try again later. Data already fetched stays." };
    case "bad_response": return { head: "Leetify's reply was not in the shape this app reads.", next: "Leetify may have changed its API; the details below say where." };
    case "bad_input": return { head: f.message, next: "" };
    case "key_store": return { head: "Windows Credential Manager refused.", next: "Connect without a key, or try again." };
    case "storage": return { head: "The Leetify folder could not be read or written.", next: `Check that ${LEETIFY_FOLDER} is writable.` };
  }
}

function Failure({ f, hasKey }: { f: LeetifyFailure; hasKey: boolean }) {
  const t = failureText(f, hasKey);
  const detail = f.kind !== "bad_input" && f.message && f.message !== t.head ? f.message : null;
  return (
    <div className="settings__failed lt-failed" role="alert">
      <p><b>{t.head}</b>{t.next ? ` ${t.next}` : ""}</p>
      {detail && <details><summary>Details</summary><p className="mono selectable">{detail}</p></details>}
    </div>
  );
}

/** What the import reads, where it goes and where it stays: shown before connecting and after. */
function WhatIsFetched({ keyStore }: { keyStore: boolean }) {
  return (
    <dl className="facts facts--wide lt-facts">
      <dt>Read from Leetify</dt>
      <dd className="meta">Your Leetify profile (ratings and averages) and your recent matches, with your own numbers in each. Nothing about other players is kept.</dd>
      <dt>Sent</dt>
      <dd className="meta">Only to Leetify's public API, over HTTPS: the SteamID or Leetify id you enter, and your API key if you add one.</dd>
      <dt>Kept on this computer</dt>
      <dd className="meta">In <span className="mono nowrap">{LEETIFY_FOLDER}</span>, for a day at most. Each refresh replaces it; Disconnect deletes it, and so does Leetify no longer returning the profile.</dd>
      <dt>API key</dt>
      <dd className="meta">{keyStore ? "In Windows Credential Manager, never in a file. Only Leetify receives it." : "Not available here: the key needs Windows Credential Manager. Connect without one."}</dd>
    </dl>
  );
}

function ConnectForm({ state, connect, valveUser }: { state: LeetifyState; connect: (player: string, key: string | null) => Promise<boolean>; valveUser: string | null }) {
  const id = useId();
  const [player, setPlayer] = useState("");
  const [key, setKey] = useState("");
  const busy = state.busy === "connect";
  const canKey = state.status?.keyStore ?? false;
  // a SteamID in the field would show in a screenshot
  const hide = useHidePersonal();
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    // the host reads and refuses what is not a player or a key, with a sentence that says why
    const k = key.trim() || null;
    setKey("");
    if (await connect(player, k)) toast("Connected to Leetify", "good");
  };
  return (
    <form className="lt-form" onSubmit={submit} aria-busy={busy}>
      <div className="lt-field">
        <label htmlFor={`${id}-player`}>SteamID64 or Leetify profile link</label>
        <div className="lt-field__row">
          <input id={`${id}-player`} className="input lt-input" type={hide ? "password" : "text"} value={player} onChange={(e) => setPlayer(e.target.value)} placeholder="7656119… or leetify.com/app/profile/…"
            autoComplete="off" spellCheck={false} required aria-describedby={`${id}-player-hint`} />
          {valveUser && <button type="button" className="btn btn--sm btn--ghost press" onClick={() => setPlayer(valveUser)}>Use my Valve SteamID</button>}
        </div>
        <span className="meta" id={`${id}-player-hint`}>The 17-digit number in your Steam profile's address, or your profile's address on Leetify.</span>
      </div>
      {canKey && (
        <div className="lt-field">
          <label htmlFor={`${id}-key`}>API key <span className="faint">optional</span></label>
          <input id={`${id}-key`} className="input lt-input" type="password" value={key} onChange={(e) => setKey(e.target.value)} autoComplete="off" spellCheck={false} aria-describedby={`${id}-key-hint`} />
          <span className="meta" id={`${id}-key-hint`}>Without one, Leetify allows fewer requests. Create one at <LeetifyLink url={LEETIFY_DEVELOPER}>leetify.com/app/developer</LeetifyLink>.</span>
        </div>
      )}
      <div className="lt-form__go">
        <button type="submit" className="btn btn--primary press" disabled={busy}>{busy ? "Connecting…" : "Connect"}</button>
      </div>
    </form>
  );
}

function KeyRow({ state, save, clear }: { state: LeetifyState; save: (k: string) => Promise<boolean>; clear: () => Promise<boolean> }) {
  const id = useId();
  const [key, setKey] = useState("");
  const st = state.status!;
  const busy = state.busy === "key";
  if (!st.keyStore) return <p className="meta">Connected without an API key: this computer has no Windows Credential Manager to keep one in.</p>;
  if (st.hasKey) {
    return (
      <div className="lt-keyrow">
        <span className="meta">API key saved in Windows Credential Manager.</span>
        <button type="button" className="btn btn--sm btn--ghost press" disabled={busy} onClick={async () => { if (await clear()) toast("API key removed"); }}>Remove key</button>
      </div>
    );
  }
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const k = key;
    setKey("");
    if (await save(k)) toast("API key saved", "good");
  };
  return (
    <form className="lt-keyrow" onSubmit={submit}>
      <label htmlFor={`${id}-key`} className="meta">{st.keyError ? `The saved key could not be read (${st.keyError}). Add it again:` : "No API key: Leetify allows fewer requests."}</label>
      <input id={`${id}-key`} className="input lt-input lt-input--key" type="password" placeholder="Paste an API key" value={key} onChange={(e) => setKey(e.target.value)} autoComplete="off" spellCheck={false} required />
      <button type="submit" className="btn btn--sm press" disabled={busy}>{busy ? "Checking…" : "Save key"}</button>
    </form>
  );
}

export function LeetifyConnect() {
  const l = useLeetify();
  const j = useLeetifyJoin();
  const { host } = useData();
  if (!l) {
    return (
      <Card title="Leetify" aside={<Attribution />}>
        <p className="meta">Connecting a Leetify profile needs the desktop app, which sends the requests.</p>
      </Card>
    );
  }
  const { state, store } = l;
  const st = state.status;
  const player = st?.player ?? null;
  const hasKey = st?.hasKey ?? false;
  const synthetic = !!st?.synthetic;
  const refreshing = state.busy === "refresh" || (state.busy === "connect" && !!player);
  const data = state.data;
  // the summary rises in only when it replaces the form on this page, not on every visit
  const sawForm = useRef(false);
  if (st && !player) sawForm.current = true;
  return (
    <Card title="Leetify" aside={<span className="card__aside-row">{synthetic && <SyntheticChip />}<Attribution /></span>} className="lt-connect">
      {state.error && <Failure f={state.error} hasKey={hasKey} />}
      {state.starting && !st ? <div className="skel" style={{ height: 120 }} aria-busy="true" /> : !player ? (
        <div className="lt-connect__body">
          <p className="meta lt-lede">Bring in your Leetify history to see it beside your demos. Matches without a demo here still list in Matches, marked Leetify.</p>
          <ConnectForm state={state} connect={store.connect} valveUser={host?.valve?.user ?? null} />
          <WhatIsFetched keyStore={st?.keyStore ?? false} />
        </div>
      ) : (
        <div className={`lt-connect__body lt-connected${sawForm.current ? " lt-arrive" : ""}`} key={`${player.kind}:${player.id}`}>
          <div className="lt-who">
            <div className="lt-who__id">
              <b className="lt-who__name">{data?.profile.name ?? "Connected"}</b>
              <span className="mono meta selectable">{player.kind === "steam" ? "SteamID64" : "Leetify id"} {player.id}</span>
            </div>
            {data && <LeetifyLink url={data.profile.url} personal />}
          </div>
          <p className="meta lt-status" role="status" aria-live="polite">
            {refreshing ? "Fetching from Leetify…" : data ? <>{fetchedAgo(data.fetchedAt)}. {j ? joinedText(data, j.joined.byFile.size) : ""}. <a className="link lt-inline" href={pageHref("matches")}>Open Matches</a></> : "Nothing fetched yet."}
          </p>
          <KeyRow state={state} save={store.saveKey} clear={store.clearKey} />
          <div className="lt-actions">
            <button type="button" className="btn btn--sm press" onClick={() => void store.refresh()} disabled={!!state.busy} aria-busy={refreshing}><RefreshIcon size={14} />Refresh</button>
            <button type="button" className="btn btn--sm btn--ghost press" disabled={!!state.busy}
              onClick={async () => { if (await store.disconnect()) toast("Disconnected from Leetify. Its data on this computer is deleted."); }}>
              Disconnect
            </button>
          </div>
          <details className="lt-more">
            <summary>What is read, sent and kept</summary>
            <WhatIsFetched keyStore={st?.keyStore ?? false} />
          </details>
        </div>
      )}
    </Card>
  );
}
