// The clip director: HLAE loads it into CS2 with mirv_script_load, from the one-line cfg the render
// launch writes. It runs the whole recording on its own, once per rendered frame: for each demo of
// the job, play it; for each clip, seek a little before the start, put the camera on the POV player
// in first person, record from the start tick to the end tick with mirv_streams; then quit.
//
// Adapted from CS2-povforge's director.js (Copyright (c) 2026 Chester-chs, MIT; THIRD_PARTY_NOTICES.md),
// which plays one demo per launch. This one plays the job's demos in turn. The API is HLAE's
// mirv-script (advancedfx misc/mirv-script/src/types/mirv.d.ts).
//
// The app's host (src-tauri/src/clips/job.rs) replaces the job placeholder below with the job as
// JSON. Every line it logs starts with "[cs2stats]", so CS2's console.log says what happened to each clip.
// HLAE's script cannot write files, so these lines are the director's only record: the host copies a
// job's block, from "director loaded job=<id>" to "ALL DONE job=<id>", into the job's session.log, and a
// take counts as recorded only when its "END <clip> ... why=end_tick" line is there (clips/mod.rs).
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
	let controller = null;

	const log = (msg) => mirv.message('[cs2stats] ' + msg + '\n');
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

	// Follows the clip's player in first person (spec_mode 2); true once the camera is on them.
	function lockCamera(c) {
		if (controller === null) controller = findController(c.steamid);
		if (controller === null) return false;
		if (observedController() !== controller) {
			mirv.exec('spec_player ' + controller);
			mirv.exec('spec_mode 2');
			return false;
		}
		return true;
	}

	function startRecording(c) {
		mirv.exec('mirv_streams record name "' + JOB.outDir + '/' + c.id + '"');
		mirv.exec('mirv_streams record start');
		log('START ' + c.id + ' tick=' + tickNow());
	}

	function stopRecording(c, why) {
		mirv.exec('mirv_streams record end');
		log('END ' + c.id + ' tick=' + tickNow() + ' why=' + why);
	}

	function nextClip() {
		clip++;
		seekTries = 0;
		controller = null;
		if (clip < currentDemo().clips.length) setState(S.SEEK);
		else setState(S.NEXT_DEMO);
	}

	function loadDemo() {
		const d = currentDemo();
		clip = 0;
		seekTries = 0;
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
					log('ERROR could not reach ' + c.id + '; skipping it');
					nextClip();
					return;
				}
				if (mirv.isDemoPaused()) mirv.exec('demo_resume');
				// landed shortly before the clip: wait there for its start
				if (tick >= c.start - lead - d.tickrate && tick < c.start) {
					controller = null; // entity indices can change across a seek
					setState(S.PREROLL);
				}
				return;
			}

			case S.PREROLL: {
				if (!playing) { log('ERROR demo stopped before ' + c.id); setState(S.NEXT_DEMO); return; }
				if (mirv.isDemoPaused()) mirv.exec('demo_resume');
				const locked = lockCamera(c);
				if (tick >= c.end) {
					log('ERROR could not put the camera on the player for ' + c.id + '; skipping it');
					nextClip();
				} else if (tick >= c.start && locked) {
					startRecording(c);
					setState(S.REC);
				}
				return;
			}

			case S.REC:
				if (!playing || mirv.isDemoPaused()) { stopRecording(c, 'demo_end'); nextClip(); return; }
				if (tick >= c.end) { stopRecording(c, 'end_tick'); nextClip(); return; }
				if (observedController() !== controller) {
					// the camera left the player: stop rather than record someone else
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
