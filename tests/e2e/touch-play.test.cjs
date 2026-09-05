// W4 — PLAY MODE ON A PHONE: the left half moves, the right half looks, and there are
// two ways out (a ✕ and the hardware Back button).
//
// The claim worth testing is NOT that an overlay renders. It is that a thumb reaches the
// SAME movement code WASD and the gamepad reach — so the checks read the rig's own pose
// through `playerCam` rather than any store the overlay writes, and the gates that must
// stand the input down (the E3 menu substate, the 'keys' claim) are driven for real.
//
// A desktop context cannot report `(pointer: coarse)`; a context created with
// `{ hasTouch: true, isMobile: true }` can, which is the documented way to reach it.
const h = require('./helpers.cjs');

// An EXPLICIT phone viewport, not just the flags. Without it the context keeps the
// 1280x720 default under a mobile page SCALE, so CDP's input coordinates and the
// clientX the overlay reads are in different spaces — a 110px drag arrived as 30 and
// every distance in this file would have been quietly measuring the scale factor.
const TOUCH_CTX = {
	hasTouch: true,
	isMobile: true,
	deviceScaleFactor: 2.7,
	viewport: { width: 390, height: 844 }
};

const lockedState = (page) =>
	page.evaluate(() => new Promise((r) => window.__stores.isLocked.subscribe((v) => r(v))()));

/** The play rig — the object PointerLockControls translates and turns. */
const rig = (page) =>
	page.evaluate(() => {
		let cam;
		window.__stores.playerCam.subscribe((v) => (cam = v))();
		if (!cam) return null;
		return { pos: cam.position.toArray(), quat: cam.quaternion.toArray() };
	});

const dist = (a, b) => Math.hypot(a.pos[0] - b.pos[0], a.pos[1] - b.pos[1], a.pos[2] - b.pos[2]);
/** how far apart two orientations are, in radians */
const turn = (a, b) => {
	const dot = Math.abs(a.quat.reduce((s, v, i) => s + v * b.quat[i], 0));
	return 2 * Math.acos(Math.min(1, dot));
};

const nap = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Drive a REAL touch gesture through CDP, not a constructed PointerEvent.
 *
 * The first version dispatched synthetic PointerEvents and cost two readings: they
 * carry a pointerId no browser ever issued, so the editor's OrbitControls threw
 * `setPointerCapture: No active pointer with the given id is found` on every press —
 * a page error, which `h.finish` (rightly) fails the run on. `Input.dispatchTouchEvent`
 * makes the engine synthesize the whole pointer sequence itself, so the events travel
 * the path a thumb's do, capture works, and `pointerType` is genuinely 'touch'.
 */
const gesture = async (page, cdp, points, { stepMs = 20, holdMs = 0 } = {}) => {
	await page.evaluate(() => {
		window.__w4prevented = null;
	});
	await cdp.send('Input.dispatchTouchEvent', {
		type: 'touchStart',
		touchPoints: [{ x: points[0][0], y: points[0][1], id: 1 }]
	});
	for (let i = 1; i < points.length; i++) {
		await nap(stepMs);
		await cdp.send('Input.dispatchTouchEvent', {
			type: 'touchMove',
			touchPoints: [{ x: points[i][0], y: points[i][1], id: 1 }]
		});
	}
	if (holdMs) await nap(holdMs);
	// touchEnd carries the points that REMAIN down, so lifting the only finger is []
	await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
	// CDP resolves when the event is DISPATCHED, not when the page has handled it —
	// reading straight after returned the PREVIOUS gesture's verdict every time.
	await nap(150);
	return page.evaluate(() => ({
		prevented: window.__w4prevented,
		lastUp: window.__stores.playInteract.playInteractDebug().lastUp
	}));
};

/**
 * Watch what the overlay claims. Registered LAST on the window's bubble phase, so it
 * runs after playInteract's own listener and reads the verdict both of them agreed on
 * through the event — which is the seam under test.
 */
const watchClaims = (page) =>
	page.evaluate(() => {
		window.__w4prevented = null;
		window.addEventListener('pointerup', (e) => {
			window.__w4prevented = e.defaultPrevented;
		});
	});

const historyState = (page) =>
	page.evaluate(() => ({
		tpPlay: !!(history.state && history.state.tpPlay),
		marker: window.__stores.playMode.playBackMarker(),
		href: location.href,
		mounted: !!document.querySelector('#play-button') || !!document.querySelector('canvas')
	}));

h.run(async () => {
	const browser = await h.launch();

	// ---- 0. a plain desktop window is byte-unchanged -----------------------------
	const D = await h.setupPage(browser, 'D');
	await D.page.locator('#play-button').click();
	await h.eventually(() => lockedState(D.page), (v) => v === true, 'desktop still enters play');
	const desktopOverlay = await D.page.evaluate(() => ({
		exit: !!document.querySelector('#play-exit'),
		stick: !!document.querySelector('#touch-move-stick')
	}));
	h.check(
		!desktopOverlay.exit && !desktopOverlay.stick,
		`a fine-pointer window gets no touch overlay (exit=${desktopOverlay.exit}, stick=${desktopOverlay.stick})`
	);
	await D.page.keyboard.press('Escape');
	await h.eventually(() => lockedState(D.page), (v) => v !== true, 'desktop Escape still exits');

	const A = await h.setupPage(browser, 'A', { context: TOUCH_CTX });
	const cdp = await A.page.context().newCDPSession(A.page);
	await watchClaims(A.page);

	// the premise the whole suite rests on
	const coarse = await A.page.evaluate(() => window.__stores.inputDevice.coarsePointer());
	h.check(coarse === true, 'the touch context reports (pointer: coarse)');

	// ---- 1. entering play gives a phone a way out -------------------------------
	await A.page.locator('#play-button').click();
	await h.eventually(() => lockedState(A.page), (v) => v === true, 'touch device enters play');
	const entered = await A.page.evaluate(() => {
		const exit = document.querySelector('#play-exit');
		return {
			exit: !!exit,
			label: exit?.getAttribute('aria-label') ?? null,
			// an icon-only control needs a real hit target on a phone
			box: exit ? exit.getBoundingClientRect().width : 0,
			stick: !!document.querySelector('#touch-move-stick')
		};
	});
	h.check(entered.exit, 'the ✕ renders as soon as play starts');
	h.check(entered.label === 'Exit play', `and it is named (aria-label=${entered.label})`);
	h.check(entered.box >= 40, `with a thumb-sized target (${entered.box}px)`);
	h.check(!entered.stick, 'no stick is drawn before a finger lands');

	const size = await A.page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }));
	// the premise every coordinate below depends on: CDP input space IS CSS pixel space
	h.check(
		size.w === TOUCH_CTX.viewport.width,
		`input coordinates are 1:1 with the layout (innerWidth=${size.w})`
	);
	const L = Math.round(size.w * 0.25);
	const R = Math.round(size.w * 0.75);
	const midY = Math.round(size.h * 0.55);

	// ---- 2. the LEFT half moves --------------------------------------------------
	const beforeMove = await rig(A.page);
	// push the stick FORWARD (up the screen) and hold it there while frames run
	const movedGesture = await gesture(A.page, cdp, [
			[L, midY],
			[L, midY - 30],
			[L, midY - 70]
		],
		{ holdMs: 700 }
	);
	const afterMove = await rig(A.page);
	h.check(
		dist(beforeMove, afterMove) > 0.1,
		`a left-half stick walks the rig (${dist(beforeMove, afterMove).toFixed(3)} units)`
	);
	h.check(
		turn(beforeMove, afterMove) < 0.02,
		`and only walks it (${turn(beforeMove, afterMove).toFixed(4)} rad of turn)`
	);
	h.check(
		movedGesture.prevented && movedGesture.lastUp === 'touch-gesture',
		`the movement pad is never a trigger (prevented=${movedGesture.prevented}, lastUp=${movedGesture.lastUp})`
	);

	// the stick RELEASES: nothing may keep moving once the finger is gone
	const restA = await rig(A.page);
	await A.page.waitForTimeout(500);
	const restB = await rig(A.page);
	h.check(dist(restA, restB) < 0.01, 'lifting the finger stops the rig dead');

	// ---- 3. the RIGHT half looks -------------------------------------------------
	const beforeLook = await rig(A.page);
	const lookGesture = await gesture(A.page, cdp, [
			[R, midY],
			[R + 30, midY],
			[R + 70, midY],
			[R + 110, midY]
		],
		{ stepMs: 25 }
	);
	await A.page.waitForTimeout(250);
	const afterLook = await rig(A.page);
	h.check(
		turn(beforeLook, afterLook) > 0.05,
		`a right-half drag turns the rig (${turn(beforeLook, afterLook).toFixed(4)} rad)`
	);
	h.check(
		dist(beforeLook, afterLook) < 0.05,
		`without walking it (${dist(beforeLook, afterLook).toFixed(4)} units)`
	);
	h.check(
		lookGesture.prevented && lookGesture.lastUp === 'touch-gesture',
		`a look DRAG is claimed, so it cannot also click (prevented=${lookGesture.prevented}, lastUp=${lookGesture.lastUp})`
	);

	// ---- 4. a short still tap is an INTERACT, not a look -------------------------
	const beforeTap = await rig(A.page);
	const tap = await gesture(A.page, cdp, [[R, midY], [R + 2, midY + 1]], { stepMs: 10 });
	await A.page.waitForTimeout(250);
	const afterTap = await rig(A.page);
	h.check(
		turn(beforeTap, afterTap) < 0.01,
		`a tap does not turn the view (${turn(beforeTap, afterTap).toFixed(4)} rad)`
	);
	h.check(
		!tap.prevented,
		'and it is NOT claimed, so it falls through to playInteract (tap to interact)'
	);
	h.check(
		tap.lastUp !== 'touch-gesture',
		`playInteract saw the tap as its own (lastUp=${tap.lastUp})`
	);

	// ---- 5. the menu substate owns the pointer -----------------------------------
	await A.page.evaluate(() => window.__stores.playPointerFree.set(true));
	await A.page.waitForTimeout(200);
	const beforeMenu = await rig(A.page);
	await gesture(A.page, cdp, [[L, midY], [L, midY - 70]], { holdMs: 500 });
	await gesture(A.page, cdp, [[R, midY], [R + 110, midY]], { stepMs: 25 });
	await A.page.waitForTimeout(200);
	const afterMenu = await rig(A.page);
	h.check(
		dist(beforeMenu, afterMenu) < 0.05 && turn(beforeMenu, afterMenu) < 0.01,
		`with a menu up both halves are dead (${dist(beforeMenu, afterMenu).toFixed(4)} units, ${turn(beforeMenu, afterMenu).toFixed(4)} rad)`
	);
	const exitDuringMenu = await A.page.evaluate(() => {
		const exit = document.querySelector('#play-exit');
		return { present: !!exit, disabled: exit ? exit.disabled : true };
	});
	h.check(
		exitDuringMenu.present && !exitDuringMenu.disabled,
		'the ✕ stays reachable while a menu is up — it is the way out of one'
	);
	await A.page.evaluate(() => window.__stores.playPointerFree.set(false));
	await A.page.waitForTimeout(200);

	// ---- 6. the ✕ leaves play ----------------------------------------------------
	await A.page.locator('#play-exit').click();
	await h.eventually(() => lockedState(A.page), (v) => v !== true, 'the ✕ exits play');
	await h.eventually(() => lockedState(A.page), (v) => v === null, '...and settles to null');
	const restored = await A.page.evaluate(() => {
		const burger = document.querySelector('.burger');
		return { editor: !!burger && !burger.closest('div.hidden'), overlay: !!document.querySelector('#play-exit') };
	});
	h.check(restored.editor, 'the editor UI comes back');
	h.check(!restored.overlay, 'and the overlay goes with play mode');

	// ---- 7. the hardware Back button ---------------------------------------------
	await A.page.locator('#play-button').click();
	await h.eventually(() => lockedState(A.page), (v) => v === true, 'play re-enters');
	const marked = await historyState(A.page);
	h.check(
		marked.tpPlay && marked.marker,
		`entering play pushes one history marker (state=${marked.tpPlay}, held=${marked.marker})`
	);

	const hrefBefore = marked.href;
	await A.page.goBack().catch(() => {});
	await h.eventually(() => lockedState(A.page), (v) => v !== true, 'Back exits play instead of the app');
	const afterBack = await historyState(A.page);
	h.check(afterBack.href === hrefBefore, `and stays on the page (${afterBack.href === hrefBefore})`);
	h.check(afterBack.mounted, 'the app is still mounted after Back');
	h.check(!afterBack.tpPlay && !afterBack.marker, 'the marker is spent, not left on the stack');

	// ...and a NORMAL exit must give the Back button back to the user. This is the
	// guard: without the consume, the marker would still be on top after a ✕ exit and
	// the next real Back press would be silently swallowed by it.
	await h.eventually(() => lockedState(A.page), (v) => v === null, 'settled before re-entry');
	await A.page.locator('#play-button').click();
	await h.eventually(() => lockedState(A.page), (v) => v === true, 'play re-enters once more');
	await A.page.locator('#play-exit').click();
	await h.eventually(() => lockedState(A.page), (v) => v !== true, 'the ✕ exits again');
	await A.page.waitForTimeout(400);
	const afterNormalExit = await historyState(A.page);
	h.check(
		!afterNormalExit.tpPlay && !afterNormalExit.marker,
		`a normal exit consumes the marker, so the next Back is the user's (state=${afterNormalExit.tpPlay}, held=${afterNormalExit.marker})`
	);

	// ---- 8. the pad's master switch does not gate a thumb -------------------------
	// The `enabled` test moved off the movement `if` and onto the pad SNAPSHOT, because
	// a phone has no gamepad prefs to go and find — switching the pad off must not take
	// the only movement control on the device with it.
	await A.page.evaluate(() =>
		window.__stores.gamepadPrefs.setGamepadPrefs({ enabled: false })
	);
	await A.page.locator('#play-button').click();
	await h.eventually(() => lockedState(A.page), (v) => v === true, 'play re-enters with the pad off');
	const beforeNoPad = await rig(A.page);
	await gesture(A.page, cdp, [[L, midY], [L, midY - 70]], { holdMs: 700 });
	const afterNoPad = await rig(A.page);
	h.check(
		dist(beforeNoPad, afterNoPad) > 0.1,
		`the stick still walks with the gamepad disabled (${dist(beforeNoPad, afterNoPad).toFixed(3)} units)`
	);
	await A.page.locator('#play-exit').click();
	await h.eventually(() => lockedState(A.page), (v) => v !== true, 'and the ✕ still exits');

	await h.finish(browser);
});
