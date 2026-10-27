// The Bot Mode recovery prompt. When a Bot Mode session of this app died with Bot Mode on, CS2
// Stats cannot tell whether gameinfo.gi is still that session's or another tool's (ed0ard's
// Bot-Improver Panel keeps Bot Mode on by editing the same file), so it changes nothing and asks
// once at startup: a toast with two answers. "Turn off Bot Mode" opens a confirmation that names
// the file; "Leave it on" changes nothing. Either answer ends the prompt for good; closing the
// toast asks again at the next start. The backend refuses both while CS2 runs, and refuses "off"
// once the file differs from the one the prompt was about (src-tauri/src/botmode/session.rs,
// `recover`). The Bot Mode page will show the same state from botmode.session().
//
// One answer runs at a time: while one is in flight, both buttons are disabled and the
// confirmation cannot open.
import { useEffect, useId, useRef, useState } from "react";
import { botmode, type Recovery } from "../../botmode/commands";
import { isTauri } from "../../host/host";
import { hideText, useHidePersonal } from "../data/privacy";
import { dismissToast, setToastActions, toast, type ToastAction } from "./overlay";

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function BotModeRecovery() {
  const [confirming, setConfirming] = useState<Recovery | null>(null);
  const [busy, setBusy] = useState(false);
  // the prompt being asked, read by the toast's buttons when pressed
  const asked = useRef<Recovery | null>(null);
  const toastId = useRef<number | null>(null);
  // set at once, before any re-render, so a second press in the same frame is refused
  const pending = useRef(false);

  const claim = () => {
    if (pending.current) return false;
    pending.current = true;
    setBusy(true);
    return true;
  };
  const release = () => {
    pending.current = false;
    setBusy(false);
  };

  const finish = () => {
    if (toastId.current !== null) dismissToast(toastId.current);
    toastId.current = null;
    asked.current = null;
    setConfirming(null);
  };

  const openConfirm = () => {
    if (!pending.current && asked.current) setConfirming(asked.current);
  };

  const leave = async () => {
    if (!asked.current || !claim()) return;
    try {
      const r = await botmode.recover({ action: "leave" });
      finish();
      toast(r.message);
    } catch (e) {
      toast(errorText(e), "poor", 6000);
    } finally {
      release();
    }
  };

  const actions = (disabled: boolean): ToastAction[] => [
    { label: "Turn off Bot Mode", primary: true, run: openConfirm, disabled },
    { label: "Leave it on", run: () => void leave(), disabled },
  ];

  useEffect(() => {
    if (!isTauri()) return;
    let live = true;
    botmode.session().then(
      (v) => {
        if (!live || !v.recovery) return;
        asked.current = v.recovery;
        toastId.current = toast(v.recovery.message, "poor", 0, [], actions(pending.current));
      },
      // no Steam or no CS2 found: there is nothing to ask about
      () => {},
    );
    return () => {
      live = false;
      if (toastId.current !== null) dismissToast(toastId.current);
      toastId.current = null;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (toastId.current !== null) setToastActions(toastId.current, actions(busy));
  }, [busy]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!confirming) return null;
  return (
    <TurnOffDialog
      recovery={confirming}
      busy={busy}
      promptShowing={() => toastId.current !== null}
      onClose={() => setConfirming(null)}
      turnOff={async (hash) => {
        if (!claim()) return null;
        try {
          const r = await botmode.recover({ action: "off", expectHash: hash });
          finish();
          toast(r.message, "good");
          return null;
        } catch (e) {
          const why = errorText(e);
          // ask again about the file as it is now, or end the prompt when there is nothing left to ask
          try {
            const now = (await botmode.session()).recovery;
            if (now) {
              asked.current = now;
              setConfirming(now);
              return why;
            }
            finish();
            toast(why, "poor", 6000);
            return null;
          } catch (again) {
            // the state could not be read again: keep the prompt and this confirmation as they are
            return `${why} Reading Bot Mode's state again failed: ${errorText(again)}`;
          }
        } finally {
          release();
        }
      }}
    />
  );
}

/**
 * The confirmation for "Turn off Bot Mode": the file it writes, and what changes in it. A modal
 * <dialog> (focus stays inside, Escape cancels unless an answer is in flight). Cancel has the
 * focus when it opens. On close, focus goes back to the button that opened it while the prompt
 * is still showing, and to the page once the prompt has been answered.
 */
function TurnOffDialog({ recovery, busy, promptShowing, onClose, turnOff }: {
  recovery: Recovery;
  busy: boolean;
  promptShowing: () => boolean;
  onClose: () => void;
  /** answers "off" for `hash`; resolves to an error to show, or null */
  turnOff: (hash: string) => Promise<string | null>;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const [error, setError] = useState<string | null>(null);
  const hide = useHidePersonal();
  const shown = (s: string) => (hide ? hideText(s) : s);
  const titleId = useId();
  const leadId = useId();

  useEffect(() => {
    const d = ref.current!;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (typeof d.showModal === "function") d.showModal(); else d.setAttribute("open", "");
    cancel.current?.focus();
    return () => {
      if (d.open && typeof d.close === "function") d.close();
      const openerLeaving = !opener?.isConnected || (!!opener.closest(".toast") && !promptShowing());
      const back = openerLeaving ? document.querySelector<HTMLElement>("main") : opener;
      back?.focus({ preventScroll: true });
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const go = async () => {
    setError(null);
    setError(await turnOff(recovery.hash));
  };

  return (
    <dialog ref={ref} className="dialog" aria-labelledby={titleId} aria-describedby={leadId} aria-busy={busy || undefined}
      onCancel={(e) => { e.preventDefault(); if (!busy) onClose(); }}>
      <h2 id={titleId} className="dialog__title">Turn off Bot Mode?</h2>
      <div className="dialog__body">
        <p id={leadId}>CS2 Stats removes Bot Mode's search paths from this file and changes nothing else in it:</p>
        <p className="dialog__file mono selectable">{shown(recovery.file)}</p>
        <p className="meta">If you turned Bot Mode on with another tool, cancel and choose Leave it on.</p>
      </div>
      {error && <p className="dialog__problem selectable" role="alert">{shown(error)}</p>}
      <div className="dialog__foot">
        {busy && <span className="meta dialog__busy" role="status">Turning Bot Mode off…</span>}
        <button ref={cancel} className="btn" onClick={onClose} disabled={busy}>Cancel</button>
        <button className="btn btn--primary" onClick={() => void go()} disabled={busy}>Turn off Bot Mode</button>
      </div>
    </dialog>
  );
}
