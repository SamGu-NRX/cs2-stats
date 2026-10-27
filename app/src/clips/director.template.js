// The clip director: HLAE loads it into CS2 with mirv_script_load, from the one-line cfg the render
// launch writes. It runs the whole recording on its own, once per rendered frame: for each demo of
// the job, play it; for each clip, seek a little before the start, put the camera on the POV player
// in first person, record from the start tick to the end tick with mirv_streams; then quit. A clip
// records only when the camera was confirmed on the player in first person before its start tick;
// otherwise the director seeks back and tries again, then skips the clip with why=camera_late.
//
// Adapted from CS2-povforge's director.js (Copyright (c) 2026 Chester-chs, MIT; THIRD_PARTY_NOTICES.md),
// which plays one demo per launch. This one plays the job's demos in turn. The API is HLAE's
// mirv-script (advancedfx misc/mirv-script/src/types/mirv.d.ts).
//
// The app's host (src-tauri/src/clips/job.rs) replaces the job placeholder below with the job as
// JSON. Every line it logs starts with "[cs2stats]", so CS2's console.log says what happened to each clip.
// HLAE's script cannot write files, so these lines are the director's only record. Each launch writes
// its own copy of this script with a fresh random nonce (clips/launch.rs), and every line carries it:
// "END <clip> nonce=<n> why=<why> tick=<t>" for each clip, "<message> nonce=<n>" otherwise. Once that
// launch's HLAE and CS2 have exited, the host reads its END lines from console.log, and a take counts
// as recorded only with "why=end_tick" under that launch's nonce.
//
// demo_ui_mode hides the demo playback bar. The director sets it through HLAE's cvar API
// (AdvancedfxCVar, HLAE 2.187.4 and later), keeps the value it found, and puts that back before CS2
// quits, so the user's setting is never left changed; whether CS2 saves it to the config at all is
// unconfirmed. Without that API the director leaves it alone and the bar shows in the clips.
//
// Untested in a live game: nobody has run this inside CS2 yet (design/clips.md).
{
	const JOB = __CS2STATS_JOB__;
	const NAME = 'cs2stats-director';
	const S = { BOOT: 'boot', LOAD: 'load', SEEK: 'seek', PREROLL: 'preroll', REC: 'rec', NEXT_DEMO: 'next-demo', FINISH: 'finish', DONE: 'done' };

	let state = S.BOOT;
	let frame = 0;
	let stateFrame = 0;
	let demo = 0;
	let clip = 0;
	let seekTries = 0;
	let camTries = 0;
	// frames spent asking for first person in this lock (lockCamera's spec_mode fallback)
	let modeAsks = 0;
	// the camera was confirmed on the player, in first person, on a frame before the clip's start tick
	let lockedBefore = false;
	let controller = null;

	const log = (msg) => mirv.message('[cs2stats] ' + msg + ' nonce=' + JOB.nonce + '\n');
	const setState = (s) => { state = s; stateFrame = frame; };
	const tickNow = () => { const t = mirv.getDemoTick(); return typeof t === 'number' ? t : -1; };
	const currentDemo = () => JOB.demos[demo];

	// demo_ui_mode as it was before the director changed it: { cvar, value }, or null when untouched
	let uiMode = null;
	function hideDemoUi() {
		try {
			if (typeof AdvancedfxCVar === 'undefined') { log('WARNING HLAE has no cvar API; the demo bar stays'); return; }
			const index = AdvancedfxCVar.getIndexFromName('demo_ui_mode');
			if (index === undefined) { log('WARNING no demo_ui_mode; the demo bar stays'); return; }
			const cvar = new AdvancedfxCVar(index);
			uiMode = { cvar, value: cvar.value };
			cvar.value = 0;
		} catch (err) {
			log('WARNING demo_ui_mode left as it was: ' + err);
		}
	}
	function restoreDemoUi() {
		if (uiMode === null) return;
		try {
			uiMode.cvar.value = uiMode.value;
			log('demo_ui_mode restored to ' + uiMode.value);
		} catch (err) {
			log('ERROR demo_ui_mode could not be restored to ' + uiMode.value + ': ' + err);
		}
		uiMode = null;
	}
	const currentClip = () => (demo < JOB.demos.length ? JOB.demos[demo].clips[clip] : undefined);

	// The controller entity of the player with this SteamID64; null until the demo has spawned it.
	function findController(steamid) {
		const highest = Math.min(mirv.getHighestEntityIndex(), 128);
		for (let i = 1; i <= highest; i++) {
			const e = mirv.getEntityFromIndex(i);
			if (e !== null && e.isPlayerController() && e.getSteamId().toString() === steamid) return i;
		}
		return null;
	}

	// The controller the demo camera follows now, or null.
	function observedController() {
		try {
			const local = mirv.getEntityFromSplitScreenPlayer(0);
			if (local === null) return null;
			const pawn = mirv.getEntityFromIndex(mirv.getHandleEntryIndex(local.getPlayerPawnHandle()));
			if (pawn === null) return null;
			const target = mirv.getEntityFromIndex(mirv.getHandleEntryIndex(pawn.getObserverTargetHandle()));
			if (target === null) return null;
			return mirv.getHandleEntryIndex(target.getPlayerControllerHandle());
		} catch (err) {
			return null;
		}
	}

	// CS2's observer mode for the player's own eyes (ObserverMode_t: 0 none, 1 fixed, 2 in-eye, 3 chase,
	// 4 roaming; CounterStrikeSharp's generated schema). HLAE's mirv_script_view snippet also reads 2 as in-eye.
	const IN_EYE = 2;
	// spec_mode values to ask for first person, in order: 2, the schema's in-eye, which mirv_script_view
	// passes to spec_mode as read; then 1, which advancedfx issue #1172 found gives in-eye on CS2 1.41.6.2.
	// Each is asked for MODE_ASK_FRAMES frames in turn until the mode reads IN_EYE. No live run behind it.
	const MODE_ORDER = [IN_EYE, 1];
	const MODE_ASK_FRAMES = 30;
	// How often a clip whose camera locked too late is sought again before it is skipped.
	const CAMERA_RETRIES = 2;

	// The demo camera's observer mode now; null when it cannot be read this frame, undefined when this
	// HLAE has no getObserverMode (before 2.171.0), so first person can never be confirmed.
	function observerMode() {
		try {
			const local = mirv.getEntityFromSplitScreenPlayer(0);
			if (local === null) return null;
			const pawn = mirv.getEntityFromIndex(mirv.getHandleEntryIndex(local.getPlayerPawnHandle()));
			if (pawn === null) return null;
			if (typeof pawn.getObserverMode !== 'function') return undefined;
			return pawn.getObserverMode();
		} catch (err) {
			return null;
		}
	}

	// Holds the demo camera on the clip's player: spec_player with the controller's entity index, sent
	// every frame. That is what HLAE's mirv_script_spec_lock snippet does, and what its author gave as the
	// way to lock the camera after CS2 1.41.6.2 stopped honouring a single spec_player (advancedfx #1172).
	function holdPlayer() {
		mirv.exec('spec_player ' + controller);
	}

	// Puts the camera on the clip's player in first person. It holds the player every frame, and until
	// the mode reads in-eye it asks for first person (MODE_ORDER), because a demo can already follow the
	// player in chase mode. Returns 'locked' once the camera reads as on the player in first person,
	// 'no_mode' when this HLAE cannot report the mode, else 'waiting'.
	function lockCamera(c) {
		if (controller === null) controller = findController(c.steamid);
		if (controller === null) return 'waiting';
		holdPlayer();
		const mode = observerMode();
		if (mode === undefined) return 'no_mode';
		if (observedController() === controller && mode === IN_EYE) return 'locked';
		if (mode !== IN_EYE) {
			mirv.exec('spec_mode ' + MODE_ORDER[Math.floor(modeAsks / MODE_ASK_FRAMES) % MODE_ORDER.length]);
			modeAsks++;
		}
		return 'waiting';
	}

	function startRecording(c) {
		mirv.exec('mirv_streams record name "' + JOB.outDir + '/' + c.id + '"');
		mirv.exec('mirv_streams record start');
		log('START ' + c.id + ' tick=' + tickNow());
	}

	// The host reads this line: the clip, the nonce, and why its recording ended or never began
	// (clips/launch.rs read_console). Only why=end_tick counts as recorded.
	function endLine(c, why) {
		mirv.message('[cs2stats] END ' + c.id + ' nonce=' + JOB.nonce + ' why=' + why + ' tick=' + tickNow() + '\n');
	}

	function stopRecording(c, why) {
		mirv.exec('mirv_streams record end');
		endLine(c, why);
	}

	// Gives up on a clip that was never recorded, saying why, and goes on to the next.
	function skipClip(c, why, message) {
		log('ERROR ' + message + '; skipping it');
		endLine(c, why);
		nextClip();
	}

	function nextClip() {
		clip++;
		seekTries = 0;
		camTries = 0;
		modeAsks = 0;
		lockedBefore = false;
		controller = null;
		if (clip < currentDemo().clips.length) setState(S.SEEK);
		else setState(S.NEXT_DEMO);
	}

	function loadDemo() {
		const d = currentDemo();
		clip = 0;
		seekTries = 0;
		camTries = 0;
		modeAsks = 0;
		lockedBefore = false;
		controller = null;
		mirv.exec('playdemo "' + d.path + '"');
		log('loading demo ' + (demo + 1) + ' of ' + JOB.demos.length + ' with ' + d.clips.length + ' clips');
		setState(S.LOAD);
	}

	function step() {
		frame++;
		const playing = mirv.isPlayingDemo();
		const tick = playing ? tickNow() : -1;
		const c = currentClip();

		switch (state) {
			case S.BOOT:
				// give the main menu a moment, then set up and load the first demo
				if (frame - stateFrame < JOB.bootFrames) return;
				for (const cmd of JOB.setup) mirv.exec(cmd);
				hideDemoUi();
				loadDemo();
				return;

			case S.LOAD:
				if (playing && tick > 0) {
					log('demo playing at tick ' + tick);
					setState(S.SEEK);
				} else if (frame - stateFrame > JOB.loadTimeoutFrames) {
					log('ERROR demo ' + (demo + 1) + ' did not start; skipping it');
					setState(S.NEXT_DEMO);
				}
				return;

			case S.SEEK: {
				const d = currentDemo();
				const lead = Math.round(JOB.seekLeadSeconds * d.tickrate);
				if (!playing) { log('ERROR demo stopped while seeking'); setState(S.NEXT_DEMO); return; }
				if (seekTries === 0 || frame - stateFrame > JOB.seekRetryFrames) {
					if (seekTries < 3) {
						const target = Math.max(1, c.start - lead);
						mirv.exec('demo_gototick ' + target);
						seekTries++;
						stateFrame = frame;
						log('seek ' + c.id + ' to tick ' + target + ' (try ' + seekTries + ')');
						return;
					}
					skipClip(c, 'seek_failed', 'could not reach ' + c.id);
					return;
				}
				if (mirv.isDemoPaused()) mirv.exec('demo_resume');
				// landed shortly before the clip: wait there for its start
				if (tick >= c.start - lead - d.tickrate && tick < c.start) {
					controller = null; // entity indices can change across a seek
					lockedBefore = false;
					setState(S.PREROLL);
				}
				return;
			}

			case S.PREROLL: {
				if (!playing) { log('ERROR demo stopped before ' + c.id); setState(S.NEXT_DEMO); return; }
				if (mirv.isDemoPaused()) mirv.exec('demo_resume');
				const cam = lockCamera(c);
				if (cam === 'no_mode') {
					skipClip(c, 'camera_mode_unknown', 'HLAE cannot report the observer mode, so first person cannot be confirmed for ' + c.id);
					return;
				}
				if (tick < c.start) {
					lockedBefore = cam === 'locked';
					return;
				}
				// the start tick: record only when the camera was on the player in first person before it, and still is
				if (lockedBefore && cam === 'locked') {
					startRecording(c);
					setState(S.REC);
					return;
				}
				if (controller === null) {
					skipClip(c, 'no_player', 'could not find the player for ' + c.id);
					return;
				}
				if (camTries < CAMERA_RETRIES) {
					camTries++;
					seekTries = 0;
					log('camera not on the player before ' + c.id + ' started; seeking back (try ' + camTries + ')');
					setState(S.SEEK);
					return;
				}
				skipClip(c, 'camera_late', 'could not put the camera on the player in first person before ' + c.id + ' started');
				return;
			}

			case S.REC:
				if (!playing || mirv.isDemoPaused()) { stopRecording(c, 'demo_end'); nextClip(); return; }
				if (tick >= c.end) { stopRecording(c, 'end_tick'); nextClip(); return; }
				holdPlayer();
				if (observedController() !== controller || observerMode() !== IN_EYE) {
					// the camera left the player or first person: stop rather than record something else
					stopRecording(c, 'camera_lost');
					nextClip();
				}
				return;

			case S.NEXT_DEMO:
				demo++;
				if (demo < JOB.demos.length) loadDemo();
				else setState(S.FINISH);
				return;

			case S.FINISH:
				// let the encoder finish writing, then close the game
				if (frame - stateFrame >= JOB.finishFrames) {
					restoreDemoUi();
					log('ALL DONE job=' + JOB.id);
					setState(S.DONE);
					if (JOB.quitWhenDone) mirv.exec('quit');
				}
				return;

			default:
				return;
		}
	}

	// Once per rendered frame. If a game update renumbers the render stage, fall back to the stage
	// that fires most often, as povforge does, so the director still runs.
	let stage = JOB.frameStage;
	let events = 0;
	const seen = {};
	mirv.events.clientFrameStageNotify.on(NAME, (e) => {
		if (e.isBefore) return;
		events++;
		if (frame === 0 && e.curStage !== stage) {
			seen[e.curStage] = (seen[e.curStage] || 0) + 1;
			if (events === 2000) {
				let best = stage, n = -1;
				for (const k in seen) if (seen[k] > n) { n = seen[k]; best = Number(k); }
				log('WARNING frame stage ' + stage + ' never seen; using ' + best);
				stage = best;
			}
		}
		if (e.curStage !== stage) return;
		try {
			step();
		} catch (err) {
			log('ERROR ' + err);
			const c = currentClip();
			if (c && state === S.REC) stopRecording(c, 'error');
			setState(S.FINISH);
		}
	});

	log('director loaded job=' + JOB.id + ': ' + JOB.demos.length + ' demos');
}
