// Data & settings, "Leetify": connect a Leetify profile, say what is fetched and that it is not saved, and
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
import { Attribution, failureText, fetchedAgo, joinedText, LEETIFY_FOLDER, LeetifyLink, SyntheticChip } from "./parts";


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

/**
 * What the import reads, where it goes and what is saved: shown before connecting and after. Leetify's
 * data is held in memory for the session only (src-tauri/src/leetify.rs), as Leetify's guidelines ask.
 */
function WhatIsFetched({ keyStore }: { keyStore: boolean }) {
  return (
    <dl className="facts facts--wide lt-facts">
      <dt>Read from Leetify</dt>
      <dd className="meta">Your Leetify profile (ratings and averages) and your recent matches, with your own numbers in each. Other players' data is dropped as it arrives.</dd>
      <dt>Leetify's data</dt>
      <dd className="meta">Fetched from Leetify when you open the app; not saved on this computer.</dd>
      <dt>Sent</dt>
      <dd className="meta">Only to Leetify's public API, over HTTPS: the SteamID or Leetify id you enter, and your API key if you add one.</dd>
      <dt>Saved on this computer</dt>
      <dd className="meta">Only whom to fetch: your SteamID or Leetify id, in <span className="mono nowrap">{LEETIFY_FOLDER}\settings.json</span>. Disconnect deletes it.</dd>
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
    if (state.busy) return;
    // the host reads and refuses what is not a player or a key, with a sentence that says why; the key
    // field empties only once the key is accepted, so a refused one can be corrected
    if (await connect(player, key.trim() || null)) {
      setKey("");
      toast("Connected to Leetify", "good");
    }
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
        <button type="submit" className="btn btn--primary press" disabled={state.busy !== null}>{busy ? "Connecting…" : "Connect"}</button>
      </div>
    </form>
  );
}

function KeyRow({ state, save, clear }: { state: LeetifyState; save: (k: string) => Promise<boolean>; clear: () => Promise<boolean> }) {
  const id = useId();
  const [key, setKey] = useState("");
  const st = state.status!;
  // any running Leetify action, not only a key action: the store runs one at a time and would decline this
  const busy = state.busy !== null;
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
    // the field keeps the key until Leetify accepts it, so a declined or refused key is not lost
    if (await save(key)) {
      setKey("");
      toast("API key saved", "good");
    }
  };
  return (
    <form className="lt-keyrow" onSubmit={submit}>
      <label htmlFor={`${id}-key`} className="meta">{st.keyError ? `The saved key could not be read (${st.keyError}). Add it again:` : "No API key: Leetify allows fewer requests."}</label>
      <input id={`${id}-key`} className="input lt-input lt-input--key" type="password" placeholder="Paste an API key" value={key} onChange={(e) => setKey(e.target.value)} autoComplete="off" spellCheck={false} required />
      <button type="submit" className="btn btn--sm press" disabled={busy}>{state.busy === "key" ? "Checking…" : "Save key"}</button>
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
  const other = l.owner === "other";
  // the summary rises in only when it replaces the form on this page, not on every visit
  const sawForm = useRef(false);
  if (st && !player) sawForm.current = true;
  return (
    <Card title="Leetify" aside={<span className="card__aside-row">{synthetic && <SyntheticChip />}<Attribution badge={!!state.data} /></span>} className="lt-connect">
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
          {other && <p className="meta lt-other" role="note">This is not the player in your matches here. Profile shows Leetify's numbers for them alone, with nothing of ours beside them, and no match is joined or listed from Leetify.</p>}
          <KeyRow state={state} save={store.saveKey} clear={store.clearKey} />
          <div className="lt-actions">
            <button type="button" className="btn btn--sm press" onClick={() => void store.refresh()} disabled={!!state.busy} aria-busy={refreshing}><RefreshIcon size={14} />Refresh</button>
            <button type="button" className="btn btn--sm btn--ghost press" disabled={!!state.busy}
              onClick={async () => { if (await store.disconnect()) toast("Disconnected from Leetify. Its data on this computer is deleted."); }}>
              Disconnect
            </button>
          </div>
          <details className="lt-more">
            <summary>What is read, sent and saved</summary>
            <WhatIsFetched keyStore={st?.keyStore ?? false} />
          </details>
        </div>
      )}
    </Card>
  );
}
