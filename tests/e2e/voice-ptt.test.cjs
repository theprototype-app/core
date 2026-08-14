// 17-E F1 — push-to-talk is a BARE hold, and the pane's keys stay in the pane.
//
// Two halves of one report ("copying keys in the timeline opened my mic"):
//
//  * voiceChat's own window listener matched the KEY and nothing else, so Ctrl+V —
//    paste, in the timeline or anywhere — engaged the microphone. The shortcut
//    registry never had this bug: it holds 'V' while comboOf builds 'Ctrl+V', which
//    is exactly why Ctrl+C does not toggle chat.
//  * the Animation pane's keyNav called preventDefault but not stopPropagation, so
//    every key it consumed ALSO reached the global registry — 1 and 2 arm the pane's
//    Move/Scale and simultaneously drove the gizmo's translate/rotate.
//
// The mic side needs a real key event travelling the real path: the listener sits on
// window, so a synthetic dispatch would pass while the user's keystroke still opened
// the mic.
const h = require('./helpers.cjs');

/** what the mic is actually doing, from the stores the UI renders */
const mic = (page) =>
	page.evaluate(() => {
		const v = window.__stores.voiceChat;
		let ptt, active, mode;
		v.pttActive.subscribe((/** @type {boolean} */ x) => (ptt = x))();
		v.micActive.subscribe((/** @type {boolean} */ x) => (active = x))();
		v.vrMicMode.subscribe((/** @type {string} */ x) => (mode = x))();
		return { ptt, active, mode };
	});

h.run(async () => {
	// a fake device, so a bare V can really open a stream and the "it did engage"
	// half of the check is not vacuous
	const browser = await h.launch({
		args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream']
	});
	const A = await h.setupPage(browser, 'A');
	await A.page.waitForFunction(() => !!window.__stores?.voiceChat, { timeout: 20000 });

	// ---------- 1. the mode PTT lives in ----------
	const start = await mic(A.page);
	h.check(start.mode === 'ptt', `the mic starts in push-to-talk mode (${start.mode})`);
	h.check(!start.ptt && !start.active, 'and nothing is transmitting yet');

	// a pointerdown first: the AudioContext starts suspended until a user gesture
	await A.page.mouse.click(5, 5);
	await A.page.waitForTimeout(150);

	// "did the mic EVER open" is the honest observable for a brief keystroke — a
	// settled read after a press shows false even with the bug in, because the keyup
	// resets the flag on the way out.
	await A.page.evaluate(() => {
		/** @type {any} */ (window).__pttSeen = false;
		window.__stores.voiceChat.pttActive.subscribe((/** @type {boolean} */ on) => {
			if (on) /** @type {any} */ (window).__pttSeen = true;
		});
	});
	const everOpened = () => A.page.evaluate(() => /** @type {any} */ (window).__pttSeen);
	const resetSeen = () => A.page.evaluate(() => (/** @type {any} */ (window).__pttSeen = false));

	// ---------- 2. a BARE V opens the mic (and warms the stream) ----------
	// This runs FIRST on purpose. The very first getUserMedia takes longer than a
	// short hold, so a modified-key probe made before it resolves reads false whether
	// the bail is there or not — the check would pass with the bug in. Opening the mic
	// once makes ensureStream instant for every probe below.
	await A.page.keyboard.down('v');
	await h.eventually(
		() => mic(A.page),
		(/** @type {any} */ m) => m.ptt === true,
		'holding a bare V opens the mic'
	);
	await A.page.keyboard.up('v');
	await h.eventually(
		() => mic(A.page),
		(/** @type {any} */ m) => m.ptt === false,
		'and releasing it closes the mic again'
	);

	// ---------- 3. no MODIFIED form of it does ----------
	// HELD, not pressed: a press releases in the same breath and the keyup resets the
	// flag, so a settled reading after a press shows false even with the bug in — the
	// mic blipped open in between. Holding is what the observable can see, and it is
	// also what a real slow paste does.
	const heldWith = async (/** @type {string} */ mod) => {
		await resetSeen();
		await A.page.keyboard.down(mod);
		await A.page.keyboard.down('v');
		await A.page.waitForTimeout(700); // ensureStream is async — give it room
		const state = await mic(A.page);
		await A.page.keyboard.up('v');
		await A.page.keyboard.up(mod);
		await A.page.waitForTimeout(200);
		return { ...state, ever: await everOpened() };
	};
	const afterCtrlV = await heldWith('Control');
	h.check(
		!afterCtrlV.ptt && !afterCtrlV.active && !afterCtrlV.ever,
		`holding Ctrl+V never opens the mic (ptt ${afterCtrlV.ptt}, mic ${afterCtrlV.active}, ever ${afterCtrlV.ever})`
	);

	// the same for the other modified forms — none of them is a PTT hold
	const afterMeta = await heldWith('Meta');
	const afterAlt = await heldWith('Alt');
	h.check(
		!afterMeta.ever && !afterAlt.ever,
		`nor do Meta+V / Alt+V (${afterMeta.ever} / ${afterAlt.ever})`
	);

	// ---------- 4. Ctrl pressed MID-HOLD must still release ----------
	// the keyup path is deliberately NOT modifier-guarded: guarding it would strand
	// pttHeld true and hold the mic open for the rest of the session.
	await A.page.keyboard.down('v');
	await h.eventually(
		() => mic(A.page),
		(/** @type {any} */ m) => m.ptt === true,
		'a fresh bare hold opens it'
	);
	await A.page.keyboard.down('Control');
	await A.page.keyboard.up('v');
	await A.page.keyboard.up('Control');
	await h.eventually(
		() => mic(A.page),
		(/** @type {any} */ m) => m.ptt === false,
		'pressing Ctrl mid-hold and releasing V still closes it (no stuck mic)'
	);

	// ---------- 5. the pane: Ctrl+V pastes keys and the mic stays shut ----------
	const uuid = await A.page.evaluate(async () => {
		const s = window.__stores;
		s.commandsHandler.sceneCommand('/create box');
		await new Promise((r) => setTimeout(r, 400));
		let g;
		s.objectsGroup.subscribe((/** @type {any} */ x) => (g = x))();
		const obj = g.children[g.children.length - 1];
		obj.name = 'Lifter';
		obj.position.set(0, 0, 0);
		obj.updateMatrix();
		const ap = s.animationPreview;
		const track = ap.addTrack(obj.uuid, 'pos.y', obj);
		ap.updateKey(obj.uuid, track, 0, { t: 0, v: 0 });
		ap.updateKey(obj.uuid, track, 1, { t: 1, v: 2 });
		ap.updateAnim(obj.uuid, { duration: 2, loop: 'loop' });
		s.objectActions.selectObject(obj.uuid, false);
		s.animationClose.set(false);
		s.bottomDock.activateDock('animation');
		await new Promise((r) => setTimeout(r, 500));
		return obj.uuid;
	});
	const plot = await A.page.locator('#animation-timeline').boundingBox();
	h.check(!!plot, 'the timeline renders for the pane checks');
	await A.page.mouse.click(plot.x + 6, plot.y + plot.height - 6);
	await A.page.waitForTimeout(150);

	// select a key, copy it, move the playhead, paste — the pane's own Ctrl+C/V
	const keyCount = () =>
		A.page.evaluate((id) => {
			const ap = window.__stores.animationPreview;
			const clip = ap.activeClip(id);
			return clip?.tracks?.[0]?.keys?.length ?? 0;
		}, uuid);
	await A.page.evaluate((id) => window.__stores.animationPreview.scrub(id, 0), uuid);
	await A.page.keyboard.press('Control+Space'); // add the key at the playhead
	await A.page.waitForTimeout(150);
	await A.page.keyboard.press('Control+c');
	await A.page.waitForTimeout(150);
	const before = await keyCount();
	await A.page.evaluate((id) => window.__stores.animationPreview.scrub(id, 1.5), uuid);
	await resetSeen();
	await A.page.keyboard.down('Control');
	await A.page.keyboard.down('v');
	await A.page.waitForTimeout(700);
	const pasteMic = await mic(A.page);
	await A.page.keyboard.up('v');
	await A.page.keyboard.up('Control');
	await A.page.waitForTimeout(400);
	const after = await keyCount();
	h.check(after === before + 1, `Ctrl+V in the pane pastes a key (${before} -> ${after})`);
	h.check(
		!pasteMic.ptt && !(await everOpened()),
		`and the reported bug is gone: the mic never opened (ptt ${pasteMic.ptt}, ever ${await everOpened()})`
	);

	// ---------- 6. keys the pane consumes never reach the global registry ----------
	// 1 and 2 arm the pane's Move/Scale; the same digits drive the gizmo's
	// translate/rotate through shortcuts.js, and both used to fire at once.
	const gizmoMode = () =>
		A.page.evaluate(() => {
			let m;
			window.__stores.transformMode.subscribe((/** @type {string} */ v) => (m = v))();
			return m;
		});
	await A.page.evaluate(() => window.__stores.transformMode.set('translate'));
	await A.page.keyboard.press('2'); // pane: arm Scale. global: rotate.
	await A.page.waitForTimeout(200);
	const modeAfter2 = await gizmoMode();
	h.check(
		modeAfter2 === 'translate',
		`pressing 2 in the pane leaves the gizmo alone (${modeAfter2})`
	);
	const armed = await A.page.evaluate(() =>
		[...document.querySelectorAll('#animation-dock button, #animation-window button')]
			.filter((b) => b.getAttribute('aria-pressed') === 'true')
			.map((b) => b.textContent?.trim())
	);
	h.check(
		armed.some((/** @type {string} */ t) => /scale/i.test(t || '')),
		`while the pane really did arm Scale (${armed.join(', ') || 'nothing pressed'})`
	);
	// start from a mode 1 WOULD change, or the check passes without doing anything
	await A.page.evaluate(() => window.__stores.transformMode.set('rotate'));
	await A.page.keyboard.press('1');
	await A.page.waitForTimeout(200);
	const modeAfter1 = await gizmoMode();
	h.check(modeAfter1 === 'rotate', `and 1 does not either (still ${modeAfter1})`);

	// with the pane NOT holding focus the digits belong to the gizmo again — the
	// claim is scoped to the pane, it does not disable the shortcut
	await A.page.evaluate(() => /** @type {any} */ (document.activeElement)?.blur());
	await A.page.mouse.click(400, 300); // the viewport, well clear of the dock
	await A.page.waitForTimeout(200);
	await A.page.evaluate(() => window.__stores.transformMode.set('translate'));
	await A.page.keyboard.press('3');
	await A.page.waitForTimeout(200);
	const outside = await gizmoMode();
	h.check(outside === 'scale', `outside the pane the digits still reach the gizmo (3 -> ${outside})`);

	await h.finish(browser);
});
