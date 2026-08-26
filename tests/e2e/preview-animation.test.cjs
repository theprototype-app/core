// R22 ROUND 15 — THE OBJECT PREVIEW PLAYS ANIMATIONS.
//
//   "add to object preview window to automatically play animation and be able to pause
//    and slide animation using same player style, sliding updates frames, it should also
//    show amount of frames and current frame where paused"
//   "in cog I should be able to disable animation auto-play same as for auto-rotate"
//
// THE FINDING THIS BATCH RESTS ON, and it is older than the request: `parseObjectFile`
// returned `gltf.scene` and dropped `gltf.animations` on the floor. That is the ONE parse
// path the Explorer, its thumbnails and every preview share, so an animated .glb has been
// arriving in this app inert since the library was written. §1 pins it with the
// counterfactual measured in-page, because a suite that only checks the transport appears
// would pass just as well against a file whose clips were thrown away — it would simply
// never show a transport, and "no animation in this file" and "we lost the animation" look
// identical from the outside.
//
// A PIXEL-ADJACENT SUITE: it opens ModelPreviews, which take a WebGL context each, so it
// stays its own file for the reason `model-preview-controls` does.
//
// Run: APP_URL='https://localhost:5203/' npm run e2e -- preview-animation
const h = require('./helpers.cjs');

/** what the transport is showing, as the user would read it */
const readout = (p) =>
	p.page.evaluate(() => {
		const txt = (s) => document.querySelector(s)?.textContent?.trim() ?? null;
		const seek = document.querySelector('#anim-seek');
		return {
			present: !!document.querySelector('#anim-toggle'),
			frames: txt('#anim-frames'),
			clock: txt('#anim-clock'),
			seek: seek ? Number(seek.value) : null,
			playing: document.querySelector('.an-root')?.getAttribute('data-playing') ?? null,
			label: document.querySelector('#anim-toggle')?.getAttribute('aria-label') ?? null
		};
	});

h.run(async () => {
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A', { context: { viewport: { width: 1440, height: 900 } } });
	const page = A.page;

	await page.waitForFunction(() => !!window.__stores?.filePreview && !!window.__stores?.explorer, null, {
		timeout: 30000
	});
	await page.evaluate(async () => {
		await window.__stores.explorer.loadExplorer();
		await window.__stores.explorer.clearLibrary();
		const f = window.__stores.filePreview;
		f.previewAutoPlay.set(true);
		f.previewAutoRotate.set(false); // one moving thing at a time, or "did it move" is ambiguous
		f.previewShowStats.set(true);
		f.previewMultiWindow.set(false);
		localStorage.setItem('animationFps', '30');
	});

	// ---- the fixture: a 2s clip that lifts a box, exported as a real .glb ---------------
	// 2s at 30fps is 60 frames, which is a number a human can check the readout against.
	const made = await page.evaluate(async () => {
		const s = window.__stores;
		const THREE = s.THREE;
		const mesh = new THREE.Mesh(
			new THREE.BoxGeometry(1, 1, 1),
			new THREE.MeshStandardMaterial({ color: 0x44aaff })
		);
		mesh.name = 'Lifter';
		const clip = new THREE.AnimationClip('Lift', 2, [
			new THREE.VectorKeyframeTrack('Lifter.position', [0, 1, 2], [0, 0, 0, 0, 3, 0, 0, 0, 0])
		]);
		const glb = await new Promise((res, rej) =>
			new s.GLTFExporterModule.GLTFExporter().parse(mesh, (r) => res(r), (e) => rej(e), {
				binary: true,
				animations: [clip]
			})
		);
		const item = await s.explorer.addItemFromBytes(glb, 'lifter.glb', null);
		// THE COUNTERFACTUAL, measured rather than argued: what the app's own parse hands
		// back for these exact bytes. Before this round it was a scene with no clips at all.
		const parsed = await s.explorer.parseObjectFile(glb, 'glb');
		const still = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial());
		const stillGlb = await new Promise((res, rej) =>
			new s.GLTFExporterModule.GLTFExporter().parse(still, (r) => res(r), (e) => rej(e), { binary: true })
		);
		const stillItem = await s.explorer.addItemFromBytes(stillGlb, 'still.glb', null);
		// R22 ROUND 18: a SIX-SECOND clip — 180 frames — because the frame/seconds round
		// trip first slips at frame 123, which is past the end of the 60-frame fixture
		// above. That is precisely why the bug survived the first suite.
		const longMesh = new THREE.Mesh(
			new THREE.BoxGeometry(1, 1, 1),
			new THREE.MeshStandardMaterial({ color: 0x88ff44 })
		);
		longMesh.name = 'Longer';
		const longClip = new THREE.AnimationClip('Long', 6, [
			new THREE.VectorKeyframeTrack('Longer.position', [0, 3, 6], [0, 0, 0, 0, 2, 0, 0, 0, 0])
		]);
		const longGlb = await new Promise((res, rej) =>
			new s.GLTFExporterModule.GLTFExporter().parse(longMesh, (r) => res(r), (e) => rej(e), {
				binary: true,
				animations: [longClip]
			})
		);
		const longItem = await s.explorer.addItemFromBytes(longGlb, 'longer.glb', null);
		return {
			id: item.id,
			stillId: stillItem.id,
			longId: longItem.id,
			carried: Array.isArray(parsed.animations) ? parsed.animations.length : -1,
			duration: parsed.animations?.[0]?.duration ?? 0
		};
	});

	// ---- 1. THE PARSE CARRIES THE CLIPS --------------------------------------------------
	h.check(
		made.carried === 1,
		'the app’s own parse hands back the file’s animation — it returned the scene alone before this round (' +
			made.carried +
			' clips)'
	);
	h.check(
		Math.abs(made.duration - 2) < 0.05,
		'...with its real duration, so the frame count below is derived from the file and not a guess (' +
			made.duration +
			's)'
	);

	// ---- 2. it opens PLAYING, and the transport says so ----------------------------------
	await page.locator('#explorer-slot').click();
	await page.waitForTimeout(900);
	await page.locator('[data-card-id="' + made.id + '"]').dblclick();
	await page.waitForTimeout(2400);

	const first = await readout(A);
	h.check(first.present, 'an animated file gets a transport (' + JSON.stringify(first) + ')');
	h.check(
		first.frames === '60/60'.replace('60/', first.frames?.split('/')[0] + '/') && /\/60$/.test(first.frames ?? ''),
		'...reading its total in FRAMES: 2s at 30fps is 60 of them (' + first.frames + ')'
	);
	h.check(first.playing === 'true' && first.label === 'Pause', 'it auto-plays, as the pref says');

	// it is REALLY running: the readout climbs on its own
	await page.waitForTimeout(700);
	const later = await readout(A);
	const f1 = Number(first.frames?.split('/')[0]);
	const f2 = Number(later.frames?.split('/')[0]);
	h.check(f2 !== f1, 'the frame counter advances by itself (' + first.frames + ' -> ' + later.frames + ')');
	h.check(later.seek > 0, '...and the slider tracks it rather than sitting at zero (' + later.seek + ')');

	// ---- 3. PAUSE, and it stays where it was ---------------------------------------------
	await page.locator('#anim-toggle').click();
	await page.waitForTimeout(500);
	const paused = await readout(A);
	h.check(paused.playing === 'false' && paused.label === 'Play', 'the button pauses it');
	await page.waitForTimeout(800);
	const stillPaused = await readout(A);
	h.check(
		stillPaused.frames === paused.frames,
		'...and the frame it stopped on is the frame it stays on — which is the reading the user asked for (' +
			paused.frames +
			')'
	);

	// ---- 4. SCRUBBING MOVES THE MODEL, not just the number --------------------------------
	// The clip lifts the box to y=3 at the midpoint and puts it back by the end, so the
	// PICTURE has a signature no counter can fake: start and end must look the SAME and the
	// middle must not. A transport whose slider moved a label while the mesh stood still
	// would pass every check above this one.
	//
	// Measured in pixels rather than through a debug hook into the scene graph, because the
	// question is "did the model move on screen", and the auto-rotate is off for this suite
	// precisely so that the only thing that can change the picture is the clip.
	// THE CANVAS, not the body: the transport strip lives INSIDE #preview-body and its own
	// frame counter reads "1/60" at one end and "60/60" at the other, so a body shot can
	// never match itself across a scrub. The first version of this check failed for exactly
	// that reason and the app was right the whole time.
	const body = () => page.locator('#preview-body canvas');
	const poseAt = async (frac) => {
		await page.evaluate((f) => {
			const el = document.querySelector('#anim-seek');
			const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
			set.call(el, String(Math.round(f * 1000)));
			el.dispatchEvent(new Event('input', { bubbles: true }));
		}, frac);
		await page.waitForTimeout(320);
		return (await body().screenshot()).toString('base64');
	};

	const atStart = await poseAt(0);
	const atMid = await poseAt(0.5);
	const atEnd = await poseAt(1);
	h.check(atStart.length > 5000, 'premise: the preview is really drawing (' + atStart.length + ' bytes)');
	h.check(
		atMid !== atStart,
		'dragging the slider POSES the model — the midpoint of a lift does not look like its start'
	);
	// COUNTED PIXELS, not byte equality. A PNG of two renders of the same pose is not
	// guaranteed identical — the mixer lands on t=2.0 by a different route than it starts at
	// t=0 and the rasteriser is free to differ by an edge pixel — so the claim is the one
	// that actually matters: the end is FAR closer to the start than the lifted midpoint is.
	// Measured: ~0.1% of the frame against ~9%.
	const endVsStart = await h.frameDelta(page, atStart, atEnd);
	const midVsStart = await h.frameDelta(page, atStart, atMid);
	h.check(
		!endVsStart.error && !midVsStart.error && endVsStart.changed * 10 < midVsStart.changed,
		'...and the end returns to the start, an order of magnitude closer than the lifted midpoint — so the scrub follows the curve rather than just climbing (' +
			JSON.stringify({ endVsStart: endVsStart.changed, midVsStart: midVsStart.changed }) +
			')'
	);
	const scrubbed = await readout(A);
	h.check(
		/^60[/]/.test(scrubbed.frames ?? ''),
		'the readout follows the handle — "sliding updates frames", as asked (' + scrubbed.frames + ')'
	);

	// ---- 5. FRAME STEPPING, by button and by key -------------------------------------------
	await page.evaluate(() => {
		const el = document.querySelector('#anim-seek');
		const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
		set.call(el, '500');
		el.dispatchEvent(new Event('input', { bubbles: true }));
	});
	await page.waitForTimeout(400);
	const before = Number((await readout(A)).frames?.split('/')[0]);
	await page.locator('#anim-next-frame').click();
	await page.waitForTimeout(350);
	const after = Number((await readout(A)).frames?.split('/')[0]);
	h.check(after === before + 1, 'the step button moves exactly ONE frame (' + before + ' -> ' + after + ')');
	await page.locator('#anim-prev-frame').click();
	await page.waitForTimeout(350);
	h.check(
		Number((await readout(A)).frames?.split('/')[0]) === before,
		'...and back, so a step is reversible'
	);

	// the keys. ARROWS are the file walk in this window, so frame stepping takes the
	// comma/period binding every video tool ships.
	await page.locator('#preview-body').click({ position: { x: 20, y: 20 } });
	await page.waitForTimeout(300);
	const keyBase = Number((await readout(A)).frames?.split('/')[0]);
	await page.keyboard.press('Period');
	await page.waitForTimeout(350);
	h.check(
		Number((await readout(A)).frames?.split('/')[0]) === keyBase + 1,
		'"." steps a frame from the keyboard'
	);
	await page.keyboard.press('Comma');
	await page.waitForTimeout(350);
	h.check(Number((await readout(A)).frames?.split('/')[0]) === keyBase, '"," steps back');
	// Space plays here for the same reason it does on the audio player
	await page.keyboard.press('Space');
	await page.waitForTimeout(500);
	h.check((await readout(A)).playing === 'true', 'Space plays, the way it does for audio');
	await page.keyboard.press('Space');
	await page.waitForTimeout(400);
	h.check((await readout(A)).playing === 'false', '...and pauses');

	// ---- 6. A STILL FILE GETS NO TRANSPORT --------------------------------------------------
	// The alternative — a disabled strip over every static model — is chrome that can never
	// do anything, on the majority of files.
	await page.locator('#image-preview-window button[title="Close"]').first().click();
	await page.waitForTimeout(600);
	await page.locator('[data-card-id="' + made.stillId + '"]').dblclick();
	await page.waitForTimeout(2200);
	const still = await readout(A);
	h.check(!still.present, 'a model with no clips shows no transport at all');
	const statsBottom = await page.evaluate(() => {
		const b = document.querySelector('#preview-body')?.getBoundingClientRect();
		const s = document.querySelector('#preview-stats-line')?.getBoundingClientRect();
		return b && s ? Math.round(b.bottom - s.bottom) : null;
	});
	h.check(
		statsBottom !== null && statsBottom < 4,
		'...and the reading sits flush at the bottom, where it was before this round (' + statsBottom + 'px up)'
	);

	// ---- 7. THE READINGS STEP OVER THE TRANSPORT --------------------------------------------
	await page.locator('#image-preview-window button[title="Close"]').first().click();
	await page.waitForTimeout(500);
	await page.locator('[data-card-id="' + made.id + '"]').dblclick();
	await page.waitForTimeout(2200);
	const stacked = await page.evaluate(() => {
		const strip = document.querySelector('.an-root')?.getBoundingClientRect();
		const stats = document.querySelector('#preview-stats-line')?.getBoundingClientRect();
		const hint = document.querySelector('.pv-hint')?.getBoundingClientRect();
		if (!strip || !stats) return null;
		return {
			statsAbove: stats.bottom <= strip.top + 1,
			hintAbove: !hint || hint.bottom <= stats.top + 1
		};
	});
	h.check(
		!!stacked && stacked.statsAbove,
		'with a transport present the mesh facts move UP above it rather than under it (' +
			JSON.stringify(stacked) +
			')'
	);
	h.check(!!stacked && stacked.hintAbove, '...and the prompt stays above the facts');

	// ---- 8. THE COG: auto-play is a DEFAULT, like auto-rotate --------------------------------
	await page.locator('#preview-cog').first().click();
	await page.waitForTimeout(400);
	h.check(
		(await page.locator('#preview-autoplay').count()) === 1,
		'the cog carries the switch the user asked for'
	);
	const themed = await page.evaluate(() =>
		(document.querySelector('#preview-autoplay')?.getAttribute('class') || '').includes('tp-check')
	);
	h.check(themed, '...as the app’s themed box, like its neighbours');
	// it must NOT stop the window you are reading — the auto-rotate ruling, same shape
	await page.locator('#anim-toggle').click(); // make sure it is running
	await page.waitForTimeout(400);
	if ((await readout(A)).playing !== 'true') {
		await page.locator('#anim-toggle').click();
		await page.waitForTimeout(400);
	}
	h.check((await readout(A)).playing === 'true', 'premise: it is playing before the pref is touched');
	await page.locator('#preview-autoplay').uncheck();
	await page.waitForTimeout(700);
	h.check(
		(await page.evaluate(() => localStorage.getItem('preview:autoPlay'))) === 'false',
		'unticking it stores the default'
	);
	h.check(
		(await readout(A)).playing === 'true',
		'...and does NOT stop the window in front of you — the same rule auto-rotate follows'
	);
	await page.locator('#preview-cog').first().click();
	await page.waitForTimeout(300);

	// ...and the next preview opens paused, on its first frame
	await page.locator('#image-preview-window button[title="Close"]').first().click();
	await page.waitForTimeout(600);
	await page.locator('[data-card-id="' + made.id + '"]').dblclick();
	await page.waitForTimeout(2400);
	const opened = await readout(A);
	h.check(
		opened.present && opened.playing === 'false',
		'a preview opened with auto-play OFF does not run (' + JSON.stringify(opened) + ')'
	);
	h.check(
		/^1\//.test(opened.frames ?? ''),
		'...and sits on frame 1, not on wherever the last one stopped (' + opened.frames + ')'
	);

	// ---- 9. the shared transport look ---------------------------------------------------------
	// "same player style" is kept by sharing the stylesheet, so the two strips must really
	// be resolving the same rules rather than looking similar by coincidence.
	const shared = await page.evaluate(() => {
		const s = document.querySelector('.an-strip');
		return s ? { h: Math.round(s.getBoundingClientRect().height), cls: s.className } : null;
	});
	h.check(
		!!shared && /tp-tr-strip/.test(shared.cls) && shared.h === 30,
		'the animation strip is the app’s shared transport, at the same height as the audio one (' +
			JSON.stringify(shared) +
			')'
	);

	// =====================================================================================
	// R22 ROUND 16 — the three things the user hit while USING it
	// =====================================================================================

	// ---- 10. TOUCHING THE SLIDER MUST NOT KILL THE SHORTCUTS -----------------------------
	// "when clicked on player, then cannot use space to play/pause and , . shortcuts".
	// The window's key handler treated any INPUT as a text field, so the transport's own
	// slider — the most natural thing to touch in a media window — suppressed every
	// shortcut in the window while it held focus.
	await page.locator('#anim-seek').click();
	await page.waitForTimeout(300);
	const focused = await page.evaluate(() => document.activeElement?.id ?? null);
	h.check(focused === 'anim-seek', 'premise: clicking the slider really does focus it (' + focused + ')');

	const beforeSpace = (await readout(A)).playing;
	await page.keyboard.press('Space');
	await page.waitForTimeout(500);
	h.check(
		(await readout(A)).playing !== beforeSpace,
		'Space still plays and pauses with the slider focused — a range is a CONTROL, not a text field'
	);
	// leave it paused for the frame checks
	if ((await readout(A)).playing === 'true') {
		await page.keyboard.press('Space');
		await page.waitForTimeout(400);
	}
	const beforeComma = Number((await readout(A)).frames?.split('/')[0]);
	await page.keyboard.press('Period');
	await page.waitForTimeout(320);
	h.check(
		Number((await readout(A)).frames?.split('/')[0]) === beforeComma + 1,
		'...and so does "." (' + beforeComma + ' -> ' + (await readout(A)).frames + ')'
	);
	// the ONE exception, kept on purpose: a focused slider still owns the ARROWS, because
	// stepping the control under your hand is what those keys do everywhere. They must NOT
	// walk to the next file from here.
	const titleBefore = await page.evaluate(
		() => document.querySelector('#image-preview-window .move-handle')?.textContent?.trim() ?? ''
	);
	await page.locator('#anim-seek').focus();
	await page.keyboard.press('ArrowRight');
	await page.waitForTimeout(400);
	const titleAfter = await page.evaluate(
		() => document.querySelector('#image-preview-window .move-handle')?.textContent?.trim() ?? ''
	);
	h.check(
		titleBefore === titleAfter,
		'a focused slider keeps the arrows for itself rather than walking to the next file (' +
			titleBefore +
			' / ' +
			titleAfter +
			')'
	);

	// ---- 11. STEPPING PAST THE END WRAPS, and never stalls -------------------------------
	// "using forward shortcut holding it sometimes hangs after ~150 frames and does not
	// proceed further" — 150 frames being the length of their clip. Two causes: the last
	// frame was a dead end, and a step computed its next position from the readout, which
	// comes back from the mixer through a callback and cannot keep up with key repeat.
	await page.locator('#preview-body').click({ position: { x: 20, y: 20 } });
	await page.waitForTimeout(300);
	if ((await readout(A)).playing === 'true') {
		await page.keyboard.press('Space');
		await page.waitForTimeout(400);
	}
	// park on frame 1, then walk the whole clip and three frames past it
	await page.evaluate(() => {
		const el = document.querySelector('#anim-seek');
		const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
		set.call(el, '0');
		el.dispatchEvent(new Event('input', { bubbles: true }));
	});
	await page.waitForTimeout(400);
	await page.locator('#preview-body').click({ position: { x: 20, y: 20 } });
	await page.waitForTimeout(250);
	const total = Number((await readout(A)).frames?.split('/')[1]);
	h.check(total === 60, 'premise: a 60-frame clip to walk (' + total + ')');
	for (let i = 0; i < total + 2; i++) await page.keyboard.press('Period');
	await page.waitForTimeout(600);
	const wrapped = Number((await readout(A)).frames?.split('/')[0]);
	h.check(
		wrapped !== total,
		'holding the step key does not dead-end on the last frame (landed on ' + wrapped + ' of ' + total + ')'
	);
	h.check(
		wrapped === 3,
		'...it WRAPS, exactly as playback does — 62 steps from frame 1 of 60 is frame 3, and every press counted (' +
			wrapped +
			')'
	);
	// and backwards over the start, for the same reason
	for (let i = 0; i < 4; i++) await page.keyboard.press('Comma');
	await page.waitForTimeout(500);
	h.check(
		Number((await readout(A)).frames?.split('/')[0]) === total - 1,
		'...and back past the start lands on the end of the clip'
	);

	// ---- 12. THE TWO NEW SHORTCUTS --------------------------------------------------------
	// "would it be good to add shortcut also to auto-rotate and show statistics?" — R for
	// this WINDOW's turntable (the same act as clicking the model), I for the info overlay,
	// which is the shared pref because hiding chrome everywhere at once is what it is for.
	const canvasShot = async () => (await page.locator('#preview-body canvas').screenshot()).toString('base64');
	await page.keyboard.press('r');
	await page.waitForTimeout(700);
	const r1 = await canvasShot();
	await page.waitForTimeout(800);
	h.check(r1 !== (await canvasShot()), 'R starts this window turning');
	await page.keyboard.press('r');
	await page.waitForTimeout(700);
	const r2 = await canvasShot();
	await page.waitForTimeout(800);
	h.check(r2 === (await canvasShot()), '...and R stops it');
	h.check(
		(await page.evaluate(() => localStorage.getItem('preview:autoRotate'))) === 'false',
		'...without touching the PREF, which is a default for new previews and not this window'
	);

	h.check((await page.locator('#preview-stats-line').count()) === 1, 'premise: the reading is up');
	await page.keyboard.press('i');
	await page.waitForTimeout(500);
	h.check((await page.locator('#preview-stats-line').count()) === 0, 'I hides the mesh statistics');
	h.check(
		(await page.evaluate(() => localStorage.getItem('preview:showStats'))) === 'false',
		'...and that one IS the shared switch, so every open preview agrees'
	);
	await page.keyboard.press('i');
	await page.waitForTimeout(500);
	h.check((await page.locator('#preview-stats-line').count()) === 1, '...and I brings it back');

	// ---- 13. THE STEP DOES NOT WEDGE PAST FRAME 122 (round 18) ---------------------------
	//
	//   "using forward shortcut holding it sometimes hangs after ~150 frames and do not
	//    proceed with a shortcut further ... stops on frame 123 and cannot move forward
	//    unless clicked by mouse"
	//
	// REPRODUCED ON THE USER'S OWN 456-FRAME FBX, dead on 123 of 456 — nowhere near the end
	// of anything. A step converts a frame to SECONDS and the readout converts it back, and
	// that round trip is not the identity in binary floating point: frame 123 at 30fps is
	// 4.1s, and 4.1 * 30 is 122.99999999999999. So the readout answered 123 where 124 was
	// asked for, the next step recomputed its successor from 123, and every press after that
	// landed in the same place while doing exactly what it was told.
	//
	// A 180-FRAME FIXTURE, because §5's 60-frame one ends before the first index where the
	// arithmetic slips — which is exactly how this shipped past a green suite.
	await page.locator('#image-preview-window button[title="Close"]').first().click();
	await page.waitForTimeout(500);
	await page.locator('[data-card-id="' + made.longId + '"]').dblclick();
	await page.waitForTimeout(2400);
	const total180 = Number((await readout(A)).frames?.split('/')[1]);
	h.check(total180 === 180, 'premise: a 180-frame clip, long enough to cross frame 123 (' + total180 + ')');
	await page.locator('#preview-body').click({ position: { x: 20, y: 20 } });
	await page.waitForTimeout(300);
	if ((await readout(A)).playing === 'true') {
		await page.keyboard.press('Space');
		await page.waitForTimeout(400);
	}
	await page.evaluate(() => {
		const el = document.querySelector('#anim-seek');
		const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
		set.call(el, '0');
		el.dispatchEvent(new Event('input', { bubbles: true }));
	});
	await page.waitForTimeout(400);
	await page.locator('#preview-body').click({ position: { x: 20, y: 20 } });
	await page.waitForTimeout(250);
	h.check(Number((await readout(A)).frames?.split('/')[0]) === 1, 'premise: parked on frame 1');
	// the presses carry `repeat: true`, which is what an OS auto-repeat sends while a key
	// is held — the gesture the report is about
	for (let i = 0; i < 140; i++) {
		await page.evaluate(() =>
			document
				.querySelector('#image-preview-window')
				?.dispatchEvent(
					new KeyboardEvent('keydown', { key: '.', code: 'Period', bubbles: true, repeat: true })
				)
		);
	}
	await page.waitForTimeout(600);
	const walked = Number((await readout(A)).frames?.split('/')[0]);
	h.check(
		walked !== 123,
		'a held step key does not wedge on frame 123 (' + walked + ')'
	);
	h.check(
		walked === 141,
		'...it counts EVERY press: 140 steps from frame 1 is frame 141, not one short and not one stuck (' +
			walked +
			')'
	);

	// ---- 14. ONE COG ACROSS EVERY WINDOW (round 18) ----------------------------------------
	//
	//   "if clicked cog on both window and then click on Passthrough makes first window were
	//    opened to change this option, this is a bug, also allow cog to be opened only to
	//    show for one window even if I have multiple ones"
	//
	// The bug and the request have one fix. Every window renders the same settings pane, so
	// two open cogs put two elements with id="preview-passthrough" in the document — and a
	// <label for> resolves to the FIRST match anywhere, so the second window's label toggled
	// the first window's setting. Since round 14 made these per-window, that moves a setting
	// on a window you are not even looking at.
	await page.evaluate(() => window.__stores.filePreview.previewMultiWindow.set(true));
	await page.waitForTimeout(300);
	await page.locator('[data-card-id="' + made.stillId + '"]').dblclick();
	await page.waitForTimeout(1800);
	const windows = await page.evaluate(() => document.querySelectorAll('[data-preview-id]').length);
	h.check(windows >= 2, 'premise: two preview windows are open (' + windows + ')');

	// REAL MOUSE CLICKS at measured points, with elementFromPoint as the premise. The two
	// windows overlap by design (a 28px cascade) and playwright's actionability heuristic
	// keeps reporting the lower one as "not stable", which is a fact about the cascade
	// rather than about the cog — so the aim is verified directly instead.
	const cogPoint = async (i) =>
		page.evaluate((n) => {
			const w = document.querySelectorAll('[data-preview-id]')[n];
			const b = w?.querySelector('#preview-cog')?.getBoundingClientRect();
			if (!b) return null;
			const x = Math.round(b.x + b.width / 2);
			const y = Math.round(b.y + b.height / 2);
			const hit = document.elementFromPoint(x, y);
			return { x, y, onCog: hit?.closest('#preview-cog') !== null };
		}, i);

	const p0 = await cogPoint(0);
	h.check(!!p0?.onCog, 'premise: the first window’s cog is really under its own pixel (' + JSON.stringify(p0) + ')');
	await page.mouse.click(p0.x, p0.y);
	await page.waitForTimeout(500);
	h.check(
		(await page.locator('#preview-settings').count()) === 1,
		'premise: the first window’s cog is open'
	);
	// RAISE THE SECOND WINDOW FIRST, the way a user reaching for its cog would: opening the
	// first window's cog raised THAT window (focusStack), so its settings pane is now over
	// the second window's header. That is correct behaviour, and the reason the second cog
	// was unreachable until asked for properly.
	const raised = await page.evaluate(() => {
		const w = document.querySelectorAll('[data-preview-id]')[1];
		const h = w.querySelector('.move-handle').getBoundingClientRect();
		for (let x = Math.round(h.right - 6); x > h.left; x -= 12) {
			const y = Math.round(h.y + h.height / 2);
			const hit = document.elementFromPoint(x, y);
			if (hit && hit.closest('[data-preview-id]') === w && !hit.closest('button'))
				return { x, y };
		}
		return null;
	});
	h.check(!!raised, 'premise: some of the second window’s header is reachable (' + JSON.stringify(raised) + ')');
	await page.mouse.click(raised.x, raised.y);
	await page.waitForTimeout(400);

	const p1 = await cogPoint(1);
	h.check(!!p1?.onCog, 'premise: and the second window’s cog is under its own pixel (' + JSON.stringify(p1) + ')');
	await page.mouse.click(p1.x, p1.y);
	await page.waitForTimeout(500);
	const panes = await page.evaluate(() => ({
		panes: document.querySelectorAll('#preview-settings').length,
		ids: document.querySelectorAll('#preview-passthrough').length
	}));
	h.check(
		panes.panes === 1,
		'opening a second cog closes the first — one settings pane exists at a time (' +
			JSON.stringify(panes) +
			')'
	);
	h.check(
		panes.ids === 1,
		'...which is what makes its ids unique, so no <label for> can reach into another window'
	);

	// and the setting really lands on the window whose cog is open
	const throughBefore = await page.evaluate(() =>
		[...document.querySelectorAll('[data-preview-id]')].map((w) =>
			w.className.includes('pv-through')
		)
	);
	await page.locator('#preview-settings label[for="preview-passthrough"]').click();
	await page.waitForTimeout(500);
	const throughAfter = await page.evaluate(() =>
		[...document.querySelectorAll('[data-preview-id]')].map((w) =>
			w.className.includes('pv-through')
		)
	);
	const moved = throughAfter.map((v, i) => v !== throughBefore[i]).filter(Boolean).length;
	h.check(
		moved === 1,
		'clicking the label changes exactly ONE window (' + JSON.stringify({ before: throughBefore, after: throughAfter }) + ')'
	);
	await page.evaluate(() => window.__stores.filePreview.previewMultiWindow.set(false));

	h.check(
		(h.pageErrors(A) || []).length === 0,
		'no page errors (' + (h.pageErrors(A) || []).join(' | ') + ')'
	);
	await h.finish(browser);
});
