// The match's 2D replay: one round at a time on the radar, with a transport (play, speed, a scrubber
// marked with the round's kills) and the round's killfeed beside the map, lit as the kills pass.
//
// Playback runs outside React. A requestAnimationFrame loop advances the clock, interpolates the
// players (stats/replay-interp.ts) and draws the canvas (draw.ts); the scrubber, the clock text, the
// killfeed's state and the hover card are written to the DOM directly. React renders only on user
// actions: play, speed, floor, names, round. Keyboard: Space plays and pauses, the arrows change the
// round, L switches the floor, N shows every name. Reduced motion turns interpolation off.
import "../../../styles/replay.css";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import type { RoundTimeline } from "../../../../stats/replay";
import { playersAt, type PlayerState } from "../../../../stats/replay-interp";
import { weaponLabel } from "../../../../stats/weapons";
import { replayClient } from "../../../../worker/replay-client";
import { Segmented } from "../../../components/controls";
import { frameFor, RadarImage } from "../../../components/MapArt";
import { mapInfo } from "../../../data/maps";
import { useData } from "../../../data/provider";
import { hasLevels, levelRadarUrl, type Level } from "../../../data/radar-levels";
import { feedFor } from "../../../data/rounds";
import { Svg, type IconProps } from "../../../icons/Icon";
import { ChevronLeftIcon, ChevronRightIcon } from "../../../icons/ui";
import { setQuery } from "../../../router";
import { Empty } from "../../shared";
import { RoundEndIcon } from "../glyphs";
import { KillRow } from "../Killfeed";
import type { TabProps } from "../MatchView";
import { drawScene, type Palette, type Scene } from "./draw";
import { FULL, useRadarBox, type Box } from "./radar-box";
import { SpriteLoaders, Sprites } from "./sprites";
import { canReplay, NO_REPLAY } from "./support";

const SPEEDS = ["0.5", "1", "2", "4"] as const;
type Speed = (typeof SPEEDS)[number];
/** A killfeed row stays lit this many seconds after its kill. Ours: long enough to find on the map. */
const RECENT_S = 3;
/** Clicking a kill starts this many seconds before it, so the approach is seen. */
const LEAD_IN_S = 2;
/** Longest step of the clock per animation frame, so a hidden window does not jump the round on return. */
const MAX_STEP_S = 0.25;
/** Pointer distance (CSS pixels) within which a player is hovered. */
const HOVER_PX = 14;
/** Room the hover card needs from the well's edges, CSS pixels: its height plus the gap over the dot. */
const TIP_ROOM = 64;

const PlayIcon = (p: IconProps) => <Svg {...p} solid><path d="M7 4.5v15a1 1 0 0 0 1.5.86l12.5-7.5a1 1 0 0 0 0-1.72L8.5 3.64A1 1 0 0 0 7 4.5z" /></Svg>;
const PauseIcon = (p: IconProps) => <Svg {...p} solid><rect x="6" y="4" width="4" height="16" rx="1" /><rect x="14" y="4" width="4" height="16" rx="1" /></Svg>;

/** The players at a moment in words: side, name, then HP and weapon or "dead". */
function describe(players: PlayerState[], nameOf: Map<string, string>, t: number): string {
  const one = (p: PlayerState) => `${nameOf.get(p.id) ?? p.id}, ${p.alive ? `${p.hp ?? "unknown"} HP${p.weapon ? `, ${weaponLabel(p.weapon)}` : ""}` : "dead"}`;
  const side = (s: "T" | "CT") => `${s}: ${players.filter((p) => p.side === s).map(one).join("; ")}`;
  return `At ${clock(t)}. ${side("T")}. ${side("CT")}.`;
}

const clock = (s: number) => { const v = Math.max(0, Math.floor(s)); return `${Math.floor(v / 60)}:${String(v % 60).padStart(2, "0")}`; };

export default function Replay(props: TabProps) {
  if (!canReplay(props.file)) return <div className="tabpad"><div className="card"><Empty text={NO_REPLAY} /></div></div>;
  return <ReplayView {...props} />;
}

function useRoundTimeline(file: string, round: number, neighbours: number[]): { tl: RoundTimeline | null; error: string | null; round: number | null } {
  const { host } = useData();
  const [st, setSt] = useState<{ tl: RoundTimeline | null; error: string | null; round: number | null }>({ tl: null, error: null, round: null });
  const near = neighbours.join(",");
  useEffect(() => {
    if (!host) return;
    const c = replayClient(host);
    let alive = true;
    c.round(file, round).then(
      (tl) => {
        if (!alive) return;
        setSt({ tl, error: null, round });
        // the rounds either side, so the arrow keys find them ready
        for (const n of near ? near.split(",").map(Number) : []) c.round(file, n).catch(() => undefined);
      },
      (e: Error) => alive && setSt({ tl: null, error: e.message, round }),
    );
    return () => { alive = false; };
  }, [host, file, round, near]);
  return st;
}

function readPalette(el: Element): Palette {
  const cs = getComputedStyle(el);
  const v = (name: string, fallback: string) => cs.getPropertyValue(name).trim() || fallback;
  return { t: v("--t", "#db881c"), ct: v("--ct", "#2ba3e0"), cream: v("--cream", "#ffd7ad"), ink: v("--ink", "#e6e2dc"), ink2: v("--ink2", "#a3a7a4"), ink3: v("--ink3", "#6b6a66"), bg0: v("--bg0", "#1a1817") };
}

function ReplayView({ v, file, round }: TabProps) {
  const rounds = v.rounds;
  const ri = round ?? 0;
  const r = rounds[ri];
  const number = r.number;
  const neighbours = [rounds[ri + 1]?.number, rounds[ri - 1]?.number].filter((n): n is number => n !== undefined);
  const { tl, error: lastError, round: loadedRound } = useRoundTimeline(file, number, neighbours);
  const loading = loadedRound !== number;
  const error = loading ? null : lastError;

  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<Speed>("1");
  const [level, setLevel] = useState<Level>("upper");
  const [names, setNames] = useState(false);
  const levels = hasLevels(v.map);
  const you = v.players[v.human]?.key ?? null;

  const root = useRef<HTMLDivElement>(null);
  const well = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const tip = useRef<HTMLDivElement>(null);
  const timeText = useRef<HTMLSpanElement>(null);
  const scrub = useRef<HTMLDivElement>(null);
  const fill = useRef<HTMLDivElement>(null);
  const thumb = useRef<HTMLDivElement>(null);
  const feed = useRef<HTMLOListElement>(null);

  const sprites = useMemo(() => new Sprites(typeof devicePixelRatio === "number" ? devicePixelRatio : 1), []);
  const feedKills = useMemo(() => feedFor(v.facts, ri, v.human), [v, ri]);
  const killTicks = useMemo(() => v.facts.kills.filter((k) => k.ri === ri).map((k) => k.tick), [v, ri]);

  // the frame: the map's overview transform, or one fitted around the round's samples on an unknown map
  const frame = useMemo(() => {
    if (mapInfo(v.map)) return frameFor(v.map);
    if (!tl) return null;
    return frameFor(v.map, tl.frames.flatMap((f) => f.players.map((p): [number, number] => [p.x, p.y])));
  }, [v.map, tl]);

  // the view zooms to the radar's drawn area (both floors), read from the images once they load
  const known = !!mapInfo(v.map);
  const { box, ready } = useRadarBox(known ? [levelRadarUrl(v.map, "upper"), levelRadarUrl(v.map, "lower")] : []);

  // everything the draw loop reads, kept off React state
  const st = useRef({
    tl: null as RoundTimeline | null, t: 0, playing: false, speed: 1, last: 0, raf: 0,
    hover: null as string | null, pointer: null as [number, number] | null, level: "upper" as Level, names: false,
    reduce: false, size: 0, dpr: 1, palette: null as Palette | null, frame: null as typeof frame,
    shownSecond: -1, feedKey: "", buf: [] as PlayerState[], dragging: false, tipKey: "",
    nameOf: new Map<string, string>(), scrubW: 0, box: FULL as Box, ready: false, described: "",
  });

  const paint = useCallback(() => {
    const s = st.current;
    const cv = canvas.current;
    const g = cv?.getContext("2d");
    if (!cv || !g || !s.tl || !s.frame || !s.size || !s.palette || !s.ready) return;
    const tl = s.tl;
    const players = playersAt(tl, s.t, !s.reduce, s.buf);
    const fr = s.frame;
    // world → radar pixels → the zoomed view, still in 0..1024 units so sizes keep one scale
    const z = 1024 / s.box.side;
    const bx = s.box.x, by = s.box.y, fs = 1024 / fr.size;
    const unit = Math.abs(fr.to(1, 0)[0] - fr.to(0, 0)[0]) * fs * z;
    const k = s.size / 1024;
    const to = (x: number, y: number): [number, number] => { const [a, b] = fr.to(x, y); return [(a * fs - bx) * z, (b * fs - by) * z]; };

    // hover: the nearest player to the pointer, alive ones first
    if (s.pointer) {
      let best: string | null = null;
      let bestD = HOVER_PX;
      for (const p of players) {
        const [x, y] = to(p.x, p.y);
        const d = Math.hypot(x * k - s.pointer[0], y * k - s.pointer[1]) - (p.alive ? 2 : 0);
        if (d < bestD) { bestD = d; best = p.id; }
      }
      s.hover = best;
    } else s.hover = null;

    const scene: Scene = {
      map: v.map, to, unit, size: s.size, dpr: s.dpr, level: levels ? s.level : null, you, hover: s.hover, names: s.names,
      reduce: s.reduce, palette: s.palette, sprites, nameOf: s.nameOf,
    };
    drawScene(g, tl, s.t, players, scene);

    // transport: fill and thumb by transform, the clock text when its second changes
    const f = tl.duration > 0 ? Math.min(1, Math.max(0, s.t / tl.duration)) : 0;
    if (fill.current) fill.current.style.transform = `scaleX(${f})`;
    if (thumb.current) thumb.current.style.transform = `translateX(${f * s.scrubW}px)`;
    const sec = Math.floor(Math.max(0, s.t));
    if (sec !== s.shownSecond) {
      s.shownSecond = sec;
      if (timeText.current) timeText.current.textContent = clock(s.t);
      scrub.current?.setAttribute("aria-valuenow", String(sec));
      scrub.current?.setAttribute("aria-valuetext", `${clock(s.t)} of ${clock(tl.duration)}`);
    }

    // killfeed: kills ahead are dim, passed ones lit, the latest within RECENT_S marked
    const rows = feed.current?.children;
    if (rows) {
      let passed = 0;
      for (const tick of killTicks) if ((tick - tl.zeroTick) / tl.tickRate <= s.t) passed++;
      const lastT = passed ? (killTicks[passed - 1] - tl.zeroTick) / tl.tickRate : -Infinity;
      const recent = s.t - lastT <= RECENT_S ? passed - 1 : -1;
      const key = `${passed}|${recent}`;
      if (key !== s.feedKey) {
        s.feedKey = key;
        for (let i = 0; i < rows.length; i++) (rows[i] as HTMLElement).dataset.state = i === recent ? "now" : i < passed ? "past" : "next";
      }
    }

    // paused, the canvas's label reads out every player as the hover card would; not while playing,
    // where it would change four times a second
    if (!s.playing) {
      const said = describe(players, s.nameOf, s.t);
      if (said !== s.described) { s.described = said; cv.setAttribute("aria-label", said); }
    }

    // hover card: name, HP and weapon, above the player
    const el = tip.current;
    if (el) {
      const p = s.hover ? players.find((x) => x.id === s.hover) : null;
      if (!p) { if (!el.hidden) el.hidden = true; s.tipKey = ""; }
      else {
        const name = s.nameOf.get(p.id) ?? p.id;
        const key = `${p.id}|${p.alive}|${p.hp}|${p.weapon}`;
        if (key !== s.tipKey) {
          s.tipKey = key;
          el.dataset.side = p.side.toLowerCase();
          el.querySelector(".replay__tipname")!.textContent = name;
          el.querySelector(".replay__tipmeta")!.textContent = !p.alive ? "Dead" : `${p.hp ?? "?"} HP${p.weapon ? ` · ${weaponLabel(p.weapon)}` : ""}`;
        }
        const [x, y] = to(p.x, p.y);
        // above the player, or below it near the top edge, where the well would clip the card
        el.dataset.below = String(y * k < TIP_ROOM);
        el.style.transform = `translate(${Math.min(s.size - TIP_ROOM, Math.max(TIP_ROOM, x * k))}px, ${y * k}px)`;
        if (el.hidden) el.hidden = false;
      }
    }
  }, [v.map, levels, you, sprites, killTicks]);

  // the loop is created once and reads the latest paint, so a frame already queued when the round
  // (and with it paint's kill ticks) changes draws with the new round's
  const paintRef = useRef(paint);
  useLayoutEffect(() => { paintRef.current = paint; }, [paint]);
  const loop = useCallback(function loop(now: number) {
    const s = st.current;
    s.raf = 0;
    if (s.playing && s.tl && !s.dragging) {
      const dt = s.last ? Math.min(MAX_STEP_S, (now - s.last) / 1000) : 0;
      s.t = Math.min(s.tl.duration, s.t + dt * s.speed);
      s.last = now;
      if (s.t >= s.tl.duration) { s.playing = false; setPlaying(false); }
    }
    paintRef.current();
    if (s.playing) s.raf = requestAnimationFrame(loop);
  }, []);

  const invalidate = useCallback(() => {
    const s = st.current;
    if (!s.raf) s.raf = requestAnimationFrame(loop);
  }, [loop]);

  useEffect(() => () => { const s = st.current; s.playing = false; cancelAnimationFrame(s.raf); s.raf = 0; }, []);
  useEffect(() => {
    sprites.onLoad = invalidate;
    return () => { sprites.onLoad = () => {}; };
  }, [sprites, invalidate]);

  const play = useCallback((on: boolean) => {
    const s = st.current;
    if (!s.tl) return;
    if (on && s.t >= s.tl.duration) s.t = 0;
    s.playing = on;
    s.last = 0;
    // the paused description (paint) would go stale while playing
    if (on) { s.described = ""; canvas.current?.setAttribute("aria-label", `Round ${s.tl.round} on the radar, playing`); }
    setPlaying(on);
    invalidate();
  }, [invalidate]);

  const seek = useCallback((t: number) => {
    const s = st.current;
    if (!s.tl) return;
    s.t = Math.min(s.tl.duration, Math.max(0, t));
    s.last = 0;
    invalidate();
  }, [invalidate]);

  // a new round starts at its freeze end; playback carries on if it was playing. Until it arrives
  // (or when it fails) no timeline is active, so nothing plays or seeks under the new round's title.
  const current = tl && loadedRound === number ? tl : null;
  useEffect(() => {
    const s = st.current;
    s.tl = current;
    if (!current) return;
    const tl = current;
    s.nameOf = new Map(tl.players.map((p) => [p.id, p.name]));
    s.t = 0;
    s.last = 0;
    s.shownSecond = -1;
    s.feedKey = "";
    s.tipKey = "";
    s.described = "";
    invalidate();
  }, [current, invalidate]);

  useEffect(() => { const s = st.current; s.frame = frame; invalidate(); }, [frame, invalidate]);
  useEffect(() => { const s = st.current; s.box = box; s.ready = ready; invalidate(); }, [box, ready, invalidate]);
  useEffect(() => { st.current.speed = Number(speed); }, [speed]);
  useEffect(() => { st.current.level = level; invalidate(); }, [level, invalidate]);
  useEffect(() => { st.current.names = names; invalidate(); }, [names, invalidate]);

  // the canvas follows its box at the device's pixel density
  useEffect(() => {
    const box = well.current;
    const cv = canvas.current;
    if (!box || !cv) return;
    const s = st.current;
    s.palette = readPalette(box);
    const fit = () => {
      const size = Math.round(box.clientWidth);
      const dpr = devicePixelRatio || 1;
      if (size === s.size && dpr === s.dpr) return;
      s.size = size;
      s.dpr = dpr;
      sprites.setDpr(dpr);
      cv.width = Math.round(size * dpr);
      cv.height = Math.round(size * dpr);
      cv.style.width = `${size}px`;
      cv.style.height = `${size}px`;
      invalidate();
    };
    const fitScrub = () => { s.scrubW = scrub.current?.clientWidth ?? 0; invalidate(); };
    fit();
    fitScrub();
    const ro = new ResizeObserver(fit);
    ro.observe(box);
    const rs = new ResizeObserver(fitScrub);
    if (scrub.current) rs.observe(scrub.current);
    return () => { ro.disconnect(); rs.disconnect(); };
  }, [sprites, invalidate]);

  // reduced motion, live
  useEffect(() => {
    const mq = matchMedia("(prefers-reduced-motion: reduce)");
    const on = () => { st.current.reduce = mq.matches; invalidate(); };
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, [invalidate]);

  const goRound = useCallback((step: -1 | 1) => {
    const next = rounds[ri + step];
    if (next) setQuery("round", String(next.number));
  }, [rounds, ri]);

  // keyboard: Space, the arrows, L and N, unless a control that owns those keys has focus. A button
  // or link reached by Tab keeps Space as its own key; one that holds focus only because it was
  // clicked does not, so Space after clicking Next round plays rather than skipping another round.
  useEffect(() => {
    let keyboard = false;
    let byKey = false;
    let ownSpace = false;
    const onPointer = () => { keyboard = false; };
    const onFocus = () => { byKey = keyboard; };
    const onKey = (e: KeyboardEvent) => {
      keyboard = true;
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
      const el = e.target instanceof Element ? e.target : document.body;
      if (el.closest("input, textarea, select, [contenteditable='true'], [role=dialog], [role=listbox]")) return;
      if (e.key === " ") {
        ownSpace = false;
        if (byKey && el.closest("button, a[href], [role=radio], [role=tab]")) return;
        e.preventDefault();
        ownSpace = true;
        play(!st.current.playing);
      } else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        if (el.closest("[role=radiogroup], [role=tablist], [role=slider], tbody[tabindex]")) return;
        e.preventDefault();
        goRound(e.key === "ArrowLeft" ? -1 : 1);
      } else if ((e.key === "l" || e.key === "L") && levels) {
        setLevel((x) => (x === "upper" ? "lower" : "upper"));
      } else if (e.key === "n" || e.key === "N") {
        setNames((x) => !x);
      }
    };
    // a mouse-focused button clicks on Space's keyup; when the replay took the Space, stop that too
    const onUp = (e: KeyboardEvent) => { if (e.key === " " && ownSpace) { e.preventDefault(); ownSpace = false; } };
    addEventListener("pointerdown", onPointer, true);
    addEventListener("focusin", onFocus);
    addEventListener("keydown", onKey);
    addEventListener("keyup", onUp);
    return () => {
      removeEventListener("pointerdown", onPointer, true);
      removeEventListener("focusin", onFocus);
      removeEventListener("keydown", onKey);
      removeEventListener("keyup", onUp);
    };
  }, [play, goRound, levels]);

  // scrubber: drag to seek; arrows step 5 s, Home and End jump
  const fromPointer = (e: ReactPointerEvent<HTMLDivElement>) => {
    const box = scrub.current!.getBoundingClientRect();
    const tlNow = st.current.tl;
    if (!tlNow) return;
    seek(((e.clientX - box.left) / box.width) * tlNow.duration);
  };
  const onScrubDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    st.current.dragging = true;
    fromPointer(e);
  };
  const onScrubMove = (e: ReactPointerEvent<HTMLDivElement>) => { if (st.current.dragging) fromPointer(e); };
  const onScrubUp = () => { st.current.dragging = false; st.current.last = 0; invalidate(); };
  const onScrubKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const s = st.current;
    if (!s.tl) return;
    const step = e.shiftKey ? 1 : 5;
    const to = e.key === "ArrowLeft" || e.key === "ArrowDown" ? s.t - step : e.key === "ArrowRight" || e.key === "ArrowUp" ? s.t + step
      : e.key === "PageDown" ? s.t - 15 : e.key === "PageUp" ? s.t + 15 : e.key === "Home" ? 0 : e.key === "End" ? s.tl.duration : null;
    if (to === null) return;
    e.preventDefault();
    seek(to);
  };

  // canvas hover
  const onCanvasMove = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    st.current.pointer = [e.clientX - box.left, e.clientY - box.top];
    invalidate();
  };
  const onCanvasLeave = () => { st.current.pointer = null; invalidate(); };

  const lowerUrl = levels ? levelRadarUrl(v.map, "lower") : null;
  const winText = r.winSide ? (r.winSide === "T" ? "t-text" : "ct-text") : "faint";

  return (
    <div className="tabpad replay" ref={root}>
      <div className="replay__grid">
        <section className="card replay__stage" aria-label={`Round ${number} replay`}>
          <div className="replay__deck">
            <div className="radar-view replay__well" ref={well} data-level={level}>
              <div className="replay__zoom" data-ready={ready} style={{ transform: `scale(${1024 / box.side}) translate(${(-100 * box.x) / 1024}%, ${(-100 * box.y) / 1024}%)` }}>
                {frame && <div className="replay__layer" data-on={!lowerUrl || level === "upper"}><RadarImage map={v.map} frame={frame} /></div>}
                {lowerUrl && <img src={lowerUrl} alt="" className="radar-img replay__layer" draggable={false} data-on={level === "lower"} />}
              </div>
              <canvas
                ref={canvas}
                className="replay__canvas"
                role="img"
                aria-label={`Round ${number} on the radar`}
                onPointerMove={onCanvasMove}
                onPointerLeave={onCanvasLeave}
              />
              <div className="replay__tip" ref={tip} hidden aria-hidden>
                <b className="replay__tipname" />
                <span className="replay__tipmeta" />
              </div>
              {loading && <div className="replay__veil"><span className="meta">Reading round {number}…</span></div>}
              {error && <div className="replay__veil"><div className="error-box" role="alert"><h2>Round {number} could not be replayed</h2><p className="muted selectable">{error}</p></div></div>}
            </div>

            <div className="replay__transport">
              <button className="btn btn--icon replay__play press" onClick={() => play(!playing)} disabled={!current} aria-label={playing ? "Pause" : "Play"} data-tip={`${playing ? "Pause" : "Play"}  Space`}>
                {playing ? <PauseIcon size={16} /> : <PlayIcon size={16} />}
              </button>
              <span className="replay__time mono" ref={timeText}>0:00</span>
              <div
                className="replay__scrub"
                ref={scrub}
                role="slider"
                tabIndex={current ? 0 : -1}
                aria-label="Round time"
                aria-valuemin={0}
                aria-valuemax={Math.floor(current?.duration ?? 0)}
                aria-valuenow={0}
                aria-disabled={!current}
                onPointerDown={onScrubDown}
                onPointerMove={onScrubMove}
                onPointerUp={onScrubUp}
                onPointerCancel={onScrubUp}
                onKeyDown={onScrubKey}
              >
                <div className="replay__track">
                  <div className="replay__fill" ref={fill} />
                </div>
                {current && current.duration > 0 && (
                  <div className="replay__marks" aria-hidden>
                    {current.kills.map((k, i) => (
                      <i key={i} className={`replay__kill ${k.killerSide === "T" ? "is-t" : k.killerSide === "CT" ? "is-ct" : ""}`} style={{ left: `${(100 * k.t) / current.duration}%` }} />
                    ))}
                    {current.bomb.filter((b) => b.kind === "plant").map((b, i) => (
                      <i key={`b${i}`} className="replay__plant" style={{ left: `${(100 * b.t) / current.duration}%` }} />
                    ))}
                    {current.endT < current.duration && <i className="replay__end" style={{ left: `${(100 * current.endT) / current.duration}%` }} />}
                  </div>
                )}
                <div className="replay__thumb" ref={thumb} />
              </div>
              <span className="replay__time replay__time--total mono">{current ? clock(current.duration) : "–"}</span>
              <Segmented label="Speed" value={speed} onChange={setSpeed} options={SPEEDS.map((x) => ({ value: x, label: `${x}×` }))} />
            </div>
          </div>
        </section>

        <aside className="card replay__side" aria-label={`Round ${number}`}>
          <header className="replay__head">
            <div className="replay__round">
              <button className="btn btn--ghost btn--icon btn--sm press" disabled={ri === 0} onClick={() => goRound(-1)} aria-label="Previous round" data-tip="Previous round  ←"><ChevronLeftIcon size={16} /></button>
              <h2 className="replay__title">Round <span className="num">{number}</span></h2>
              <button className="btn btn--ghost btn--icon btn--sm press" disabled={ri === rounds.length - 1} onClick={() => goRound(1)} aria-label="Next round" data-tip="Next round  →"><ChevronRightIcon size={16} /></button>
              <span className={`replay__result ${winText}`}>
                <RoundEndIcon how={r.how} size={14} />
                <span>{r.winSide ? `${r.winSide} win` : "No result"}</span>
              </span>
            </div>
            <div className="replay__opts">
              {levels && (
                <Segmented label="Floor" value={level} onChange={setLevel} options={[{ value: "upper", label: "Upper", tip: "Upper floor  L" }, { value: "lower", label: "Lower", tip: "Lower floor  L" }]} />
              )}
              <label className="check" data-tip="Show every name  N"><input type="checkbox" checked={names} onChange={(e) => setNames(e.target.checked)} /><span>Names</span></label>
            </div>
          </header>
          <header className="replay__sidehead">
            <span className="caps">Killfeed</span>
            <span className="meta">{feedKills.length ? `${feedKills.length} kills` : ""}</span>
          </header>
          {feedKills.length ? (
            <ol className="replay__feed" ref={feed}>
              {feedKills.map((k, i) => (
                <li key={i} data-state="next">
                  <button
                    className="replay__feedbtn"
                    onClick={() => { const s = st.current; if (s.tl) seek((killTicks[i] - s.tl.zeroTick) / s.tl.tickRate - LEAD_IN_S); }}
                    aria-label={`Watch from ${LEAD_IN_S} s before ${k.killer ? k.killer.name : "the world"} killed ${k.victim.name}`}
                  >
                    <KillRow k={k} />
                  </button>
                </li>
              ))}
            </ol>
          ) : <p className="meta replay__nokills">No kills this round.</p>}
          <p className="replay__keys meta">
            <span><span className="kbd"><kbd>Space</kbd></span>Play</span>
            <span><span className="kbd"><kbd>←</kbd><kbd>→</kbd></span>Round</span>
            {levels && <span><span className="kbd"><kbd>L</kbd></span>Floor</span>}
            <span><span className="kbd"><kbd>N</kbd></span>Names</span>
          </p>
        </aside>
      </div>
      <SpriteLoaders sheet={sprites} />
    </div>
  );
}
