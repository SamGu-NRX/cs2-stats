// The Demos card in Data & settings (design/recording.md, Settings and UI): the demos CS2 recorded of
// Bot Mode matches, the space they take against the cap, why each is kept, the limits, the last failed
// extraction, and pin and delete. The host keeps the store and decides what a sweep deletes
// (src-tauri demos.rs); this card shows it, adds the match and best moment each demo holds (data/
// demos.ts demoViews), and sends the user's choices. With personal info hidden, the folder path and the
// importer's error text are hidden; demo ids hold nothing personal.
import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from "react";
import type { DemoPolicy, DemoStore } from "../../host/demos";
import { POINTS } from "../../stats/moments";
import { useKeepFailure } from "../shell/DemoKeeper";
import { ScoreCell } from "../components/bits";
import { Card } from "../components/Card";
import { copyText, toast } from "../components/overlay";
import { demoViews, failureText, fmtSize, KEPT_LABEL, keptTotals, type DemoView } from "../data/demos";
import { useDemosHost, useLocalMoments } from "../data/demos-hooks";
import { FOLDER_HIDDEN, hideTextAndFiles, useHidePersonal } from "../data/privacy";
import { useData } from "../data/provider";
import { CopyIcon, FolderIcon, PinIcon, TrashIcon } from "../icons/ui";
import { mapName } from "../lib/format";
import { matchHref, pageHref } from "../router";

const dayFmt = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" });
const timeFmt = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" });
const GB = 2 ** 30;
const gbOf = (bytes: number) => Math.round((bytes / GB) * 10) / 10;

/** What a pairing means, for the match cell's tooltip. */
const PAIR_TIP = {
  rounds: "The capture plugin recorded this match too; its file was matched to this demo by the timing of their rounds. This demo is the one that counts.",
  time: "The capture plugin recorded this match too; its file was matched to this demo by start time. This demo is the one that counts.",
  none: "No plugin file of this match was found; the demo stands alone.",
} as const;

export function DemosCard() {
  const host = useDemosHost();
  const { version, matches } = useData();
  const [store, setStore] = useState<DemoStore | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const { moments } = useLocalMoments();
  const keepFailure = useKeepFailure();
  const hide = useHidePersonal();

  useEffect(() => {
    if (!host) return;
    let alive = true;
    host.status().then((s) => { if (alive) { setStore(s); setLoadError(null); } }, (e: unknown) => alive && setLoadError(String(e)));
    return () => { alive = false; };
  }, [host, version]);

  const views = useMemo(() => {
    if (!store) return [];
    const v = demoViews(store.demos, matches, moments ?? []);
    // the ?demos= stand-in has no tables; its own sample fills the app's part (host/demos-mock.ts)
    const sample = host?.sample;
    return sample ? v.map((d) => {
      const f = sample[d.id];
      return f ? { ...d, pairedMatch: { file: f.file, result: f.result, score: { us: f.us, them: f.them }, plugin: f.plugin }, bestMoment: f.bestMoment, bestMomentScore: f.bestMomentScore } : d;
    }) : v;
  }, [store, matches, moments, host]);

  /** Runs one change and shows the store it returns; a refusal says why and changes nothing. */
  const act = async (run: () => Promise<DemoStore>, done?: string): Promise<boolean> => {
    try {
      setStore(await run());
      if (done) toast(done, "good");
      return true;
    } catch (e) {
      toast(hide ? hideTextAndFiles(String(e), []) : String(e), "poor", 6000);
      return false;
    }
  };

  if (host === undefined) return null;
  if (host === null) {
    return (
      <Card title="Recorded demos" id="settings-demos">
        <p className="meta">The desktop app keeps the demos CS2 records in Bot Mode matches, and shows them here.</p>
      </Card>
    );
  }
  const folder = store?.folder ?? null;
  return (
    <Card title="Recorded demos" id="settings-demos" className="demos"
      aside={folder ? (
        <span className="source__path demos__folder">
          <FolderIcon size={14} />
          <span className="mono selectable">{hide ? FOLDER_HIDDEN.demos : folder}</span>
          <button className="btn btn--ghost btn--icon btn--sm" onClick={() => copyText(folder, "Folder path copied", FOLDER_HIDDEN.demos)} aria-label="Copy the demos folder path"><CopyIcon size={14} /></button>
        </span>
      ) : undefined}>
      {loadError && <p className="poor-text selectable" role="alert">The demos folder could not be read: {hide ? hideTextAndFiles(loadError, []) : loadError}</p>}
      {store && (
        <>
          <Space store={store} views={views} />
          {store.held && <Held held={store.held} />}
          <Limits store={store} onSave={(p) => act(() => host.setPolicy(p, { capGb: store.cap / GB, floorGb: store.floor / GB, keepLast: store.keepLast }), "Demo limits saved")} />
          {store.lastFailure && <LastFailure failure={store.lastFailure} hide={hide} />}
          {keepFailure && <p className="meta demos__note"><span className="poor-text">The demos with clips to render could not be sent to the store:</span> {hide ? hideTextAndFiles(keepFailure, []) : keepFailure}. It tries again after the next scan.</p>}
          {views.length ? (
            <DemoList views={views} onPin={(d, on) => act(() => host.pin(d.id, on), on ? `Pinned the ${mapName(d.map)} demo` : `Unpinned the ${mapName(d.map)} demo`)}
              onDelete={(d) => act(() => host.remove(d.id), `Deleted the ${mapName(d.map)} demo from ${dayFmt.format(new Date(d.createdUtc))}. ${d.pairedMatch ? "Its match stays in your list." : ""}`.trim())} />
          ) : (
            <p className="meta demos__empty">
              No demos yet. With <a href={pageHref("botmode")}>Record demos (GOTV)</a> on, Bot Mode records each match, and the demo shows here once CS2 has closed.
            </p>
          )}
        </>
      )}
    </Card>
  );
}

/** The space the demos take against the cap, by why they are kept, with the disk's free space and the floor. */
function Space({ store, views }: { store: DemoStore; views: DemoView[] }) {
  const groups = keptTotals(views);
  const scale = Math.max(store.cap, store.used, 1);
  const label = `Demos use ${fmtSize(store.used)} of the ${fmtSize(store.cap)} cap${groups.length ? `: ${groups.filter((g) => g.bytes > 0).map((g) => `${KEPT_LABEL[g.as].toLowerCase()} ${fmtSize(g.bytes)}`).join(", ")}` : ""}.`;
  return (
    <div className="demos__space">
      <div className="demos__figures">
        <span><b className="num demos__used">{fmtSize(store.used)}</b> <span className="meta">of {fmtSize(store.cap)}</span></span>
        <span className="meta">
          {store.free === null ? <span className="poor-text">Free space could not be read</span> : <>{fmtSize(store.free)} free on this disk</>}
          <span aria-hidden> · </span>recording stops under {fmtSize(store.floor)}
        </span>
      </div>
      <div className="demos__bar" role="img" aria-label={label}>
        {groups.filter((g) => g.bytes > 0).map((g) => <span key={g.as} className="demos__seg" data-as={g.as} style={{ width: `${(100 * g.bytes) / scale}%` }} />)}
        {store.used > store.cap && <span className="demos__cap" style={{ left: `${(100 * store.cap) / scale}%` }} aria-hidden />}
      </div>
      {groups.length > 0 && (
        <ul className="demos__legend">
          {groups.map((g) => (
            <li key={g.as}><i data-as={g.as} aria-hidden /><span>{KEPT_LABEL[g.as]}</span> <b className="num">{g.n}</b>{g.bytes > 0 && <span className="faint num"> {fmtSize(g.bytes)}</span>}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** A limit still breached with nothing left a sweep may delete. */
function Held({ held }: { held: NonNullable<DemoStore["held"]> }) {
  const which = held.overCap && held.underFloor ? "over the cap, and the disk is under the floor" : held.overCap ? "over the cap" : "under the free-space floor";
  return (
    <p className="demos__held" role="status">
      <b>The demos are {which}</b>, and every demo left is pinned or not yet extracted, which a sweep never deletes. Recording stops while the disk is under the floor. Unpin or delete a demo below, or raise the cap.
    </p>
  );
}

/** The cap, the floor and how many of the newest are always kept; saved together. */
function Limits({ store, onSave }: { store: DemoStore; onSave: (p: DemoPolicy) => Promise<boolean> }) {
  const id = useId();
  const shown = { capGb: gbOf(store.cap), floorGb: gbOf(store.floor), keepLast: store.keepLast };
  const [draft, setDraft] = useState(shown);
  const [busy, setBusy] = useState(false);
  // a store that changed elsewhere (a save, another window) resets the fields to it
  const key = `${shown.capGb}|${shown.floorGb}|${shown.keepLast}`;
  useEffect(() => { setDraft(shown); }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  const bad = !(draft.capGb >= 1) ? "The cap must be at least 1 GB." : !(draft.floorGb >= 0) ? "The floor must be 0 or more." : !(Number.isInteger(draft.keepLast) && draft.keepLast >= 0 && draft.keepLast <= 1000) ? "Keep between 0 and 1000 of the newest." : null;
  const changed = draft.capGb !== shown.capGb || draft.floorGb !== shown.floorGb || draft.keepLast !== shown.keepLast;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (bad || !changed) return;
    setBusy(true);
    await onSave(draft);
    setBusy(false);
  };
  const num = (k: keyof DemoPolicy, label: string, unit: string | null, step: number, min: number, max?: number) => (
    <label className="demos__limit" htmlFor={`${id}-${k}`}>
      <span className="meta">{label}</span>
      <span className="demos__input">
        <input id={`${id}-${k}`} className="input num" type="number" inputMode="decimal" step={step} min={min} max={max} value={Number.isNaN(draft[k]) ? "" : draft[k]}
          aria-describedby={bad ? `${id}-bad` : undefined} onChange={(e) => setDraft((d) => ({ ...d, [k]: e.target.valueAsNumber }))} />
        {unit && <span className="meta">{unit}</span>}
      </span>
    </label>
  );
  return (
    <form className="demos__limits" onSubmit={submit}>
      {num("capGb", "Keep at most", "GB", 1, 1)}
      {num("floorGb", "Stop recording under", "GB free", 1, 0)}
      {num("keepLast", "Always keep the newest", null, 1, 0, 1000)}
      <button className="btn press" type="submit" disabled={!changed || !!bad || busy} aria-busy={busy}>{busy ? "Saving…" : "Save limits"}</button>
      {bad && <p className="poor-text demos__bad" id={`${id}-bad`} role="alert">{bad}</p>}
    </form>
  );
}

function LastFailure({ failure, hide }: { failure: NonNullable<DemoStore["lastFailure"]>; hide: boolean }) {
  const [, , map] = /^(\d{8}T\d{4}Z)_(.+)_[0-9a-f]{8}$/.exec(failure.id) ?? [];
  return (
    <div className="demos__failure">
      <p><b>Last failed extraction{map ? `, ${mapName(map)}` : ""}.</b> {failureText(failure.reason)} The demo is kept, and tried again when the extractor is updated.</p>
      {failure.detail && <details><summary>Details</summary><p className="mono selectable">{hide ? hideTextAndFiles(failure.detail, []) : failure.detail}</p></details>}
    </div>
  );
}

/** Why deleting this demo needs a second look, or null: the user's delete is not limited like a sweep's. */
function deleteWarning(d: DemoView): string | null {
  if (d.state === "taken") return "Not extracted yet: its match is lost with it.";
  if (d.state === "failed") return "Its extraction failed and waits for a newer extractor; its match is lost with it.";
  if (d.pinned) return "Pinned.";
  return null;
}

function DemoList({ views, onPin, onDelete }: { views: DemoView[]; onPin: (d: DemoView, on: boolean) => Promise<boolean>; onDelete: (d: DemoView) => Promise<boolean> }) {
  const [confirming, setConfirming] = useState<string | null>(null);
  return (
    <div className="tbl-wrap">
      <table className="tbl demos__list">
        <thead>
          <tr>
            <th className="l"><span className="th">Demo</span></th>
            <th className="l"><span className="th">Match</span></th>
            <th className="l"><span className="th">Best moment</span></th>
            <th className="r"><span className="th">Size</span></th>
            <th className="l"><span className="th">Kept because</span></th>
            <th className="r"><span className="sr-only">Actions</span></th>
          </tr>
        </thead>
        <tbody>
          {views.map((d) => (
            <DemoRowView key={d.id} d={d} confirming={confirming === d.id} onConfirm={(on) => setConfirming(on ? d.id : null)} onPin={onPin} onDelete={onDelete} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function matchCell(d: DemoView) {
  if (d.state === "missing") return <span className="faint">Gone</span>;
  if (d.state === "taken") return <span className="faint">Not extracted yet</span>;
  if (d.state === "failed") return <span className="poor-text">Extraction failed</span>;
  if (!d.pairedMatch) return <span className="faint has-def" tabIndex={0} data-tip="Its tables are not in the match list; rescan, or see Files that could not be read.">Not listed</span>;
  return (
    <a className="demos__match" href={matchHref(d.pairedMatch.file)} data-tip={PAIR_TIP[d.pairedMatch.plugin ?? "none"]}>
      <ScoreCell us={d.pairedMatch.score.us} them={d.pairedMatch.score.them} result={d.pairedMatch.result} />
      {d.pairedMatch.plugin && <span className="faint demos__paired">+ plugin</span>}
    </a>
  );
}

function DemoRowView({ d, confirming, onConfirm, onPin, onDelete }: {
  d: DemoView; confirming: boolean; onConfirm: (on: boolean) => void;
  onPin: (d: DemoView, on: boolean) => Promise<boolean>; onDelete: (d: DemoView) => Promise<boolean>;
}) {
  const confirmBtn = useRef<HTMLButtonElement>(null);
  const deleteBtn = useRef<HTMLButtonElement>(null);
  const [busy, setBusy] = useState(false);
  // the confirm button takes focus when it appears, and focus goes back to Delete when it is cancelled
  useEffect(() => { if (confirming) confirmBtn.current?.focus(); }, [confirming]);
  const cancel = () => { onConfirm(false); requestAnimationFrame(() => deleteBtn.current?.focus()); };
  const when = new Date(d.createdUtc);
  const what = `${mapName(d.map)} demo from ${dayFmt.format(when)}`;
  const warning = deleteWarning(d);
  const worth = d.bestMomentScore !== null && d.bestMomentScore >= POINTS.k3;
  const run = async (f: () => Promise<boolean>) => { setBusy(true); await f(); setBusy(false); };
  return (
    <tr data-as={d.as}>
      <td className="l">
        <span className="demos__demo">
          <b>{mapName(d.map)}</b>
          <span className="meta num">{dayFmt.format(when)}, {timeFmt.format(when)}</span>
        </span>
      </td>
      <td className="l">{matchCell(d)}</td>
      <td className="l demos__moment">
        {d.bestMoment ? <span className={worth ? undefined : "meta"} data-tip={worth ? "Worth a clip: it keeps this demo until the clip is rendered." : undefined}>{d.bestMoment}</span> : <span className="faint">–</span>}
      </td>
      <td className="r num">{d.state === "missing" ? <span className="faint">–</span> : fmtSize(d.size)}</td>
      <td className="l"><span className="demos__kept"><i data-as={d.as} aria-hidden />{KEPT_LABEL[d.as]}</span></td>
      <td className="r">
        {d.state !== "missing" && (confirming ? (
          <span className="demos__confirm" role="group" aria-label={`Delete the ${what}?`} onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); cancel(); } }}>
            {warning && <span className="poor-text demos__warn">{warning}</span>}
            <button ref={confirmBtn} className="btn btn--sm btn--danger press" disabled={busy} onClick={() => run(() => onDelete(d))}>Delete</button>
            <button className="btn btn--sm btn--ghost press" disabled={busy} onClick={cancel}>Keep</button>
          </span>
        ) : (
          <span className="demos__actions">
            <button className="btn btn--sm btn--ghost btn--icon press" aria-pressed={d.pinned} disabled={busy} aria-label={d.pinned ? `Unpin the ${what}` : `Pin the ${what}`} data-tip={d.pinned ? "Pinned: kept whatever the limits. Unpin" : "Pin: keep it whatever the limits"} onClick={() => run(() => onPin(d, !d.pinned))}>
              <PinIcon size={14} />
            </button>
            <button ref={deleteBtn} className="btn btn--sm btn--ghost btn--icon press" disabled={busy} aria-label={`Delete the ${what}`} data-tip="Delete this demo; its match stays" onClick={() => onConfirm(true)}>
              <TrashIcon size={14} />
            </button>
          </span>
        ))}
      </td>
    </tr>
  );
}

/** The Sources tile: how many recorded-demo matches are listed, and where the store is managed. */
export function LocalSourceTile({ n }: { n: number }) {
  return (
    <div className="source">
      <div className="source__head"><span className="src" data-src="local"><i aria-hidden /><span>Recorded demo</span></span><b className="num source__n">{n}</b></div>
      <p className="meta">The demos CS2 records of your Bot Mode matches, extracted: aim with view angles, movement and economy. When the plugin recorded the same match too, the demo is the one that counts.</p>
      <p className="meta">The demos themselves are kept in Recorded demos, below.</p>
    </div>
  );
}
