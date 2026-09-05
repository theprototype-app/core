// R22 ROUND 13 — THE 3D PREVIEW'S CONTROLS: the turntable, the gestures, and the two
// corner readings.
//
//   "when auto-rotate is clicked it should stop rotating, now it just stops showing"
//   "rotate enable/disable by single click (keep ability to rotate)"
//   "after rotating manually object if not clicked to disable rotation it should continue"
//   "it should be possible to pan and zoom objects"
//   "cog auto rotate is a default setting for all objects which opens"
//   "stats at bottom ... and it should disappear when opacity less than 100"
//
// WHY THIS IS ITS OWN SUITE. Every check here is a PIXEL check, and a pixel check needs a
// browser with WebGL contexts to spare. Each ModelPreview takes its own context, and by
// the time `file-preview` has opened a dozen previews the browser refuses a new one
// WITHOUT SAYING SO — ModelPreview returns early and draws nothing, so a correct build
// reports a blank frame. Measured: the identical open produced a 75KB frame on a fresh
// page and a 6KB one at the end of that suite, with no page error either way. Splitting
// it is the fix; a longer wait is not.
//
// Run: APP_URL='https://localhost:5203/' npm run e2e -- model-preview-controls
const h = require('./helpers.cjs');

/** a real rendered frame of the fixture is ~60-70KB of PNG; a blank body is under 20KB */
const DRAWN = 20000;

h.run(async () => {
	// GPU_ARGS is not optional here: a software-rendered page runs at ~2.5fps, and every
	// "did it move" check below is a comparison across an 800ms window.
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A', { context: { viewport: { width: 1440, height: 900 } } });
	const page = A.page;
	const body = () => page.locator('#preview-body');
	const frame = async () => (await body().screenshot()).toString('base64');

	await page.waitForFunction(() => !!window.__stores?.filePreview && !!window.__stores?.explorer, null, {
		timeout: 30000
	});
	await page.evaluate(async () => {
		await window.__stores.explorer.loadExplorer();
		await window.__stores.explorer.clearLibrary();
		const f = window.__stores.filePreview;
		f.previewAutoRotate.set(true);
		// R22 ROUND 19 (user): "by default disable statistics". Left at the real default so
		// the sections below measure what a user actually opens.
		f.previewShowStats.set(false);
		f.previewMultiWindow.set(false);
		// round 14: opacity and passthrough are no longer stores — they are the window's own
		// state and start clean with every target, which §5 and §8 assert.
	});

	// a TORUS KNOT rather than a box: it fills the frame from every angle, so "did the
	// picture change" cannot be answered by a silhouette that happens to look the same
	const glbId = await page.evaluate(async () => {
		const s = window.__stores;
		const mesh = new s.THREE.Mesh(
			new s.THREE.TorusKnotGeometry(1, 0.35, 64, 12),
			new s.THREE.MeshStandardMaterial({ color: 0xff8844 })
		);
		const glb = await new Promise((res, rej) =>
			new s.GLTFExporterModule.GLTFExporter().parse(mesh, (r) => res(r), (e) => rej(e), { binary: true })
		);
		return (await s.explorer.addItemFromBytes(glb, 'knot.glb', null)).id;
	});
	await page.waitForTimeout(900);
	await page.locator('#explorer-slot').click();
	await page.waitForTimeout(900);
	await page.locator('[data-card-id="' + glbId + '"]').dblclick();
	await page.waitForTimeout(2600);

	const box = await body().boundingBox();
	const cx = box.x + box.width / 2;
	const cy = box.y + box.height / 2;

	// ---- 1. it opens turning, from the cog default ------------------------------------
	h.check(
		(await page.locator('#preview-body canvas').count()) === 1,
		'premise: a 3D object opens in the shared preview window'
	);
	// ---- THE CORNER HOLDS ONE OF TWO THINGS (round 19, user) ---------------------------
	// "I want 'Click to stop' to appear ... if there are no statistics shown, and by default
	// disable statistics" — so the mesh facts and the gesture prompt are ALTERNATIVES for one
	// row, and which you get is the statistics switch. This reverses round 14's rule (where
	// the prompt went WITH the reading) at the user's ask, and it is the better one: you
	// always have exactly one thing down there, and a fresh preview greets you with what to
	// DO rather than a triangle count.
	//
	// Read while this window is still untouched, because the prompt dismisses on first use.
	const promptGeom = await page.evaluate(() => {
		const b = document.querySelector('#preview-body').getBoundingClientRect();
		const tip = document.querySelector('.pv-hint');
		if (!tip) return null;
		const t = tip.getBoundingClientRect();
		return {
			stats: document.querySelectorAll('#preview-stats-line').length,
			tipAtBottom: b.bottom - t.bottom < 4,
			tipLeft: t.left - b.left < 40,
			tipEvents: getComputedStyle(tip).pointerEvents,
			tipText: (tip.textContent || '').replace(/\s+/g, ' ').trim()
		};
	});
	h.check(
		!!promptGeom && promptGeom.stats === 0,
		'a fresh preview shows no mesh statistics — they are off by default now (' +
			JSON.stringify(promptGeom) +
			')'
	);
	h.check(
		!!promptGeom && promptGeom.tipAtBottom && promptGeom.tipLeft,
		'...and the prompt takes the row the numbers would have had, flush at the bottom left'
	);
	h.check(
		!!promptGeom && promptGeom.tipEvents === 'none',
		'...and it takes no clicks, because the MODEL is the switch'
	);
	// it teaches the whole control set, not just the one gesture it is named after
	h.check(
		!!promptGeom && /drag to turn/i.test(promptGeom.tipText) && /zoom/i.test(promptGeom.tipText),
		'...and it names drag AND scroll, which is what an onboarding prompt is for (' +
			(promptGeom?.tipText ?? '') +
			')'
	);

	const spin1 = await frame();
	await page.waitForTimeout(800);
	const spin2 = await frame();
	// A FLOOR, not just "the frames differ": without it the whole suite can run over two
	// blank pictures and report success. Measured — the broken build compared 6364 against
	// 5376 and passed a ratio check.
	h.check(
		spin1 !== spin2 && spin2.length > DRAWN,
		'it opens auto-rotating AND is really drawing (' + spin2.length + ' bytes)'
	);

	// ---- 2. THE REPORTED BUG: it stops, and it stays drawn -----------------------------
	// "when auto-rotate is clicked it should stop rotating, now it just stops showing".
	// BOTH halves, because the broken build passed the first: the frames stopped changing
	// (which reads as the feature working) while the object had stopped being DRAWN. The
	// cause was `loop()` being called SYNCHRONOUSLY at the end of ModelPreview's effect, so
	// its first run read `autoSpin` INSIDE the tracking scope — the effect depended on it,
	// and toggling tore the WebGL context down and asked the same canvas for a second one,
	// which returns null.
	//
	// A SCREENSHOT, not a canvas read: `drawImage` off a WebGL canvas with no
	// preserveDrawingBuffer is always blank, which cost a probe that reported the model
	// missing in BOTH states.
	await page.mouse.click(cx, cy);
	await page.waitForTimeout(900);
	const still1 = await frame();
	await page.waitForTimeout(800);
	const still2 = await frame();
	h.check(still1 === still2, 'a single CLICK on the model stops the rotation');
	h.check(
		still2.length > DRAWN,
		'...and it is STILL DRAWN — the frame did not collapse to an empty one (' +
			spin2.length +
			' -> ' +
			still2.length +
			')'
	);
	await page.mouse.click(cx, cy);
	await page.waitForTimeout(900);
	const again1 = await frame();
	await page.waitForTimeout(800);
	h.check(again1 !== (await frame()), '...and clicking again starts it');

	// ---- 3. a drag ROTATES and only PAUSES ---------------------------------------------
	// "after rotating manually object if not clicked to disable rotation it should continue
	// to rotate". An earlier pass had a drag switch the turntable off on the reasoning that
	// you had taken over; the user's rule is better and simpler — one way in, one way out,
	// and nudging the model to see the other side does not silently cost you the turntable.
	await page.mouse.move(cx, cy);
	await page.mouse.down();
	await page.mouse.move(cx + 70, cy + 25, { steps: 6 });
	await page.mouse.up();
	await page.waitForTimeout(900);
	const afterDrag = await frame();
	await page.waitForTimeout(800);
	h.check(
		afterDrag !== (await frame()),
		'dragging rotates, and the turntable PICKS UP AGAIN on release — a drag is not the off switch'
	);
	// ...and a press that does NOT travel still is, which is the whole click/drag split
	await page.mouse.click(cx, cy);
	await page.waitForTimeout(900);
	const stopped = await frame();
	await page.waitForTimeout(800);
	h.check(stopped === (await frame()), '...while a click stops it, resting where it was');

	// ---- 4. THE GESTURE LINE PERSISTS (round 21, user) -----------------------------------
	//
	//   "if statistics disabled keep 'Click to stop' displayed below even if clicked (same
	//    for just objects)"
	//
	// Round 14 made it an onboarding prompt dismissed by the first gesture, on the standard
	// every 3D viewer follows. That was right for what the line WAS; round 19 changed what
	// it is — one of two things a permanent row can hold, the other being the mesh facts.
	// A row that empties itself after your first click looks broken, and this line has a
	// second job a prompt does not: it reports whether the turntable is running.
	//
	// The section above clicked and dragged several times, so this is the check.
	h.check(
		(await page.locator('.pv-hint').count()) === 1,
		'the gesture line is STILL there after the window has been clicked and dragged'
	);
	const wording = await page.evaluate(
		() => document.querySelector('.pv-hint')?.textContent?.replace(/\s+/g, ' ').trim() ?? ''
	);
	h.check(
		/click to auto-rotate/i.test(wording),
		'...and it reports the turntable is STOPPED, which is the state §3 left it in (' + wording + ')'
	);

	// ---- 5. the reading gets out of the way of a faded window ----------------------------
	// A faded window is being used as a REFERENCE over the scene, and chrome is the first
	// thing in the way of one.
	// through the REAL slider, because round 14 removed the store it used to drive - and
	// that is the better check anyway: the control and the effect, not a back door.
	await page.locator('#preview-cog').first().click();
	await page.waitForTimeout(400);
	await page.locator('#preview-stats').check();
	await page.waitForTimeout(500);
	h.check(
		(await page.locator('#preview-stats-line').count()) === 1,
		'switching the statistics on fills the corner (and this is the section that needs them)'
	);
	await page.locator('#preview-opacity').fill('40');
	await page.locator('#preview-opacity').dispatchEvent('input');
	await page.waitForTimeout(600);
	h.check(
		(await page.locator('#preview-stats-line').count()) === 0,
		'below full opacity the reading gets out of the way on its own'
	);
	const scopes = await page.evaluate(() =>
		[...document.querySelectorAll('#preview-settings .pv-scope')].map((p) => p.textContent?.trim())
	);
	h.check(
		scopes.length === 2 && /this window/i.test(scopes[0] || '') && /all previews/i.test(scopes[1] || ''),
		'the cog says which scope each half has, or the same panel silently means two things (' +
			JSON.stringify(scopes) +
			')'
	);
	await page.locator('#preview-opacity').fill('100');
	await page.locator('#preview-opacity').dispatchEvent('input');
	await page.waitForTimeout(600);
	h.check(
		(await page.locator('#preview-stats-line').count()) === 1,
		'...and it comes back at 100%'
	);
	await page.locator('#preview-cog').first().click();
	await page.waitForTimeout(300);

	// ---- 6. PAN AND ZOOM ----------------------------------------------------------------
	// the standard DCC set: left orbits, middle or Shift+left pans, the wheel dollies, and
	// a double-click puts the view home.
	const home = await frame();
	await page.mouse.move(cx, cy);
	await page.mouse.wheel(0, -400);
	await page.waitForTimeout(700);
	const zoomed = await frame();
	h.check(zoomed !== home, 'the wheel zooms');
	await page.keyboard.down('Shift');
	await page.mouse.down();
	await page.mouse.move(cx + 90, cy + 40, { steps: 6 });
	await page.mouse.up();
	await page.keyboard.up('Shift');
	await page.waitForTimeout(700);
	const panned = await frame();
	h.check(panned !== zoomed, 'Shift-drag pans');
	h.check(panned.length > DRAWN, '...and the model is still on screen after it (' + panned.length + ')');
	await body().dblclick();
	await page.waitForTimeout(900);
	h.check((await frame()) !== panned, 'and a double-click puts the view back home');
	// CLAMPED, or one flick of a trackpad loses the model for good with no way back
	await page.mouse.move(cx, cy);
	for (let i = 0; i < 40; i++) await page.mouse.wheel(0, 300);
	await page.waitForTimeout(800);
	const farOut = await frame();
	for (let i = 0; i < 80; i++) await page.mouse.wheel(0, -300);
	await page.waitForTimeout(800);
	const farIn = await frame();
	h.check(
		farOut.length > 2000 && farIn.length > 2000,
		'zooming to either extreme still draws something — the distance is clamped (' +
			farOut.length +
			' / ' +
			farIn.length +
			')'
	);
	await body().dblclick();
	await page.waitForTimeout(800);

	// ---- 7. the cog is the DEFAULT, and its boxes are themed ----------------------------
	// "cog auto rotate is a default setting for all objects which opens"
	if (!(await page.locator('#preview-settings').count())) {
		await page.locator('#preview-cog').first().click();
		await page.waitForTimeout(400);
	}
	const themed = await page.evaluate(() =>
		[...document.querySelectorAll('#preview-settings input[type=checkbox]')].map((c) =>
			(c.getAttribute('class') || '').includes('tp-check')
		)
	);
	h.check(
		themed.length >= 3 && themed.every(Boolean),
		'every checkbox in the cog is the app THEMED one, not the browser default (' +
			JSON.stringify(themed) +
			')'
	);
	// R22 ROUND 14 (user): "autorotate new previews setting is global, but should not
	// affect already opened windows". Start THIS one turning first, or "it did not change"
	// is not observable — the section before leaves it stopped.
	await page.locator('#preview-cog').first().click();
	await page.waitForTimeout(300);
	await page.mouse.click(cx, cy);
	await page.waitForTimeout(900);
	const pre1 = await frame();
	await page.waitForTimeout(800);
	const pre2 = await frame();
	h.check(pre1 !== pre2 && pre2.length > DRAWN, 'premise: this window is turning before the pref is touched');

	await page.locator('#preview-cog').first().click();
	await page.waitForTimeout(400);
	await page.locator('#preview-autorotate').uncheck();
	await page.waitForTimeout(700);
	h.check(
		(await page.evaluate(() => localStorage.getItem('preview:autoRotate'))) === 'false',
		'unticking it stores the DEFAULT for previews opened from now on'
	);
	const post1 = await frame();
	await page.waitForTimeout(800);
	h.check(
		post1 !== (await frame()),
		'...and the window you are READING does not stop — the label says NEW previews, and the model is this one’s switch'
	);
	// take the opacity off full too, so the reopen below can show BOTH per-window values
	// coming back clean
	await page.locator('#preview-opacity').fill('40');
	await page.locator('#preview-opacity').dispatchEvent('input');
	await page.waitForTimeout(400);
	if (await page.locator('#preview-settings').count()) {
		await page.locator('#preview-cog').first().click();
		await page.waitForTimeout(300);
	}
	// ...and a preview opened NOW starts from it, which is what makes it a default
	await page.locator('#image-preview-window button[title="Close"]').first().click();
	await page.waitForTimeout(700);
	await page.locator('[data-card-id="' + glbId + '"]').dblclick();
	await page.waitForTimeout(2600);
	const fresh1 = await frame();
	await page.waitForTimeout(800);
	const fresh2 = await frame();
	h.check(
		fresh2.length > DRAWN,
		'premise: the re-opened preview is really drawing (' + fresh2.length + ')'
	);
	h.check(
		fresh1 === fresh2,
		'a preview opened with the default OFF does not spin — which is what makes it a default'
	);
	// ...while the two PER-WINDOW settings came back clean, which is the other half of
	// round 14: a pref you would not want restored is not a pref, it is window state.
	const reopened = await page.evaluate(() => {
		const win = document.querySelector('#image-preview-window');
		const body = document.querySelector('#preview-body');
		return {
			through: win ? win.className.includes('pv-through') : null,
			faded: win ? win.className.includes('pv-faded') : null,
			bodyOpacity: body ? Number(getComputedStyle(body).opacity) : null
		};
	});
	h.check(
		reopened.faded === false && reopened.bodyOpacity === 1,
		'the OPACITY is back at full on the new target, though it was left at 40% (' +
			JSON.stringify(reopened) +
			')'
	);
	h.check(reopened.through === false, '...and passthrough is off, as a window opened to be looked at should be');
	// and the prompt is offered again to a FRESH window - it teaches per window, it just
	// never nags within one
	// the statistics were switched on in §5, and the two share a row — so the line only
	// returns once the reading is out of the way, which is round 19's whole rule
	h.check(
		(await page.locator('.pv-hint').count()) === 0,
		'with the statistics on, a fresh window shows THOSE and not the gesture line'
	);
	await page.locator('#preview-cog').first().click();
	await page.waitForTimeout(400);
	await page.locator('#preview-stats').uncheck();
	await page.waitForTimeout(500);
	await page.locator('#preview-cog').first().click();
	await page.waitForTimeout(300);
	h.check(
		(await page.locator('.pv-hint').count()) === 1,
		'...and switching them off hands the row back to the gesture line'
	);

	h.check(
		(h.pageErrors(A) || []).length === 0,
		'no page errors (' + (h.pageErrors(A) || []).join(' | ') + ')'
	);
	await h.finish(browser);
});
