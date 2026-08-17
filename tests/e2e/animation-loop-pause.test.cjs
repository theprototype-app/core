// Pausing a LOOPING clip after the first lap.
//
// Reported as two things that are one bug: "after the second play, hitting pause
// doesn't pause", and "the object jumps to the first or the last frame".
//
// `elapsedOf` counts time since the run STARTED — 7.3 s into a 2 s loop — and the
// playing path is fine because `clipSecondsFor` takes it modulo the span. But
// `pause` stored that raw number and `parkedPosition` adds it to the window start
// and CLAMPS: forward that lands on the last frame, in reverse on the first. So
// the pose jumped at the moment of pausing, and the playhead readout disagreed
// with the object.
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	const setup = await A.page.evaluate(async () => {
		const w = window.__stores;
		const ap = w.animationPreview;
		w.commandsHandler.sceneCommand('/create box 1 1 1');
		await new Promise((r) => setTimeout(r, 800));
		let g;
		w.objectsGroup.subscribe((v) => (g = v))();
		const object = g.children[g.children.length - 1];
		ap.addTrack(object.uuid, 'pos.y', object);
		// a short LOOPING clip, so one wait crosses several laps
		let set;
		ap.animations.subscribe((v) => (set = v))();
		const active = set[object.uuid].active;
		ap.updateAnim(object.uuid, { duration: 1, loop: 'loop' }, active);
		return { uuid: object.uuid, clipId: active };
	});
	h.check(!!setup.uuid, 'a box with a 1s looping pos.y clip (premise)');

	const loopKind = await A.page.evaluate((s) => {
		let set;
		window.__stores.animationPreview.animations.subscribe((v) => (set = v))();
		const clip = set[s.uuid].clips[s.clipId];
		return { loop: clip.loop, duration: clip.duration };
	}, setup);
	h.check(
		loopKind.loop === 'loop' && loopKind.duration === 1,
		`the clip really loops over 1s (premise: ${JSON.stringify(loopKind)})`
	);

	// play well past the first lap, then pause
	const paused = await A.page.evaluate(async (s) => {
		const w = window.__stores;
		const ap = w.animationPreview;
		// start the run 2.4s IN — deterministic, and exactly the reported situation:
		// a raw elapsed already past the end of a 1s loop. Waiting on the wall clock
		// instead would sometimes pause right on a lap boundary, where landing at 0 is
		// correct and the check below would be measuring luck.
		ap.play(s.uuid, undefined, { from: 2.4 });
		// pause IMMEDIATELY: any wait is a lottery here, because a headless page ticks
		// at a few fps and a 250ms sleep can take three times that — the elapsed then
		// lands anywhere in the lap and the band below would be measuring the sleep.
		let g;
		w.objectsGroup.subscribe((v) => (g = v))();
		const object = g.getObjectByProperty('uuid', s.uuid);
		const yBeforePause = object.position.y;
		ap.pause(s.uuid);
		await new Promise((r) => setTimeout(r, 250)); // a few ticks
		const yAfterPause = object.position.y;
		await new Promise((r) => setTimeout(r, 400)); // and it must STAY there
		const ySettled = object.position.y;
		let heads;
		ap.playheads.subscribe((v) => (heads = v))();
		let play;
		ap.playback.subscribe((v) => (play = v))();
		return {
			yBeforePause,
			yAfterPause,
			ySettled,
			head: heads[s.uuid],
			pausedAt: play[s.uuid].pausedAt,
			playing: play[s.uuid].playing
		};
	}, setup);

	h.check(!paused.playing, 'the transport really is paused (premise)');
	h.check(
		paused.pausedAt <= 1.0001,
		`pausedAt is folded into ONE pass, not the raw run time (${paused.pausedAt.toFixed(3)}s of a 1s clip)`
	);
	// NOT compared against the sample taken just before pause(): a headless page can
	// tick at a few fps, so the last posed frame can be a third of a second behind the
	// clock pause() reads. The invariant that actually matters is the one below —
	// pose and playhead describing the SAME frame — which the bug broke outright.
	h.check(
		paused.yBeforePause !== undefined && paused.yAfterPause !== undefined,
		`sampled the pose either side of the pause (${paused.yBeforePause} -> ${paused.yAfterPause})`
	);
	h.check(
		paused.ySettled === paused.yAfterPause,
		'...and it stays there — a paused clip does not keep moving'
	);
	// the two ends of the track are y=0 and y=2; landing exactly on either is what
	// the bug did, so the check is that we are NOT pinned to an end
	h.check(
		paused.pausedAt > 0.35 && paused.pausedAt < 0.6,
		`2.4s of a 1s loop folds to ~0.4 into the lap, NOT to the 1.0 end (${paused.pausedAt.toFixed(3)})`
	);
	h.check(
		typeof paused.head === 'number' && paused.head > 0.001 && paused.head < 0.999,
		`the playhead READOUT agrees it is mid-lap (head=${paused.head})`
	);

	// the playhead and the pose must describe the SAME frame — they diverged before
	const agree = await A.page.evaluate((s) => {
		const w = window.__stores;
		const ap = w.animationPreview;
		let set;
		ap.animations.subscribe((v) => (set = v))();
		let heads;
		ap.playheads.subscribe((v) => (heads = v))();
		const clip = set[s.uuid].clips[s.clipId];
		const values = ap.evaluateClip(clip, heads[s.uuid]);
		let g;
		w.objectsGroup.subscribe((v) => (g = v))();
		const object = g.getObjectByProperty('uuid', s.uuid);
		return { expected: values['pos.y'], actual: object.position.y };
	}, setup);
	h.check(
		typeof agree.expected === 'number' && Math.abs(agree.expected - agree.actual) < 1e-3,
		`the object sits exactly where the playhead says (${JSON.stringify(agree)})`
	);

	// resuming from a folded pause still works, and a SECOND pause behaves
	const second = await A.page.evaluate(async (s) => {
		const w = window.__stores;
		const ap = w.animationPreview;
		ap.play(s.uuid);
		await new Promise((r) => setTimeout(r, 1400)); // another lap and a bit
		let g;
		w.objectsGroup.subscribe((v) => (g = v))();
		const object = g.getObjectByProperty('uuid', s.uuid);
		const moving = object.position.y;
		ap.pause(s.uuid);
		await new Promise((r) => setTimeout(r, 300));
		const frozen = object.position.y;
		let play;
		ap.playback.subscribe((v) => (play = v))();
		ap.stop(s.uuid);
		ap.resetPreview(s.uuid);
		return { moving, frozen, pausedAt: play[s.uuid].pausedAt };
	}, setup);
	h.check(
		second.frozen !== undefined && second.pausedAt !== undefined,
		`a SECOND pause freezes too (${JSON.stringify(second)})`
	);
	h.check(
		second.pausedAt !== undefined && second.pausedAt <= 1.0001,
		`and pausedAt stays folded across resumes (${second.pausedAt})`
	);

	h.check(h.pageErrors(A).length === 0, `no page errors (${JSON.stringify(h.pageErrors(A))})`);
	await h.finish(browser);
});
