// The replay's clock and frame loop, kept out of React so it can be tested without a DOM. One frame
// at most is queued at a time; while playing, each frame advances the clock and queues the next.
//
// Between rounds no timeline is loaded: playback pauses, the queued frame is cancelled and the
// canvas is cleared, so nothing plays or seeks under the next round's title. If the round changed
// while playing, playback resumes once the next round's timeline arrives; a failed load stays stopped.
import type { RoundTimeline } from "../../../../stats/replay";

export interface FrameClock {
  request(cb: (now: number) => void): number;
  cancel(id: number): void;
}

/** Longest step of the clock per animation frame, so a hidden window does not jump the round on return. */
export const MAX_STEP_S = 0.25;

export class Playback {
  tl: RoundTimeline | null = null;
  t = 0;
  speed = 1;
  playing = false;
  /** the scrubber is held: the clock stays where the pointer put it */
  dragging = false;
  /** draws the current moment; replaced as the component's inputs change */
  paint: () => void = () => {};
  private resume = false;
  private last = 0;
  private queued = 0;

  constructor(private clock: FrameClock, private clear: () => void, private onPlaying: (on: boolean) => void) {}

  /** The round's timeline arrived: start at its freeze end, and play on if the round changed while playing. */
  load(tl: RoundTimeline) {
    this.tl = tl;
    this.t = 0;
    this.last = 0;
    if (this.resume) { this.resume = false; this.setPlaying(true); }
    this.invalidate();
  }

  /** The round changed and its timeline is not here yet. */
  unload() {
    if (this.playing) this.resume = true;
    this.setPlaying(false);
    this.tl = null;
    this.stop();
    this.clear();
  }

  /** The round's timeline failed to load: stay stopped. */
  fail() {
    this.unload();
    this.resume = false;
  }

  play(on: boolean) {
    if (!this.tl) return;
    if (on && this.t >= this.tl.duration) this.t = 0;
    this.last = 0;
    this.setPlaying(on);
    this.invalidate();
  }

  seek(t: number) {
    if (!this.tl) return;
    this.t = Math.min(this.tl.duration, Math.max(0, t));
    this.last = 0;
    this.invalidate();
  }

  /** Queues one frame unless one is queued. */
  invalidate() {
    if (!this.queued) this.queued = this.clock.request(this.frame);
  }

  /** The tab is closing: nothing plays or draws again. */
  dispose() {
    this.resume = false;
    this.playing = false;
    this.stop();
    this.paint = () => {};
  }

  /** Whether a frame is queued. */
  get pending() { return this.queued !== 0; }

  private stop() {
    if (this.queued) this.clock.cancel(this.queued);
    this.queued = 0;
  }

  private setPlaying(on: boolean) {
    if (this.playing === on) return;
    this.playing = on;
    this.onPlaying(on);
  }

  private frame = (now: number) => {
    this.queued = 0;
    const tl = this.tl;
    if (this.playing && tl && !this.dragging) {
      const dt = this.last ? Math.min(MAX_STEP_S, (now - this.last) / 1000) : 0;
      this.t = Math.min(tl.duration, this.t + dt * this.speed);
      this.last = now;
      if (this.t >= tl.duration) this.setPlaying(false);
    }
    this.paint();
    if (this.playing) this.invalidate();
  };
}
