// "Your setup": the settings Bot Mode writes, edited as a draft and applied through a dialog that
// lists the exact files and lines. The draft is kept in localStorage, so changes made while CS2
// runs (when the backend refuses every write) wait for the next launch from this page or for
// Apply once CS2 has closed.
//
// Every write carries the state it was previewed against, taken when the first change to it was
// made: the server cfg's values (botmode_set_server_cfg), the active bot profile's hash
// (botmode_set_difficulty) and the app's launch options. The backend refuses a write whose file
// changed since, so a value another tool set meanwhile, even while the change waited for CS2 to
// close, is never overwritten without the user seeing it first.
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import { createPortal } from "react-dom";
import type { BotAim, BotModeApi, BotNades, Catalog, Difficulty, KnifeBind, KnifeFile, Preview, ServerPatch, ServerSettings, Status } from "../../../botmode/commands";
import { Card } from "../../components/Card";
import { Segmented } from "../../components/controls";
import { GameIcon } from "../../components/GameIcon";
import { cosmeticsSupport, errorText, isKeyName, kitChoices, KNIFE_IDS, KNIVES, MOD_KNIFE_KEY, modPresent } from "../../data/botmode";
import { CheckIcon, ChevronIcon, SearchIcon } from "../../icons/ui";
import { plural } from "../../lib/format";
import { useShown } from "./shared";

export interface Draft {
  skins: boolean;
  premium: boolean;
  kit: number;
  aim: BotAim | null;
  nades: BotNades | null;
  bind: KnifeBind | null;
  /** keys the user takes out of the set Bot Mode keeps unbound */
  stop: string[];
  difficulty: Difficulty | null;
  launch: string;
}

const draftOf = (s: Status, srv: ServerSettings): Draft => ({
  skins: srv.cosmetics.droppedKnifeSkins, premium: srv.cosmetics.droppedKnifePremium, kit: srv.cosmetics.musicKit,
  aim: srv.botAim, nades: srv.botNades, bind: srv.knifeBind, stop: [], difficulty: s.difficulty, launch: s.launchOptions,
});
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * What applying the draft writes, and the calls that write it. The exact lines of the server cfg
 * and the knife file come from the backend (`useServerPreview`), which keeps the knife file's
 * other lines as they are.
 */
export interface Plan {
  patch: ServerPatch | null;
  difficulty: Difficulty | null;
  launch: string | null;
}

/** settings.rs KNIFE_EXEC_LINE: the one line the server cfg gets, which runs the knife file. */
export const KNIFE_EXEC_LINE = "exec cs2stats_knife // cs2-stats knife drop";

/** Why the knife file can't be used as it is (knife changes and Launch wait); null when it can. */
export function knifeProblem(f: KnifeFile): string | null {
  if (f.status === "missing") return `Knife key file missing: the server cfg runs ${f.path}, but it is gone, so which keys Bot Mode keeps unbound is unknown. Repair puts it back.`;
  if (f.status === "unreadable") return `The knife key file can't be read (${f.error ?? f.path}), so which keys Bot Mode keeps unbound is unknown.${f.sha256 ? " Replace puts it back." : ""}`;
  return null;
}

function planOf(changed: (keyof Draft)[], d: Draft): Plan {
  const plan: Plan = { patch: null, difficulty: null, launch: null };
  const patch: ServerPatch = {};
  if (changed.some((k) => k === "skins" || k === "premium" || k === "kit")) patch.cosmetics = { droppedKnifeSkins: d.skins, droppedKnifePremium: d.premium, musicKit: d.kit };
  if (changed.includes("aim") && d.aim) patch.botAim = d.aim;
  if (changed.includes("nades") && d.nades) patch.botNades = d.nades;
  if (changed.includes("bind") && d.bind) patch.knifeBind = d.bind;
  if (changed.includes("stop") && d.stop.length) patch.stopUnbinding = d.stop;
  if (Object.keys(patch).length) plan.patch = patch;
  if (changed.includes("difficulty") && d.difficulty) plan.difficulty = d.difficulty;
  if (changed.includes("launch")) plan.launch = d.launch.trim();
  return plan;
}

/**
 * The backend's line-by-line preview of `patch` against the files as `server` read them; read
 * again when either changes. null without a patch.
 */
export function useServerPreview(api: BotModeApi, patch: ServerPatch | null, server: ServerSettings | null): Preview | { error: string } | "loading" | null {
  const key = patch ? JSON.stringify([patch, server]) : null;
  const [got, setGot] = useState<{ key: string; v: Preview | { error: string } } | null>(null);
  useEffect(() => {
    if (!key || !patch) return;
    let live = true;
    api.serverPreview(patch).then((v) => { if (live) setGot({ key, v }); }, (e) => { if (live) setGot({ key, v: { error: errorText(e) } }); });
    return () => { live = false; };
    // the key holds the patch and the read; a new object with the same content is no new preview
  }, [api, key]);
  if (!key) return null;
  return got?.key === key ? got.v : "loading";
}

const PENDING = "cs2stats.botmode.pending";
/** The draft's fields that live in the server cfg. */
const CFG_KEYS: (keyof Draft)[] = ["skins", "premium", "kit", "aim", "nades", "bind", "stop"];
/**
 * The draft, and what each part of it was previewed against: `seen` the server cfg's values,
 * `profile` the active bot profile's hash, `launch` the app's launch options.
 */
interface Stored { edits: Partial<Draft>; seen: ServerSettings; profile?: { sha256: string | null }; launch?: string }
function readStored(): Stored | null {
  try {
    const t = localStorage.getItem(PENDING);
    return t ? (JSON.parse(t) as Stored) : null;
  } catch { return null; }
}

/**
 * The draft over what the backend read, kept across visits until it is applied or discarded.
 * `read`: whether `server` is the cfg as read. A failed read passes a stand-in, which is not file
 * state: no kept edit is compared with it, so none is dropped as "already applied".
 */
export function usePending(api: BotModeApi, status: Status, server: ServerSettings, reload: () => Promise<void>, read = true) {
  const [stored, setStored] = useState<Stored | null>(readStored);
  useEffect(() => {
    try {
      if (stored && Object.keys(stored.edits).length) localStorage.setItem(PENDING, JSON.stringify(stored));
      else localStorage.removeItem(PENDING);
    } catch { /* storage blocked: the draft lives for this visit only */ }
  }, [stored]);
  const base = useMemo(() => draftOf(status, server), [status, server]);
  const edits = stored?.edits ?? {};
  const draft: Draft = { ...base, ...edits };
  const changed = (Object.keys(edits) as (keyof Draft)[]).filter((k) => !same(edits[k], base[k]));
  const plan = planOf(changed, draft);
  // a kept edit that the files now hold (applied elsewhere, or set by another tool) is no edit
  useEffect(() => {
    if (!read) return;
    setStored((s) => {
      if (!s) return s;
      const left = Object.fromEntries(Object.entries(s.edits).filter(([k, v]) => !same(v, base[k as keyof Draft])));
      if (Object.keys(left).length === Object.keys(s.edits).length) return s;
      return Object.keys(left).length ? { ...s, edits: left } : null;
    });
  }, [base, read]);
  // a change the backend would refuse anyway, said before the dialog opens
  const knifeEdit = changed.includes("bind") || changed.includes("stop");
  const invalid = knifeEdit && knifeProblem(server.knifeFile) ? `${knifeProblem(server.knifeFile)} Your knife key change waits until then.`
    : draft.bind && changed.includes("bind")
    ? !isKeyName(draft.bind.key) ? `"${draft.bind.key}" isn't a key name. Use one character or a name such as mouse4 or kp_end.`
      : !draft.bind.knives.length ? "Choose at least one knife for the knife key." : null
    : null;

  const set = useCallback(<K extends keyof Draft>(k: K, v: Draft[K]) => {
    // each baseline is the state when the first change to it was made; with none of its changes
    // waiting (none yet, or the last ones applied), it is the state as read now
    setStored((s) => {
      // a setting put back to what the files hold is no edit: it is dropped, so it can't later
      // override a value another tool sets, or keep an old baseline alive
      const edits: Partial<Draft> = { ...(s?.edits ?? {}), [k]: v };
      if (same(v, base[k])) delete edits[k];
      if (!Object.keys(edits).length) return null;
      // a baseline is kept while changes to it wait, both before this edit and after it
      const had = (keys: (keyof Draft)[]) => !!s && keys.some((c) => c in s.edits) && keys.some((c) => c in edits);
      return {
        edits,
        seen: had(CFG_KEYS) ? s!.seen : server,
        profile: had(["difficulty"]) ? s!.profile : { sha256: status.activeProfile },
        launch: had(["launch"]) ? s!.launch : status.launchOptions,
      };
    });
  }, [server, status.activeProfile, status.launchOptions, base]);
  const discard = useCallback(() => setStored(null), []);

  /** Writes the plan; throws the backend's refusal after reading the state again. */
  const apply = async () => {
    const seen = stored?.seen ?? server;
    const profile = stored?.profile ?? { sha256: status.activeProfile };
    const launchSeen = stored?.launch ?? status.launchOptions;
    const drop = (...keys: (keyof Draft)[]) => setStored((s) => {
      if (!s) return s;
      const n = { ...s.edits };
      for (const k of keys) delete n[k];
      return Object.keys(n).length ? { ...s, edits: n } : null;
    });
    // each part in turn; a refusal stops there, and the message names what was saved and what not
    const parts: { name: string; run: () => Promise<unknown>; keys: (keyof Draft)[] }[] = [];
    if (plan.patch) parts.push({ name: "Server cfg settings", run: () => api.setServerCfg(plan.patch!, seen), keys: CFG_KEYS });
    if (plan.difficulty) parts.push({ name: "Bot difficulty", run: () => api.setDifficulty(plan.difficulty!, profile), keys: ["difficulty"] });
    if (plan.launch !== null) parts.push({ name: "Launch options", run: () => api.setLaunchOptions(plan.launch!, launchSeen), keys: ["launch"] });
    const saved: string[] = [];
    let at = 0;
    try {
      for (; at < parts.length; at++) {
        await parts[at].run();
        drop(...parts[at].keys);
        saved.push(parts[at].name);
      }
    } catch (e) {
      const text = errorText(e);
      const failed = parts[at].name;
      const untried = parts.slice(at + 1).map((p) => p.name);
      const report = [
        saved.length ? `${saved.join(" and ")} saved.` : "Nothing was saved.",
        `${failed} refused: ${text}.`,
        untried.length ? `${untried.join(" and ")} not saved: the apply stopped at the refusal.` : "",
      ].filter(Boolean).join(" ");
      if (text.includes("changed since it was read")) {
        // the edits stay, previewed again against what the files hold now: the next apply,
        // which the user confirms after seeing them, compares with that
        const [fresh, now] = await Promise.all([api.serverCfg().catch(() => null), api.status().catch(() => null)]);
        setStored((s) => s && {
          ...s,
          seen: fresh ?? s.seen,
          profile: now ? { sha256: now.activeProfile } : s.profile,
          launch: now ? now.launchOptions : s.launch,
        });
        await reload();
        throw `${report} Another program changed that file after you made your changes. The page now shows the current values; apply again to keep the rest of your changes.`;
      }
      await reload();
      throw report;
    }
    await reload();
  };
  return { draft, base, changed, plan, invalid, set, discard, apply, unbound: server.unboundKeys, knifeFile: server.knifeFile, kept: Object.keys(stored?.edits ?? {}).length };
}
export type Pending = ReturnType<typeof usePending>;

/** The knife file's lines as a write leaves them, for a confirmation. */
export function KnifeFileLines({ path, lines, removed }: { path: string; lines: string[]; removed: string[] }) {
  return <>
    <span className="mono">{path}</span> after its header, as written; lines this change doesn't move stay exactly as they are:
    <ul className="bm-files mono selectable">{lines.map((l, i) => <li key={i}>{l}</li>)}</ul>
    {removed.length > 0 && <>Takes out:<ul className="bm-files bm-files--out mono selectable">{removed.map((l, i) => <li key={i}>{l}</li>)}</ul></>}
  </>;
}

/** The server cfg's and the knife file's lines from a backend preview, for a confirmation. */
export function PreviewLines({ preview }: { preview: Preview }) {
  return <>
    {preview.serverLines.length > 0 && <>
      <dt>Changes</dt>
      <dd>
        <span className="mono">cfg/gamemode_competitive_server.cfg</span>, these lines; your other lines stay:
        <ul className="bm-files mono selectable">{preview.serverLines.map((l) => <li key={l}>{l}</li>)}</ul>
        {preview.serverLines.includes(KNIFE_EXEC_LINE) && <span className="meta">The exec line goes last, so no line after it wins over the knife key.</span>}
      </dd>
    </>}
    {preview.knifeLines && <>
      <dt>Knife key</dt>
      <dd><KnifeFileLines path="cfg/cs2stats_knife.cfg" lines={preview.knifeLines} removed={preview.knifeRemoved} /></dd>
    </>}
  </>;
}

/** The plan as the confirmation lists it: each file, and what changes in it. */
export function PlanList({ plan, preview, difficultyFrom }: { plan: Plan; preview: ReturnType<typeof useServerPreview>; difficultyFrom: Difficulty | null }) {
  const shown = useShown();
  return (
    <dl className="bm-facts">
      {preview === "loading" ? <><dt>Changes</dt><dd>Reading what it writes.</dd></>
        : preview && "error" in preview ? <><dt>Changes</dt><dd className="poor-text selectable">{shown(preview.error)}</dd></>
        : preview && <PreviewLines preview={preview} />}
      {plan.difficulty && <>
        <dt>Replaces</dt>
        <dd><span className="mono">overrides/botprofile.vpk</span> with the mod's {plan.difficulty} profile (<span className="mono">overrides/{plan.difficulty[0].toUpperCase() + plan.difficulty.slice(1)}/botprofile.vpk</span>){difficultyFrom ? `; it is ${difficultyFrom} now` : ""}.</dd>
      </>}
      {plan.launch !== null && <>
        <dt>App setting</dt>
        <dd>Launch options after <span className="mono">-insecure</span>: <span className="mono selectable">{shown(plan.launch) || "none"}</span>. No game file changes for this.</dd>
      </>}
      {(plan.patch || plan.difficulty) && <>
        <dt>Backs up</dt>
        <dd>Each game file before it is replaced. History on this page undoes the change.</dd>
      </>}
    </dl>
  );
}

const DIFFICULTY: { value: Difficulty; label: string }[] = [{ value: "low", label: "Low" }, { value: "medium", label: "Medium" }, { value: "high", label: "High" }];
const AIM: { value: BotAim; label: string }[] = [{ value: "head", label: "Head" }, { value: "body", label: "Body" }, { value: "mixed", label: "Mixed" }];
const NADES: { value: BotNades; label: string }[] = [{ value: "off", label: "Off" }, { value: "less", label: "Less" }, { value: "normal", label: "Normal" }, { value: "more", label: "More" }, { value: "max", label: "Max" }];

export function Setup({ status, catalog, serverError, pending, blocker, onApply, onRepair }: {
  status: Status; catalog: { data: Catalog | null } | { error: string } | null; serverError: string | null;
  pending: Pending | null; blocker: string | null; onApply: (e: MouseEvent) => void; onRepair: (e: MouseEvent) => void;
}) {
  const shown = useShown();
  const installed = modPresent(status);
  const cat = catalog && "data" in catalog ? catalog.data : null;
  const support = cosmeticsSupport(status);
  const n = pending?.changed.length ?? 0;
  const foot = installed && pending ? (
    <>
      <span className="bm-foot__state" role="status">
        {pending.invalid ?? (blocker
          ? (n ? `${blocker} Your ${plural(n, "change")} ${n === 1 ? "is" : "are"} kept and ${n === 1 ? "applies" : "apply"} when you launch Bot Mode from here, or with Apply once CS2 has closed.` : blocker)
          : n ? plural(n, "unsaved change") : "Saved in the game folder")}
      </span>
      <span className="bm-foot__btns">
        <button className="btn btn--ghost btn--sm press" onClick={pending.discard} disabled={!n}>Discard</button>
        <button className="btn btn--primary btn--sm press" onClick={onApply} disabled={!n || !!blocker || !!pending.invalid}>Apply changes…</button>
      </span>
    </>
  ) : undefined;

  return (
    <Card title="Your setup" className="bm-setup" foot={foot} aside={<span className="meta">Read when a competitive map loads</span>}>
      {!installed ? (
        <p className="meta">Install the mod to set your music kit, knife drops and bots here.</p>
      ) : !pending ? (
        <p className="bm-problem selectable" role="alert">The server cfg could not be read, so these settings can't be shown: {shown(serverError ?? "")}</p>
      ) : (
        <SetupRows cat={cat} catalog={catalog} support={support} pending={pending} blocker={blocker} onRepair={onRepair} />
      )}
    </Card>
  );
}

function SetupRows({ cat, catalog, support, pending, blocker, onRepair }: {
  cat: Catalog | null; catalog: { data: Catalog | null } | { error: string } | null; support: ReturnType<typeof cosmeticsSupport>; pending: Pending;
  blocker: string | null; onRepair: (e: MouseEvent) => void;
}) {
  const shown = useShown();
  const { draft, set } = pending;
  const launchHidden = shown(draft.launch) !== draft.launch;
  return (
    <div className="bm-rows">
      {support === "official" && (
        <p className="bm-note">The installed BotRandomizer is the official build, which ignores the music kit and knife settings. Apply your builds to use them.</p>
      )}
      <div className="bm-row">
        <div className="bm-row__label"><span id="bm-kit-l">Music kit</span><span className="mono faint">br_player_music_kit</span></div>
        <div className="bm-row__ctl">
          <KitPicker labelId="bm-kit-l" value={draft.kit} catalog={cat} onChange={(v) => set("kit", v)} />
          <p className="meta">{catalog && "error" in catalog ? <span className="poor-text selectable">{shown(catalog.error)}</span>
            : !cat ? "BotRandomizer's catalog isn't in the game folder, so only Off and Random are offered."
            : "Your MVP anthem and round music in Bot Mode. Random picks a new kit each map."}</p>
        </div>
      </div>
      <div className="bm-row">
        <div className="bm-row__label"><span>Dropped knives</span><span className="mono faint">br_dropped_knife_skins</span></div>
        <div className="bm-row__ctl">
          <label className="check bm-check"><input type="checkbox" checked={draft.skins} onChange={(e) => set("skins", e.target.checked)} /><span>Give dropped knives a random finish</span></label>
          <label className="check bm-check"><input type="checkbox" checked={draft.premium} onChange={(e) => set("premium", e.target.checked)} /><span>Strongly favor expensive finishes</span><span className="mono faint">br_dropped_knife_premium</span></label>
          {cat && cat.knifeFinishes.length > 0 && <FinishOdds finishes={cat.knifeFinishes} premium={draft.premium} />}
        </div>
      </div>
      <div className="bm-row">
        <div className="bm-row__label"><span id="bm-knife-l">Knife key</span><span className="mono faint">subclass_create</span></div>
        <div className="bm-row__ctl">
          {knifeProblem(pending.knifeFile) ? (
            <div className="bm-problem" role="alert">
              <span className="selectable">{shown(knifeProblem(pending.knifeFile)!)}</span>
              {(pending.knifeFile.status === "missing" || pending.knifeFile.sha256) && <>
                <button className="btn btn--sm press" onClick={onRepair} disabled={!!blocker} aria-describedby={blocker ? "bm-repair-why" : undefined}>
                  {pending.knifeFile.status === "missing" ? "Repair…" : "Replace…"}
                </button>
                {blocker && <span className="meta" id="bm-repair-why">{blocker}</span>}
              </>}
            </div>
          ) : <>
            {pending.knifeFile.overrides.length > 0 && (
              <div className="bm-problem" role="alert">
                <span>In game, {pending.knifeFile.overrides.length === 1 ? "a later line in the server cfg wins" : "later lines in the server cfg win"} over the knife key:</span>
                <ul className="bm-files mono selectable">{pending.knifeFile.overrides.map((l) => <li key={l}>{l}</li>)}</ul>
                <span>Applying any setting here moves this app's exec line to the end of the server cfg, after {pending.knifeFile.overrides.length === 1 ? "it" : "them"}.</span>
              </div>
            )}
            <KnifePicker labelId="bm-knife-l" knives={cat?.knives.length ? cat.knives : KNIFE_IDS} bind={draft.bind}
              say={knifeSays(pending.knifeFile, pending.base.bind, pending.unbound)} onChange={(b) => set("bind", b)} />
            <UnboundKeys unbound={pending.unbound} stop={draft.stop} onStop={(k) => set("stop", draft.stop.includes(k) ? draft.stop.filter((x) => x !== k) : [...draft.stop, k])} />
          </>}
          {!knifeProblem(pending.knifeFile) && <p className="meta bm-knifefile">
            {pending.knifeFile.status === "notRun" ? <>The server cfg no longer runs <span className="mono selectable">{pending.knifeFile.path}</span>, so in game the mod's own {MOD_KNIFE_KEY} applies. Applying a knife key change adds the line back.</>
              : pending.knifeFile.status === "none" ? <>A knife key you apply is saved in <span className="mono selectable">{pending.knifeFile.path}</span>.</>
              : <>Saved in <span className="mono selectable">{pending.knifeFile.path}</span>, which the server cfg runs on every map. This page reads whatever that file holds, hand edits included.</>}
          </p>}
        </div>
      </div>
      <div className="bm-row">
        <div className="bm-row__label"><span>Bot aim</span><span className="mono faint">bot_aim</span></div>
        <div className="bm-row__ctl">
          <Segmented label="Bot aim" options={AIM} value={draft.aim ?? "mixed"} onChange={(v) => set("aim", v)} />
          <p className="meta">{draft.aim ? "Where bots aim first. Mixed picks by situation." : "No line yet, so the plugin's default applies: mixed, which picks by situation."}</p>
        </div>
      </div>
      <div className="bm-row">
        <div className="bm-row__label"><span>Bot grenades</span><span className="mono faint">bot_nades</span></div>
        <div className="bm-row__ctl">
          <Segmented label="Bot grenades" options={NADES} value={draft.nades ?? "normal"} onChange={(v) => set("nades", v)} />
          <p className="meta">{draft.nades ? "How freely bots throw recorded lineups. Normal is close to a human's limits." : "No line yet, so the plugin's default applies: normal, close to a human's limits."}</p>
        </div>
      </div>
      <div className="bm-row">
        <div className="bm-row__label"><span>Bot difficulty</span><span className="mono faint">overrides/botprofile.vpk</span></div>
        <div className="bm-row__ctl">
          <Segmented label="Bot difficulty" options={DIFFICULTY} value={(draft.difficulty ?? "custom") as Difficulty} onChange={(v) => set("difficulty", v)} />
          <p className="meta">{draft.difficulty ? "Copies the mod's bot profile for this level. Takes effect on the next map." : "Your bot profile matches none of the three levels. Choosing one replaces it; the current one is backed up."}</p>
        </div>
      </div>
      <div className="bm-row">
        <div className="bm-row__label"><label htmlFor="bm-launch-opts">Launch options</label><span className="mono faint">after -insecure</span></div>
        <div className="bm-row__ctl">
          {/* a path in the options is hidden like any other; editing the hidden text would save the placeholder */}
          <input id="bm-launch-opts" className="input mono bm-input" value={launchHidden ? shown(draft.launch) : draft.launch} readOnly={launchHidden} aria-describedby={launchHidden ? "bm-launch-hidden" : undefined}
            spellCheck={false} autoComplete="off" placeholder="+exec botmode" onChange={(e) => set("launch", e.target.value)} />
          <p className="meta">
            {launchHidden && <span id="bm-launch-hidden">Hidden while personal info is hidden; turn that off in Data &amp; settings to edit. </span>}
            Added when Bot Mode starts CS2. Options that turn VAC back on, such as <span className="mono">-secure</span>, are refused.
          </p>
        </div>
      </div>
    </div>
  );
}

/**
 * What the knife file as read does in game, when that is not simply "the key spawns the knives":
 * a later server cfg line wins over it, or the file leaves no key bound to knives (the user
 * unbound or rebound it by hand).
 */
function knifeSays(f: KnifeFile, bind: KnifeBind | null, unbound: string[]): string | null {
  if (f.status !== "ok" && f.status !== "notRun") return null;
  if (bind && f.overrides.length) return `${bind.key} would spawn the lit knives, but a later line in the server cfg wins over it (above). `;
  if (bind) return null;
  return unbound.some((k) => k === MOD_KNIFE_KEY)
    ? `No key spawns knives: the knife file binds none, and it unbinds the mod's own ${MOD_KNIFE_KEY}. Choosing knives or a key binds one. `
    : `The knife file binds no key to knives, so the mod's own ${MOD_KNIFE_KEY} spawns every knife. Choosing knives or a key binds one. `;
}

/** The knives a key spawns, chosen on the game's own icons, and the key. `say` replaces the line on what the key does. */
function KnifePicker({ labelId, knives, bind, say, onChange }: { labelId: string; knives: number[]; bind: KnifeBind | null; say: string | null; onChange: (b: KnifeBind) => void }) {
  // without a bind of the user's, the mod's own one applies: its key spawns every knife
  const key = bind?.key ?? MOD_KNIFE_KEY;
  const chosen = new Set(bind?.knives ?? knives);
  const toggle = (d: number) => {
    const next = knives.filter((k) => (k === d ? !chosen.has(k) : chosen.has(k)));
    onChange({ key, knives: next });
  };
  const keyId = useId();
  return (
    <div className="bm-knifepick">
      <div className="bm-knifepick__key">
        <label htmlFor={keyId}>Key</label>
        <input id={keyId} className="input mono bm-key" value={key} maxLength={16} spellCheck={false} autoComplete="off"
          aria-describedby={`${keyId}-what`} onChange={(e) => onChange({ key: e.target.value.trim(), knives: [...chosen].filter((k) => knives.includes(k)) })} />
        <span className="meta">{chosen.size === knives.length ? "every knife" : plural(chosen.size, "knife", "knives")}</span>
        <span className="bm-knifepick__all">
          <button className="btn btn--ghost btn--sm press" onClick={() => onChange({ key, knives })} disabled={chosen.size === knives.length}>All</button>
        </span>
      </div>
      <ul className="bm-knives" aria-labelledby={labelId}>
        {knives.map((d, i) => {
          const k = KNIVES[d];
          const name = k?.name ?? `Knife ${d}`;
          return (
            <li key={d} style={{ ["--i" as string]: i }}>
              <button className="bm-knife" aria-pressed={chosen.has(d)} data-tip={name} onClick={() => toggle(d)}>
                <GameIcon id={k?.icon ?? null} name={name} width={46} height={18} />
              </button>
            </li>
          );
        })}
      </ul>
      <p className="meta" id={`${keyId}-what`}>
        {say ?? (bind ? `In game, ${key} spawns the lit knives where you stand. ` : `No key of yours yet: the mod's own ${MOD_KNIFE_KEY} spawns every knife. Choosing knives or a key makes yours. `)}
        It runs after the mod's cfgs, so on the same key it replaces the mod's.
      </p>
    </div>
  );
}

/**
 * The keys Bot Mode keeps unbound: each key the knife key has moved off, the mod's own \
 * included. The knife file unbinds them on every map, as CS2 keeps old binds and the mod's cfg
 * binds \ again each map. Only the user takes one out.
 */
function UnboundKeys({ unbound, stop, onStop }: { unbound: string[]; stop: string[]; onStop: (key: string) => void }) {
  const id = useId();
  if (!unbound.length) return null;
  return (
    <section className="bm-unbound" aria-labelledby={id}>
      <h3 className="caps" id={id}>Keys Bot Mode keeps unbound</h3>
      <p className="meta">The knife key used to be on these, so each map starts by unbinding them; otherwise they would keep spawning knives. Stop unbinding a key to use it for something else. On {MOD_KNIFE_KEY}, the mod then binds knives again.</p>
      <ul>
        {unbound.map((k) => {
          const leaving = stop.includes(k);
          return (
            <li key={k} data-leaving={leaving}>
              <span className="kbd bm-unbound__key"><kbd>{k}</kbd></span>
              <span className="meta">{leaving ? "Unbinding stops when you apply" : "Unbound on every map"}</span>
              <button className="btn btn--ghost btn--sm press" onClick={() => onStop(k)} aria-label={leaving ? `Keep unbinding ${k}` : `Stop unbinding ${k}`}>
                {leaving ? "Keep unbinding" : "Stop unbinding"}
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** The finishes the catalog weights most, with the weight premium gives each (BotRandomizer squares it). */
function FinishOdds({ finishes, premium }: { finishes: { finish: string; weight: number }[]; premium: boolean }) {
  const top = [...finishes].sort((a, b) => b.weight - a.weight || a.finish.localeCompare(b.finish)).slice(0, 5);
  return (
    <div className="bm-odds" data-premium={premium}>
      <p className="meta">The most likely finishes. Each weight is against an unlisted finish's 1; premium squares it.</p>
      <table aria-label="Knife finish weights">
        <thead><tr><th className="caps" scope="col">Finish</th><th className="caps" scope="col">Normal</th><th className="caps" scope="col">Premium</th></tr></thead>
        <tbody>
          {top.map((f) => <tr key={f.finish}><td>{f.finish}</td><td className="num">{f.weight}</td><td className="num">{f.weight * f.weight}</td></tr>)}
        </tbody>
      </table>
      {finishes.length > top.length && <p className="meta">and {finishes.length - top.length} more</p>}
    </div>
  );
}

/** Type to filter, arrows to move, Enter to pick, Escape to close (WAI-ARIA combobox with a listbox popup). */
function KitPicker({ labelId, value, catalog, onChange }: { labelId: string; value: number; catalog: Catalog | null; onChange: (id: number) => void }) {
  const choices = useMemo(() => {
    const all = kitChoices(catalog);
    // a kit id the catalog does not list stays visible as what the cfg holds
    return all.some((c) => c.id === value) ? all : [...all, { id: value, artist: null, title: `Kit ${value}` }];
  }, [catalog, value]);
  const current = choices.find((c) => c.id === value)!;
  const btn = useRef<HTMLButtonElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [pos, setPos] = useState({ left: 0, top: 0, width: 340 });
  const id = useId();
  const q = query.trim().toLowerCase();
  const listed = q ? choices.filter((c) => `${c.title} ${c.artist ?? ""}`.toLowerCase().includes(q)) : choices;

  const show = () => {
    const r = btn.current!.getBoundingClientRect();
    const width = Math.max(r.width, 340);
    setPos({ left: Math.max(8, Math.min(r.left, innerWidth - width - 8)), top: r.bottom + 4, width });
    setQuery("");
    setActive(Math.max(0, choices.findIndex((c) => c.id === value)));
    setOpen(true);
  };
  const hide = useCallback((focus = true) => { setOpen(false); if (focus) btn.current?.focus(); }, []);
  useEffect(() => { if (open) input.current?.focus(); }, [open]);
  useEffect(() => {
    if (!open) return;
    const down = (e: PointerEvent) => { const t = e.target as Node; if (!pop.current?.contains(t) && !btn.current?.contains(t)) hide(false); };
    // the list is placed once, under the button: a scroll of the page or a resize closes it rather than leaving it behind
    const away = (e: Event) => { if (!(e.target instanceof Node && pop.current?.contains(e.target))) hide(false); };
    addEventListener("pointerdown", down, true);
    addEventListener("scroll", away, true);
    addEventListener("resize", away);
    return () => { removeEventListener("pointerdown", down, true); removeEventListener("scroll", away, true); removeEventListener("resize", away); };
  }, [open, hide]);
  useLayoutEffect(() => { if (open) pop.current?.querySelector<HTMLElement>(`[data-i="${active}"]`)?.scrollIntoView?.({ block: "nearest" }); }, [open, active]);

  const pick = (i: number) => { const c = listed[i]; if (!c) return; onChange(c.id); hide(); };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => Math.min(listed.length - 1, a + 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(0, a - 1)); }
    else if (e.key === "Enter") { e.preventDefault(); pick(active); }
    else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); hide(); }
    else if (e.key === "Tab") hide(false);
  };
  return (
    <>
      <button ref={btn} className="bm-kit press" aria-haspopup="listbox" aria-expanded={open} aria-labelledby={`${labelId} ${id}-v`}
        onClick={() => (open ? hide() : show())} onKeyDown={(e) => { if (e.key === "ArrowDown" && !open) { e.preventDefault(); show(); } }}>
        <span className="bm-kit__text" id={`${id}-v`}>
          <span className="bm-kit__title">{current.title}</span>
          {current.artist && <span className="bm-kit__artist">{current.artist}</span>}
        </span>
        <ChevronIcon size={14} className="bm-kit__chev" />
      </button>
      {open && createPortal(
        <div ref={pop} className="pop bm-kitpop" style={{ left: pos.left, top: pos.top, width: pos.width, ["--origin" as string]: "top left" }}>
          <div className="bm-kitpop__search">
            <SearchIcon size={14} className="ico" />
            <input ref={input} className="bm-kitpop__input" role="combobox" aria-expanded aria-controls={`${id}-list`} aria-autocomplete="list"
              aria-activedescendant={listed[active] ? `${id}-o${active}` : undefined} aria-label="Find a music kit" placeholder="Find a kit or artist"
              value={query} onChange={(e) => { setQuery(e.target.value); setActive(0); }} onKeyDown={onKey} />
          </div>
          <ul id={`${id}-list`} role="listbox" aria-label="Music kits" className="bm-kitpop__list">
            {listed.map((c, i) => (
              <li key={c.id} id={`${id}-o${i}`} data-i={i} role="option" aria-selected={c.id === value} data-active={i === active} className="opt bm-kitopt"
                onPointerMove={() => setActive(i)} onClick={() => pick(i)}>
                <span className="bm-kitopt__text"><span>{c.title}</span>{c.artist && <small>{c.artist}</small>}</span>
                {c.id === value && <CheckIcon size={14} className="opt__check" />}
              </li>
            ))}
            {!listed.length && <li className="bm-kitpop__none" role="presentation">No kit matches “{query}”.</li>}
          </ul>
        </div>,
        document.body,
      )}
    </>
  );
}
