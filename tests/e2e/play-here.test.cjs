// 60 Q1: PLAY HERE (desktop + phone). The player starts where the editor camera is — the feet on the
// surface straight under it, facing the view's heading — and leaving Play puts the editor view and the
// selection back. Nothing under the camera → the scene's spawn; no spawn either → the camera's own eye.
// The override is a ONE-ROUND thing: the next ordinary Play lands on the scene's spawn again.
// HEIGHT: desktop Play is GROUNDED by default (37 R24 — PointerLockControls pins the eye at the
// scene's eye height), so the surface height counts where the scene lets the player fly (or a walk
// controller owns Y); a grounded scene keeps X/Z + facing and its own eye height. Both are covered.
// Entry points covered: Ctrl+Shift+Enter, the Play button's right-click row, the optional toolbar
// button, and on a phone the Play long-press row + More ▸ Play here.
// IWER (the headset) lives in play-here-iwer.test.cjs.
const h = require('./helpers.cjs');

const store = (name) => `(() => { let v; window.__stores.${name}.subscribe((x) => (v = x))(); return v; })()`;
const near = (a, b, eps = 0.06) => Math.abs(a - b) < eps;
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const SPAWN = { position: [3, 0, -4], yaw: Math.PI / 2 };
/** the toolbar with the optional Play here button placed at the end of the bar */
const BAR = JSON.stringify({
	order: ['move', 'rotate', 'scale', 'pivot', 'mode', 'objects', 'flow', 'explorer', 'animation', 'playhere'],
	hidden: [],
	spacerIndex: 5,
	seen: ['move', 'rotate', 'scale', 'pivot', 'mode', 'objects', 'flow', 'explorer', 'animation', 'playhere', 'ai', 'add', 'chat', 'mic', 'notes', 'notifications', 'peers', 'undo', 'redo', 'multiselect']
});

/** the play camera's world eye + heading, the editor camera's pose + orbit target */
const cams = (page) =>
	page.evaluate(() => {
		const s = window.__stores;
		const THREE = s.THREE;
		const get = (st) => { let v; st.subscribe((x) => (v = x))(); return v; };
		const pc = get(s.playerCam);
		const ec = get(s.editorCam);
		const oc = get(s.orbitControls);
		const f = new THREE.Vector3(0, 0, -1).applyQuaternion(pc.getWorldQuaternion(new THREE.Quaternion()));
		return {
			player: pc.getWorldPosition(new THREE.Vector3()).toArray(),
			playerYaw: Math.atan2(-f.x, -f.z),
			editor: ec.position.toArray(),
			editorQ: ec.quaternion.toArray(),
			target: oc?.target?.toArray() ?? null,
			locked: get(s.isLocked)
		};
	});

/** park the editor camera at `pos` looking at `target` (the OrbitControls own the view, so through them) */
const aim = (page, pos, target) =>
	page.evaluate(
		({ pos, target }) => {
			const s = window.__stores;
			const get = (st) => { let v; st.subscribe((x) => (v = x))(); return v; };
			const cam = get(s.editorCam);
			const oc = get(s.orbitControls);
			oc.target.set(...target);
			cam.position.set(...pos);
			cam.lookAt(...target);
			oc.update();
			cam.updateMatrixWorld(true);
		},
		{ pos, target }
	);

const waitLocked = async (page, want) => {
	for (let i = 0; i < 40; i++) {
		if ((await page.evaluate(store('isLocked'))) === want) return true;
		await page.waitForTimeout(100);
	}
	return false;
};

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A', { context: { viewport: { width: 1440, height: 900 } }, storage: { controlsLayout: BAR } });
	const P = A.page;

	// ---- the world: a wide box far from the origin (top at y = 5), the scene's spawn elsewhere ----
	await P.evaluate(() => window.__stores.commandsHandler.sceneCommand('/create box'));
	await P.waitForTimeout(500);
	const box = await P.evaluate(() => {
		const s = window.__stores;
		let g;
		s.objectsGroup.subscribe((x) => (g = x))();
		const b = g.children.at(-1);
		b.scale.set(10, 5, 10);
		b.position.set(40, 0, -35);
		b.updateMatrixWorld(true);
		const bb = new s.THREE.Box3().setFromObject(b);
		b.position.y -= bb.min.y; // sit it on the ground: its top is then its height
		b.updateMatrixWorld(true);
		const top = new s.THREE.Box3().setFromObject(b).max.y;
		s.objectActions.applySelectionSet([b.uuid]);
		return { uuid: b.uuid, top };
	});
	h.check(box.top > 4, `premise: a box with its top at ${box.top.toFixed(2)} m, far from the origin`);
	// flying allowed: the spawn's height is honoured (the grounded case is row 1b)
	await P.evaluate((spawn) => window.__stores.scenePhysics.setScenePhysics({ play: { spawn, locomotion: { fly: true } } }), SPAWN);

	// ---- 1. Ctrl+Shift+Enter from a far corner: on the box roof, facing the view ------------------
	const EYE_AT = [40, 14, -32];
	await aim(P, EYE_AT, [30, 0, -42]);
	const before = await cams(P);
	const resolved = await P.evaluate(() => window.__stores.playHere.resolvePlayHere());
	h.check(resolved?.source === 'surface' && near(resolved.position[1], box.top), `the resolver lands on the roof (${JSON.stringify(resolved)})`);
	await P.mouse.move(700, 450);
	await P.keyboard.press('Control+Shift+Enter');
	h.check(await waitLocked(P, true), 'Ctrl+Shift+Enter enters Play');
	await P.waitForTimeout(400);
	let c = await cams(P);
	h.check(near(c.player[0], 40) && near(c.player[2], -32), `the player stands under the camera, not on the spawn (${c.player.map((v) => v.toFixed(2))})`);
	h.check(near(c.player[1], box.top + 1.7), `the eye is 1.7 m above the roof (${c.player[1].toFixed(2)} vs ${(box.top + 1.7).toFixed(2)})`);
	h.check(near(wrap(c.playerYaw - Math.PI / 4), 0, 0.03), `facing the view's heading (${c.playerYaw.toFixed(3)} vs ${(Math.PI / 4).toFixed(3)})`);
	h.check((await P.evaluate(store('playHere.playingHere'))) === true, 'playingHere is on while the round runs');

	// Stop: the view and the selection come back
	h.check(await h.leavePlay(A), 'Escape leaves Play');
	await P.waitForTimeout(300);
	c = await cams(P);
	h.check(c.editor.every((v, i) => near(v, before.editor[i], 0.01)), `the editor camera is back where it was (${c.editor.map((v) => v.toFixed(2))})`);
	h.check(c.target && c.target.every((v, i) => near(v, before.target[i], 0.01)), `...looking at the same orbit target (${JSON.stringify(c.target)})`);
	h.check(c.editorQ.every((v, i) => near(v, before.editorQ[i], 0.01)), '...with the same orientation');
	const sel = await P.evaluate(store('selectedObjects'));
	h.check(sel.map((o) => o?.uuid ?? o).includes(box.uuid), `the selection is back (${JSON.stringify(sel.map((o) => o?.uuid ?? o))})`);
	const dbg = await P.evaluate(() => window.__stores.playHere.playHereDebug());
	h.check(dbg.override === null && dbg.playing === false, `the override is gone with the round (${JSON.stringify({ o: dbg.override, p: dbg.playing })})`);

	// ---- 1b. a GROUNDED scene (the default): X/Z and facing from the camera, the scene's eye height --
	await P.evaluate(() => window.__stores.scenePhysics.setScenePhysics({ play: { locomotion: { fly: false } } }));
	await P.keyboard.press('Control+Shift+Enter');
	h.check(await waitLocked(P, true), 'grounded: Play here');
	await P.waitForTimeout(400);
	c = await cams(P);
	h.check(near(c.player[0], 40) && near(c.player[2], -32) && near(c.player[1], 1.7), `grounded: under the camera at the scene's eye height (${c.player.map((v) => v.toFixed(2))})`);
	h.check(near(wrap(c.playerYaw - Math.PI / 4), 0, 0.03), `grounded: facing the view (${c.playerYaw.toFixed(3)})`);
	await h.leavePlay(A);
	await P.evaluate(() => window.__stores.scenePhysics.setScenePhysics({ play: { locomotion: { fly: true } } }));

	// ---- 2. the next ORDINARY Play lands on the scene's spawn (the override does not leak) --------
	await P.keyboard.press('Control+Enter');
	h.check(await waitLocked(P, true), 'Ctrl+Enter: an ordinary Play');
	await P.waitForTimeout(400);
	c = await cams(P);
	h.check(near(c.player[0], 3) && near(c.player[2], -4) && near(c.player[1], 1.7), `an ordinary Play spawns on the scene's spawn (${c.player.map((v) => v.toFixed(2))})`);
	await h.leavePlay(A);

	// ---- 3. the Play button's right-click row; nothing under the camera → the scene's spawn ---------
	await aim(P, [0, -6, 20], [0, -6, 0]); // under the ground plane: nothing below
	await P.click('#play-button', { button: 'right' });
	await P.waitForTimeout(300);
	const rows = await P.evaluate(() => [...document.querySelectorAll('[role="menuitem"]')].map((el) => el.textContent.trim()));
	h.check(rows.includes('Play here'), `Play's own menu carries "Play here" (${JSON.stringify(rows)})`);
	await P.getByRole('menuitem', { name: 'Play here' }).click();
	h.check(await waitLocked(P, true), 'the menu row enters Play');
	await P.waitForTimeout(400);
	c = await cams(P);
	const last = (await P.evaluate(() => window.__stores.playHere.playHereDebug())).last;
	h.check(last?.source === 'spawn', `nothing under the camera: the scene's spawn (${JSON.stringify(last)})`);
	h.check(near(c.player[0], 3) && near(c.player[2], -4), `...the player is on it (${c.player.map((v) => v.toFixed(2))})`);
	h.check(near(wrap(c.playerYaw - SPAWN.yaw), 0, 0.03), `...facing the spawn's own yaw (${c.playerYaw.toFixed(3)})`);
	await h.leavePlay(A);

	// ---- 4. the toolbar button; no ground, no spawn → the camera's own eye ------------------------
	await P.evaluate(() => window.__stores.scenePhysics.setScenePhysics({ ground: { enabled: false }, play: { spawn: null } }));
	await aim(P, [70, 9, 70], [60, 9, 60]);
	h.check(await P.locator('#play-here-button').isVisible(), 'the optional toolbar button is on the bar when placed');
	await P.click('#play-here-button');
	h.check(await waitLocked(P, true), 'the toolbar button enters Play');
	await P.waitForTimeout(400);
	c = await cams(P);
	h.check(near(c.player[0], 70) && near(c.player[1], 9) && near(c.player[2], 70), `no surface, no spawn: the eye stays at the camera (${c.player.map((v) => v.toFixed(2))})`);
	h.check(near(wrap(c.playerYaw - Math.PI / 4), 0, 0.03), `...facing the view (${c.playerYaw.toFixed(3)})`);
	await h.leavePlay(A);
	await P.evaluate(() => window.__stores.scenePhysics.setScenePhysics({ ground: { enabled: true } }));
	await A.page.context().close();

	// ---- 5. a phone (N6 folded): Play's long-press row and More ▸ Play here ------------------------
	const FOLDED = { width: 390, height: 896 };
	const B = await h.setupPage(browser, 'phone', {
		context: { viewport: FOLDED, hasTouch: true, isMobile: true, deviceScaleFactor: 2.9 },
		storage: { toursSeen: '{"editor-touch":true,"editor":true}' }
	});
	const Q = B.page;
	await Q.evaluate(() => window.__stores.commandsHandler.sceneCommand('/create box'));
	await Q.waitForTimeout(500);
	await Q.evaluate(() => {
		const s = window.__stores;
		let g;
		s.objectsGroup.subscribe((x) => (g = x))();
		const b = g.children.at(-1);
		b.scale.set(6, 2, 6);
		b.position.set(-20, 1, 15);
		b.updateMatrixWorld(true);
	});
	const top = await Q.evaluate(() => {
		const s = window.__stores;
		let g;
		s.objectsGroup.subscribe((x) => (g = x))();
		return new s.THREE.Box3().setFromObject(g.children.at(-1)).max.y;
	});
	await aim(Q, [-20, 10, 15], [-20, 0, 5]);
	const phoneBefore = await cams(Q);
	// long press on Play = its contextmenu
	await Q.locator('#ps-bar [data-bar-item="play"]').dispatchEvent('contextmenu', { clientX: 195, clientY: 860 });
	await Q.waitForTimeout(300);
	const phoneRows = await Q.evaluate(() => [...document.querySelectorAll('[role="menuitem"]')].map((el) => el.textContent.trim()));
	h.check(phoneRows.includes('Play here'), `the phone Play menu carries "Play here" (${JSON.stringify(phoneRows)})`);
	await Q.getByRole('menuitem', { name: 'Play here' }).click();
	h.check(await waitLocked(Q, true), 'phone: the row enters Play');
	await Q.waitForTimeout(400);
	c = await cams(Q);
	// a phone scene is grounded by default: X/Z from the camera, the eye at the scene's height
	h.check(near(c.player[0], -20) && near(c.player[2], 15) && near(c.player[1], 1.7), `phone: under the camera, grounded (${c.player.map((v) => v.toFixed(2))}, box top ${top.toFixed(2)})`);
	h.check(near(wrap(c.playerYaw), 0, 0.03), `phone: facing the view (${c.playerYaw.toFixed(3)})`);
	// the touch ✕ is the phone's way out
	const exitBtn = Q.locator('#touch-play-exit, [data-touch-exit], button[aria-label="Exit play"]').first();
	if (await exitBtn.isVisible().catch(() => false)) await exitBtn.click();
	else await Q.evaluate(() => window.__stores.playMode.exitPlay());
	h.check(await waitLocked(Q, null), 'phone: Play ends');
	await Q.waitForTimeout(300);
	c = await cams(Q);
	h.check(c.editor.every((v, i) => near(v, phoneBefore.editor[i], 0.01)), `phone: the editor view is back (${c.editor.map((v) => v.toFixed(2))})`);

	// More ▸ Tools & View ▸ Play here
	await Q.locator('#ps-bar [data-bar-item="more"]').click();
	await Q.waitForTimeout(400);
	const tile = Q.locator('#ps-tile-playhere');
	h.check(await tile.isVisible().catch(() => false), 'phone: More lists Play here');
	await tile.click();
	h.check(await waitLocked(Q, true), 'phone: the More tile enters Play');
	await Q.waitForTimeout(300);
	c = await cams(Q);
	h.check(near(c.player[0], -20) && near(c.player[2], 15), `phone (More): under the camera again (${c.player.map((v) => v.toFixed(2))})`);
	await Q.evaluate(() => window.__stores.playMode.exitPlay());
	await waitLocked(Q, null);

	await h.finish(browser);
});
